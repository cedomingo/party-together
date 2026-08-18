-- ---------------------------------------------------------------------------
-- Run this in the Supabase Dashboard → SQL Editor on the LIVE project.
-- Read-only - it doesn't change anything. Purpose: settle, with evidence,
-- whether the f19b997b "no character assigned" repro is (a) live-vs-repo
-- drift on the RLS/function side, or (b) a genuinely-missing assignment
-- row (the "connected snapshot" class of bug already fixed in
-- app/api/games/who-am-i/start/route.ts and documented in
-- supabase/migrations/20260807160000_drop_who_am_i_debug_temp.sql).
-- ---------------------------------------------------------------------------

-- 1) Every RLS policy actually in force on the three tables this bug
--    touches, right now, live. Diff this by eye against
--    supabase/migrations/20260806120500_who_am_i_identity_protection.sql
--    and 20260806120400_rls_core.sql. In particular: exactly ONE update
--    policy on who_am_i_assignments, and its qual/with_check should
--    reference current_player_id_in_room - not current_player_id_for_session
--    or anything else not in the migrations folder.
select
  schemaname,
  tablename,
  policyname,
  cmd,
  roles,
  qual as using_expression,
  with_check as with_check_expression
from pg_policies
where schemaname = 'public'
  and tablename in ('who_am_i_assignments', 'game_sessions', 'players')
order by tablename, cmd, policyname;

-- 2) Every function named current_player_id* live right now. Should be
--    exactly current_player_id_in_room(uuid) - if current_player_id_for_
--    session or any other variant still exists here, the earlier "drop
--    function" never actually committed, or was re-created again since.
select
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as args,
  p.provolatile as volatility,          -- s = stable, expected here
  p.prosecdef as security_definer       -- should be true
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname like 'current_player_id%';

-- 3) Which migrations Supabase thinks are actually applied, newest first.
--    Compare filenames here against supabase/migrations/ - anything in
--    the folder but missing from this list was hand-patched via the SQL
--    editor (or never pushed) and is NOT tracked, which is exactly how
--    the original current_player_id_for_session drift happened.
select version
from supabase_migrations.schema_migrations
order by version desc
limit 25;

-- 4) The specific repro, from the DB's own point of view. Fill in the
--    real session_id (f19b997b...) and player_id before running.
--    row_exists tells you definitively whether this is a missing-row
--    case (start/route.ts snapshot bug - already fixed on current code,
--    but this room predates the fix) or a genuinely-present row that a
--    live policy is still wrongly excluding.
-- select
--   session_id,
--   player_id,
--   character_id is not null as row_exists,
--   (select room_id from public.game_sessions gs where gs.id = who_am_i_assignments.session_id) as room_id
-- from public.who_am_i_assignments
-- where session_id = '<session_id>'
--   and player_id = '<player_id>';

-- 5) Sanity check on the join used by the RLS policy's subquery: does
--    game_sessions actually have a row visible for this session_id under
--    the CURRENT role (run this as postgres/service role, which bypasses
--    RLS, so it just confirms the row exists - pair with #4 above, run as
--    the actual player via impersonation if you need the RLS-scoped view).
-- select id, room_id, game_id, ended_at
-- from public.game_sessions
-- where id = '<session_id>';
