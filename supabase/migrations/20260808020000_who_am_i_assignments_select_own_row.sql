-- ---------------------------------------------------------------------------
-- Fix: guess UPDATE matches 0 rows even for the legitimate owner of the row
-- ---------------------------------------------------------------------------
-- Root cause (reproduced against a clean Postgres 16 instance, same policy/
-- grant shape as this table, before proposing this fix):
--
--   who_am_i_assignments has RLS enabled with exactly ONE policy -
--   who_am_i_assignments_update_own_row (UPDATE only), from
--   20260806120500_who_am_i_identity_protection.sql. There has never been a
--   SELECT policy on this table (by design - see that migration's header:
--   "No SELECT grant on the base table at all", to force all reads through
--   the who_am_i_board masking view).
--
--   That's fine for direct SELECTs (nothing should ever run one against the
--   base table). It is NOT fine for the guess UPDATE in
--   app/api/games/who-am-i/guess/route.ts, which does:
--
--     .from("who_am_i_assignments")
--     .update({ guessed_character_id: characterId })
--     .eq("session_id", sessionId)
--     .eq("player_id", callerPlayerId)
--     .select("session_id, player_id")
--
--   Both the WHERE-clause columns (session_id, player_id) and the RETURNING
--   columns requested by .select() are columns the UPDATE reads rather than
--   writes. Per Postgres RLS semantics, reading any column of a row you're
--   updating/returning -- even one just used in a WHERE filter -- requires
--   that row to be visible under a SELECT (or ALL) policy, IN ADDITION TO
--   satisfying the UPDATE policy's own USING clause. With zero SELECT
--   policies on this table, Postgres's default-deny applies: the row is
--   invisible for that purpose, so the scan never even reaches the point of
--   checking who_am_i_assignments_update_own_row's USING clause. The UPDATE
--   matches 0 rows, silently, no error -- for every caller, including the
--   row's genuine owner.
--
--   Confirmed via a minimal reproduction: a table with only an UPDATE
--   policy (USING (player_id = <owner>)) plus a column-level SELECT GRANT
--   on the WHERE-clause columns (mirroring
--   20260807090000_who_am_i_assignments_filter_grant.sql) still produces
--   "UPDATE 0" for the legitimate owner. Adding a SELECT policy with the
--   identical USING condition as the UPDATE policy immediately fixes it
--   ("UPDATE 1", RETURNING populated). This is independent of auth.uid() /
--   current_player_id_in_room() -- both already evaluate correctly (the
--   preceding players/game_sessions reads in loadSessionForTurn() wouldn't
--   succeed otherwise) -- so this is a genuinely different cause from the
--   two logged in WHO_AM_I_GUESS_ASSIGNMENT_BUG_NOTES.md.
--
-- Fix: add a SELECT policy with the SAME ownership condition as the
-- existing UPDATE policy. This does not weaken the identity-masking
-- design: the column-level GRANT (20260807090000) still only exposes
-- (session_id, player_id) -- character_id, crossed_off_character_ids,
-- guessed_character_id, and is_guessed remain ungranted on the base table,
-- so who_am_i_board stays the only way to read actual game data. This
-- policy only makes the two already-grantable identifier columns visible,
-- and only for the caller's own row.

create policy who_am_i_assignments_select_own_row
  on public.who_am_i_assignments for select
  to authenticated
  using (
    player_id = public.current_player_id_in_room(
      (select room_id from public.game_sessions gs where gs.id = session_id)
    )
  );
