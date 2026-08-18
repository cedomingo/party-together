-- ---------------------------------------------------------------------------
-- Phase 6b: reveal character_id for recap once the game has ended
-- (SPEC.md §8 point 7: "Show a results/recap screen (who guessed what, in
-- what order, full question log)."). Recap needs every player's real
-- character_id, including the viewer's own - that's exactly the one field
-- who_am_i_board has masked for everyone up to this point.
-- ---------------------------------------------------------------------------
-- This only changes the read path (the view). It does NOT touch:
--   - who_am_i_assignments' own RLS/grants (still no direct SELECT for
--     anon/authenticated, still no write path to character_id at all -
--     see supabase/migrations/..._who_am_i_identity_protection.sql).
--   - the masking behavior itself, which is still the correct behavior
--     for any *in-progress* session. Masking only lifts once
--     `game_sessions.ended_at` is set, which only ever happens via
--     `endGameSession` (app/api/games/who-am-i/_lib/turnSession.ts) -
--     i.e. either the system-detected "all players solved" condition or
--     a host manually ending the game. There's no client write path to
--     `ended_at` that bypasses those two routes' own authorization
--     checks: `game_sessions_update_room_members` lets any room member
--     write *some* column on game_sessions (see rls_core.sql's own "Open
--     RLS edge cases" note on that policy being coarser than ideal), but
--     that's a pre-existing, separately-flagged trade-off, not something
--     this migration introduces or widens.

create or replace view public.who_am_i_board
  with (security_invoker = false)
  as
  select
    a.session_id,
    a.player_id,
    case
      -- Once the session has ended, character_id is no longer secret for
      -- anyone - that's the whole point of the recap screen.
      when gs.ended_at is not null then a.character_id
      when a.player_id = public.current_player_id_in_room(gs.room_id) then null
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
  'calling player''s own row while the session is in progress, and '
  'revealed for every row (including the viewer''s own) once '
  'game_sessions.ended_at is set, for the recap screen (SPEC.md §8 point '
  '7). Do not grant SELECT on the base table - that would bypass this '
  'masking.';
