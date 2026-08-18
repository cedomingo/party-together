-- ---------------------------------------------------------------------------
-- TEMPORARY debug instrumentation - remove once the who_am_i guess-mismatch
-- bug is root-caused. Not referenced by any app feature.
-- ---------------------------------------------------------------------------
-- Every static check we can run from the SQL editor (which runs as
-- `postgres` and bypasses RLS) confirms the assignment row exists, belongs
-- to the right player, for the right session. Yet the live UPDATE in
-- guess/route.ts still matches 0 rows under RLS. The only thing left
-- unverified is what `auth.uid()` actually resolves to *at the moment
-- Postgres evaluates the RLS policy* for that specific request - which may
-- not be the same identity `supabase.auth.getUser()` resolved earlier in
-- the same route handler, if a token refresh happens in between.
--
-- This function just echoes back auth.uid() (and a couple of session/role
-- details) so the app can log what Postgres actually saw, right at the
-- point of failure, instead of us inferring it from static queries that
-- bypass RLS entirely.

create or replace function public.debug_whoami()
returns table (
  auth_uid uuid,
  jwt_role text,
  jwt_sub text
)
language sql
stable
security invoker
as $$
  select
    auth.uid() as auth_uid,
    (auth.jwt() ->> 'role') as jwt_role,
    (auth.jwt() ->> 'sub') as jwt_sub;
$$;

grant execute on function public.debug_whoami() to anon, authenticated;

comment on function public.debug_whoami() is
  'TEMPORARY - remove after the who_am_i guess RLS-mismatch bug is found. '
  'Echoes auth.uid()/jwt role/sub as Postgres sees them for the calling '
  'request, for comparison against supabase.auth.getUser() resolved '
  'earlier in the same request.';
