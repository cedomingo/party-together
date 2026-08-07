-- ---------------------------------------------------------------------------
-- Fix: "permission denied for table who_am_i_assignments" on guess submit
-- ---------------------------------------------------------------------------
-- Root cause (confirmed against 20260806120500_who_am_i_identity_protection.sql):
--   `revoke all on public.who_am_i_assignments from anon, authenticated;`
--   left NO select privilege on the base table at all — not even on
--   session_id/player_id. But the guess route does:
--
--     .from("who_am_i_assignments")
--     .update({ guessed_character_id: characterId })
--     .eq("session_id", sessionId)
--     .eq("player_id", callerPlayerId)
--
--   To evaluate that WHERE filter — and to evaluate the
--   who_am_i_assignments_update_own_row policy's USING/WITH CHECK, which
--   also reads player_id/session_id — Postgres needs SELECT privilege on
--   those two columns. With zero SELECT grant on the base table, every
--   UPDATE attempt fails with 42501 before the policy logic even runs.
--
-- This grants SELECT on exactly the two identifying columns needed to
-- filter/check. character_id, crossed_off_character_ids, guessed_
-- character_id, and is_guessed remain ungranted on the base table — the
-- who_am_i_board view (security_invoker = false) stays the only read path
-- for actual game data, so the identity-masking guarantee is untouched.

grant select (session_id, player_id)
  on public.who_am_i_assignments to authenticated;
