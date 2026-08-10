-- ---------------------------------------------------------------------------
-- "Who Are You?" Step 1: setup/picking phase (WHO-ARE-YOU-SPEC.md §3, §7)
-- ---------------------------------------------------------------------------
-- Purely additive — no changes to rooms/players/game_sessions/characters or
-- any existing "Who Am I?" table/policy (WHO-ARE-YOU-SPEC.md §0, SPEC.md
-- §3(B)/§12.8). `characters` is reused as-is (WHO-ARE-YOU-SPEC.md §2).

-- ===================================================== who_are_you_selections
-- Each player's own locked-in pick. Secrecy direction is the OPPOSITE of
-- who_am_i_assignments (WHO-ARE-YOU-SPEC.md §3 "Secrecy direction"): the
-- owner must always be able to read their own row in full (they always know
-- what they picked), and no other player may ever read character_id for a
-- row that isn't theirs.
--
-- Unlike who_am_i_assignments, this does NOT need column-level masking or a
-- security-definer view: who_am_i's problem was "the SAME row must be
-- readable by its owner but with one column hidden, while being fully
-- readable (character_id included) by every OTHER player" — that's what
-- forced a view. Here nobody but the owner ever needs to read this row AT
-- ALL (the "other players see a masked version of your pick" need is
-- who_are_you_boards, deferred to Step 2 — that's a derived per-viewer
-- cross-off/guess table, not a read path onto this one). So a plain
-- ownership RLS policy that hides the whole row from everyone else is
-- sufficient and strictly simpler.
create table public.who_are_you_selections (
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  character_id uuid not null references public.characters(id),
  picked_at timestamptz not null default now(),
  primary key (session_id, player_id)
);

create index who_are_you_selections_session_id_idx on public.who_are_you_selections (session_id);

alter table public.who_are_you_selections enable row level security;

-- Owner-only read. No SELECT policy/grant exposes any OTHER player's row at
-- all — a query for someone else's row returns zero rows, not a masked/null
-- version of it. Same "no query could ever leak it" property
-- who_am_i_assignments has, just achieved at the row level instead of the
-- column level since there's no legitimate reader of this row but its owner.
create policy who_are_you_selections_select_own_row
  on public.who_are_you_selections for select
  to authenticated
  using (
    player_id = public.current_player_id_in_room(
      (select room_id from public.game_sessions gs where gs.id = session_id)
    )
  );

-- Player-initiated, self-only insert (WHO-ARE-YOU-SPEC.md §3 point 5: "the
-- actual per-player pick write is a player-initiated action against
-- who_are_you_selections, not something assigned by the host/server" —
-- unlike who_am_i_assignments, there is no trusted-server insert path here
-- at all). The primary key (session_id, player_id) is what makes a pick
-- "locked" once made (§3 point 3, "no changing your mind after Done") — a
-- second insert attempt for the same player just fails as a duplicate-key
-- conflict, which the client surfaces as "you've already picked." There is
-- deliberately no UPDATE or DELETE policy on this table at all: no path,
-- RLS or otherwise, exists to change a pick once it's in.
--
-- Also requires the session to still be in the "setup" phase (state->>
-- 'phase'), so a pick can't be inserted once Step 2's turn loop has started
-- (`game_sessions.state` only ever has phase "setup" as of this migration —
-- this check is forward-looking for when Step 2 adds "turns").
create policy who_are_you_selections_insert_self
  on public.who_are_you_selections for insert
  to authenticated
  with check (
    player_id = public.current_player_id_in_room(
      (select room_id from public.game_sessions gs where gs.id = session_id)
    )
    and exists (
      select 1 from public.game_sessions gs
      where gs.id = session_id
        and gs.game_id = 'who-are-you'
        and gs.state ->> 'phase' = 'setup'
    )
  );

-- ========================================================= who_are_you_ready
-- The waiting screen (WHO-ARE-YOU-SPEC.md §3 point 4, "shows who's picked /
-- still picking") needs SOME cross-player signal, but who_are_you_selections
-- above is deliberately owner-only-readable, full stop — not just for
-- character_id, the whole row. Rather than relax that table's RLS (which
-- would mean reasoning about exactly which columns are "safe" to expose),
-- this is a separate, narrow table that records ONLY that a pick happened:
-- no character_id column exists here at all, so there is nothing about
-- *which* character was picked for this table to ever leak, by
-- construction, not just by policy.
create table public.who_are_you_ready (
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  ready_at timestamptz not null default now(),
  primary key (session_id, player_id)
);

create index who_are_you_ready_session_id_idx on public.who_are_you_ready (session_id);

alter table public.who_are_you_ready enable row level security;

-- Every room member can see WHO has picked (not what) — this is exactly the
-- waiting-screen list.
create policy who_are_you_ready_select_room_members
  on public.who_are_you_ready for select
  to authenticated
  using (
    exists (
      select 1 from public.game_sessions gs
      where gs.id = session_id and public.is_room_member(gs.room_id)
    )
  );

create policy who_are_you_ready_insert_self
  on public.who_are_you_ready for insert
  to authenticated
  with check (
    player_id = public.current_player_id_in_room(
      (select room_id from public.game_sessions gs where gs.id = session_id)
    )
  );

-- No update/delete policy here either — same "locked once done" rule as
-- who_are_you_selections above.

-- The client writes to both tables when a player presses "Done" (see
-- games/who-are-you/components/RoomView.tsx) — this row is NOT written
-- automatically by a trigger off who_are_you_selections, so that a failed/
-- partial write on one table can't silently desync from the other without
-- at least being visible as "picked a character but never showed as ready"
-- (recoverable by retrying the Done action, since the selections insert
-- itself is idempotent-safe via the primary key conflict check).

-- Realtime: only who_are_you_ready is published. who_are_you_selections is
-- deliberately NOT added to supabase_realtime — Postgres logical
-- replication publishes rows regardless of a specific subscriber's RLS
-- visibility being computed per-row by Realtime's own authorization pass,
-- and the smaller/narrower the set of tables carrying this session's data
-- over that path, the smaller the surface for a future mistake to widen
-- visibility. who_are_you_ready has nothing secret in it, so it's the only
-- one that needs to be live.
alter publication supabase_realtime add table public.who_are_you_ready;
