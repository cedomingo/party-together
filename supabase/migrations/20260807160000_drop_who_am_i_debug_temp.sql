-- ---------------------------------------------------------------------------
-- Cleanup: drop the temporary "who-am-i guess mismatch" debug instrumentation
-- ---------------------------------------------------------------------------
-- Both functions were added mid-investigation (20260807140100_debug_whoami_
-- temp.sql, 20260807140200_debug_guess_attempt_temp.sql) to rule out an
-- RLS-evaluation / connection-pooling explanation for "guess wasn't saved."
-- That chase was a dead end: auth.uid(), current_player_id_in_room(), and
-- the update/RLS path all evaluate exactly as intended. The real cause was
-- mundane — `who_am_i_assignments` rows are only created for players who
-- were `connected = true` at the instant the host clicked Start
-- (app/api/games/who-am-i/start/route.ts); a player who joined afterward,
-- or whose `connected` flag happened to be false right at that moment (e.g.
-- a backgrounded tab — see supabase/RECONNECT_VERIFICATION.md), never gets
-- an assignment row for that round. That's a product-level "you weren't
-- part of this round" case, not a data-integrity or RLS bug — see the
-- updated error handling in app/api/games/who-am-i/guess/route.ts.
--
-- Neither function is referenced by any app code path (debug_whoami() was
-- never actually called from the route; debug_guess_attempt() was called
-- only from the now-removed diagnostic block in guess/route.ts), so both
-- are safe to drop outright.

drop function if exists public.debug_guess_attempt(uuid, uuid);
drop function if exists public.debug_whoami();
