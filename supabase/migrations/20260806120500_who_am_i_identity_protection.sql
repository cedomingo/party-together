-- ---------------------------------------------------------------------------
-- Phase 1: the critical rule - a player can never read their own
-- character_id in who_am_i_assignments.
-- ---------------------------------------------------------------------------
-- Why this can't be a single row-level policy:
-- RLS filters whole ROWS, not columns. A player legitimately needs to read
-- back their OWN row's `crossed_off_character_ids` and `is_guessed` (e.g.
-- on page refresh), but must never read that same row's `character_id`.
-- A USING clause can't say "show this row but null out one column."
--
-- Solution used here:
--   1. No SELECT grant on the base table at all - direct queries against
--      `who_am_i_assignments` are rejected outright (401/403 via PostgREST),
--      not just filtered. This makes the masking view the *only* read path.
--   2. A view (`who_am_i_board`) that always returns every column except
--      character_id is nulled out via CASE when the row belongs to the
--      caller. The view is owned by the migration role (table owner), so
--      it bypasses the base table's RLS internally and does its own
--      filtering/masking explicitly - this is the standard Postgres/
--      Supabase pattern for column-level masking.
--   3. Column-level GRANT UPDATE restricted to (crossed_off_character_ids,
--      guessed_character_id) - a player can update their own elimination
--      board and submit a guess, but has no write path to character_id at
--      all, at the privilege level, not just via a check constraint.
--   4. No INSERT grant to authenticated/anon - character assignment at
--      game start is trusted server logic (service-role admin client),
--      deferred to a later phase. Phase 1 is schema-only, so that RPC
--      doesn't exist yet.

alter table public.who_am_i_assignments enable row level security;

-- Row-level policy still exists for defense in depth (and because column
-- grants alone don't stop a row from a different room being touched), but
-- since there's no SELECT grant to authenticated/anon, this only ever
-- matters for the UPDATE path below.
create policy who_am_i_assignments_update_own_row
  on public.who_am_i_assignments for update
  to authenticated
  using (
    player_id = public.current_player_id_in_room(
      (select room_id from public.game_sessions gs where gs.id = session_id)
    )
  )
  with check (
    player_id = public.current_player_id_in_room(
      (select room_id from public.game_sessions gs where gs.id = session_id)
    )
  );

-- Lock down the base table's privileges explicitly. (Belt-and-suspenders -
-- Supabase's default authenticated/anon roles don't have blanket table
-- access, but this makes the intent unambiguous and migration-order-proof.)
revoke all on public.who_am_i_assignments from anon, authenticated;
grant update (crossed_off_character_ids, guessed_character_id)
  on public.who_am_i_assignments to authenticated;

-- The masking view. security_invoker = false (the default, stated
-- explicitly here) is what makes it run with the view owner's privileges
-- against the base table, rather than the caller's.
create view public.who_am_i_board
  with (security_invoker = false)
  as
  select
    a.session_id,
    a.player_id,
    case
      when a.player_id = public.current_player_id_in_room(gs.room_id)
        then null
      else a.character_id
    end as character_id,
    a.crossed_off_character_ids,
    a.guessed_character_id,
    a.is_guessed
  from public.who_am_i_assignments a
  join public.game_sessions gs on gs.id = a.session_id
  where public.is_room_member(gs.room_id);

grant select on public.who_am_i_board to authenticated;

comment on view public.who_am_i_board is
  'Read path for who_am_i_assignments. character_id is nulled out for the '
  'calling player''s own row. Do not grant SELECT on the base table - that '
  'would bypass this masking.';
