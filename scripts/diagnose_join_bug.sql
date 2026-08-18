-- ---------------------------------------------------------------------------
-- Run this in the Supabase Dashboard → SQL Editor (not psql via the pooler,
-- the dashboard editor is fine) on the live project. It doesn't change
-- anything - read-only - and its output is what actually decides between
-- "the join bug is a live-vs-repo drift" vs. "the bug is something else."
-- ---------------------------------------------------------------------------

-- 1) Every RLS policy actually in force on players/rooms right now, in a
--    form you can diff against supabase/migrations/*.sql by eye. If this
--    doesn't match 20260806121000_room_full_guard.sql's `with check` (the
--    max_players clause), that migration never made it to prod.
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
  and tablename in ('players', 'rooms', 'who_am_i_assignments')
order by tablename, cmd, policyname;

-- 2) Table-level grants for anon/authenticated. Confirms whether the
--    INSERT privilege on players (and the narrow SELECT this fix adds to
--    who_am_i_assignments) are actually present.
select
  table_name,
  grantee,
  privilege_type,
  is_grantable
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('players', 'rooms', 'who_am_i_assignments')
  and grantee in ('anon', 'authenticated')
order by table_name, grantee, privilege_type;

-- 3) Every migration Supabase thinks has actually been applied, newest
--    first. Compare the filenames here against the files in
--    supabase/migrations/ - anything present in the folder but missing
--    from this list hasn't been pushed (supabase db push) or run.
select version
from supabase_migrations.schema_migrations
order by version desc
limit 20;

-- 4) Rows for the specific room you're testing with - swap in the real
--    code. Confirms, from the DB's point of view (not the client's stale
--    read), that status really is 'lobby' and max_players is what you
--    expect at the moment the join fails.
-- select id, code, status, max_players, host_player_id, created_at
-- from public.rooms
-- where code = 'XXXX';
