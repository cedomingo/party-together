-- ---------------------------------------------------------------------------
-- Drift fix: close the gap between live and repo found via
-- supabase_migrations.schema_migrations (live had a 21st applied version,
-- 20260808000000, with no corresponding file anywhere in this folder).
-- ---------------------------------------------------------------------------
-- Root cause this closes out: the live `who_am_i_assignments_update_own_row`
-- policy had been hand-patched directly against the database (SQL editor,
-- outside any tracked migration) to call a function named
-- `current_player_id_for_session(session_id uuid)` — a function that never
-- existed anywhere in this repo. It silently returned null for confirmed-
-- valid rows, so the policy's `player_id = null` comparison was never true,
-- so every guess UPDATE matched 0 rows with no error — surfacing as "you
-- don't have a character assigned for this round" for players who
-- genuinely did have one.
--
-- This was run live on 2026-08-08 to fix that: drop the phantom function
-- and the policy built on it, then recreate the policy exactly as
-- 20260806120500_who_am_i_identity_protection.sql already specifies
-- (current_player_id_in_room, the version-controlled helper from
-- 20260806120300_helper_functions.sql). It was never committed back to
-- this migrations folder until now — this file makes that live change
-- reproducible from a clean `supabase db push` instead of living only as
-- an untracked hand-edit.
--
-- Idempotent: every drop is guarded with IF EXISTS, and the recreated
-- policy is byte-for-byte identical to the one 20260806120500 already
-- defines, so running this against a database that never drifted (a fresh
-- environment built straight from this migrations folder) is a no-op.
--
-- Confirmed NOT the deeper cause of every "no character assigned" report
-- historically seen: 20260807140100/140200 (debug instrumentation) and
-- 20260807160000 (cleanup) already established that once this policy is
-- correct, current_player_id_in_room()/auth.uid()/the UPDATE-under-RLS
-- path evaluate exactly as intended. A separate, unrelated bug (players
-- dropped from the start-of-round roster by a stale `connected` filter —
-- see 20260807160000's comment and app/api/games/who-am-i/start/route.ts)
-- accounted for the missing-assignment-row cases seen after this policy
-- fix. Both are now fixed; this migration only concerns the RLS policy.

alter table public.who_am_i_assignments enable row level security;

drop policy if exists who_am_i_assignments_update_own_row on public.who_am_i_assignments;

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

drop function if exists public.current_player_id_for_session(uuid);
