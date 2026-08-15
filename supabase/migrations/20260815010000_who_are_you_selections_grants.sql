-- ---------------------------------------------------------------------------
-- Fix: GRANT missing table privileges for Who Are You setup tables
-- ---------------------------------------------------------------------------
-- 20260811000000_who_are_you_setup.sql created who_are_you_selections /
-- who_are_you_ready with RLS policies for `authenticated`, but never GRANTed
-- SELECT/INSERT on those tables. Postgres checks privileges before RLS, so
-- clients hit "permission denied for table who_are_you_selections" even when
-- the policies would allow the row.
--
-- (Supabase's default privileges sometimes cover this for dashboard-created
-- tables; migration-created tables are not reliably covered the same way.)

grant select, insert on table public.who_are_you_selections to authenticated;
grant select, insert on table public.who_are_you_ready to authenticated;
