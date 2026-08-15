-- ---------------------------------------------------------------------------
-- "Who Are You?" Step 2: per-opponent boards (WHO-ARE-YOU-SPEC.md §4, §7)
-- ---------------------------------------------------------------------------
-- Purely additive — no changes to rooms/players/game_sessions/characters,
-- who_are_you_selections/ready, or any "Who Am I?" table/policy.
--
-- One row per DIRECTED (viewer, target) pair: the viewer's private cross-off
-- list and guess progress *about* that target. Not shared with the target
-- or anyone else (WHO-ARE-YOU-SPEC.md §4, §7).
--
-- `is_solved` is a plain boolean (NOT a generated column). The spec's draft
-- sketched `is_guessed` as generated, then noted that a cross-table lookup
-- against who_are_you_selections can't live in a generated expression —
-- correctness is resolved server-side by the guess route (same trusted-
-- comparison pattern as who-am-i/guess/route.ts), which writes is_solved
-- via the service-role client. Clients never get an UPDATE grant on
-- is_solved / guessed_character_id / solved_turn_number.

create table public.who_are_you_boards (
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  viewer_player_id uuid not null references public.players(id) on delete cascade,
  target_player_id uuid not null references public.players(id) on delete cascade,
  crossed_off_character_ids uuid[] not null default '{}',
  guessed_character_id uuid references public.characters(id),
  is_solved boolean not null default false,
  -- 1-based turn number within the session when this pairing was solved
  -- (null while unsolved). Used by the recap (WHO-ARE-YOU-SPEC.md §9).
  solved_turn_number integer,
  primary key (session_id, viewer_player_id, target_player_id),
  check (viewer_player_id <> target_player_id),
  check (solved_turn_number is null or solved_turn_number >= 1)
);

create index who_are_you_boards_session_viewer_idx
  on public.who_are_you_boards (session_id, viewer_player_id);

create index who_are_you_boards_session_target_idx
  on public.who_are_you_boards (session_id, target_player_id);

alter table public.who_are_you_boards enable row level security;

-- Viewer-only read — the whole row is private to the viewer. No SELECT
-- policy exposes another player's board at all (WHO-ARE-YOU-SPEC.md §7).
create policy who_are_you_boards_select_own
  on public.who_are_you_boards for select
  to authenticated
  using (
    viewer_player_id = public.current_player_id_in_room(
      (select room_id from public.game_sessions gs where gs.id = session_id)
    )
  );

-- Viewer-only update of cross-offs. Column-level grant below further
-- restricts which columns can change; is_solved / guessed_character_id /
-- solved_turn_number are deliberately ungranted so only the trusted guess
-- route (service role) can write them.
create policy who_are_you_boards_update_own
  on public.who_are_you_boards for update
  to authenticated
  using (
    viewer_player_id = public.current_player_id_in_room(
      (select room_id from public.game_sessions gs where gs.id = session_id)
    )
  )
  with check (
    viewer_player_id = public.current_player_id_in_room(
      (select room_id from public.game_sessions gs where gs.id = session_id)
    )
  );

-- No INSERT/DELETE policies for authenticated — board rows are created in
-- bulk by begin-turns/route.ts via the service-role client when the session
-- leaves setup, and never deleted mid-game (cascade on session delete).

revoke all on table public.who_are_you_boards from authenticated;
grant select on table public.who_are_you_boards to authenticated;
grant update (crossed_off_character_ids) on table public.who_are_you_boards to authenticated;

-- ---------------------------------------------------------------------------
-- Recap reveal: once the session has ended, every room member can read
-- every player's locked-in pick (WHO-ARE-YOU-SPEC.md §9). During an
-- in-progress game the underlying who_are_you_selections table stays
-- owner-only — this view simply returns zero rows until ended_at is set,
-- so there is no in-progress path that could leak another player's
-- character_id through it.
-- ---------------------------------------------------------------------------
create view public.who_are_you_recap
with (security_invoker = false) as
select
  s.session_id,
  s.player_id,
  s.character_id
from public.who_are_you_selections s
join public.game_sessions gs on gs.id = s.session_id
where gs.ended_at is not null
  and public.is_room_member(gs.room_id);

grant select on public.who_are_you_recap to authenticated;

comment on view public.who_are_you_recap is
  'Post-game reveal of who_are_you_selections.character_id for every player '
  'in the room. Returns no rows while the session is still in progress — '
  'the owner-only RLS on who_are_you_selections remains the only in-game '
  'read path for picks.';

-- Realtime: viewers need live updates if another tab of theirs flips a
-- cross-off, and the guess route's is_solved write should land without a
-- refresh. Only the viewer's own rows are ever delivered (RLS), so publishing
-- the table doesn't widen visibility the way publishing selections would.
alter publication supabase_realtime add table public.who_are_you_boards;
