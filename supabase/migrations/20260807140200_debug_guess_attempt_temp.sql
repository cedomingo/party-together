-- ---------------------------------------------------------------------------
-- TEMPORARY debug instrumentation, round 2 - remove alongside
-- debug_whoami() once the who_am_i guess-mismatch bug is root-caused.
-- ---------------------------------------------------------------------------
-- Every previous check (auth.uid(), current_player_id_in_room(), the row's
-- existence) came back exactly as expected - but each of those ran as its
-- OWN separate HTTP request, meaning its own separate connection through
-- Supabase's pooler. If there's anything connection/session-specific going
-- on (a stale cached plan for the STABLE current_player_id_in_room(), a
-- pooler role/session var not resetting between requests, etc.), checking
-- identity in one request and then doing the real UPDATE in a *different*
-- request could hide exactly that.
--
-- This function does the identity resolution, an existence check, and the
-- real update all inside ONE statement/transaction/connection, running
-- with the CALLER's own privileges (security invoker - NOT definer), so
-- RLS applies exactly the way it does for the real guess route. If this
-- still reports rows_updated = 0 while row_exists_before = true and
-- resolved_player_id is correct, that's airtight proof the UPDATE/RLS
-- evaluation itself is the problem, with every pooling/cross-request
-- explanation eliminated.

create or replace function public.debug_guess_attempt(
  p_session_id uuid,
  p_character_id uuid
)
returns table (
  auth_uid uuid,
  resolved_room_id uuid,
  resolved_player_id uuid,
  row_exists_before boolean,
  rows_updated int
)
language plpgsql
security invoker
as $$
declare
  v_room_id uuid;
  v_player_id uuid;
  v_exists boolean;
  v_count int;
begin
  select room_id into v_room_id
  from public.game_sessions
  where id = p_session_id;

  v_player_id := public.current_player_id_in_room(v_room_id);

  select exists (
    select 1 from public.who_am_i_assignments
    where session_id = p_session_id and player_id = v_player_id
  ) into v_exists;

  update public.who_am_i_assignments
    set guessed_character_id = p_character_id
    where session_id = p_session_id and player_id = v_player_id;
  get diagnostics v_count = row_count;

  return query select auth.uid(), v_room_id, v_player_id, v_exists, v_count;
end;
$$;

grant execute on function public.debug_guess_attempt(uuid, uuid) to authenticated;

comment on function public.debug_guess_attempt(uuid, uuid) is
  'TEMPORARY - remove after the who_am_i guess RLS-mismatch bug is found. '
  'Same identity resolution + update the real guess route performs, but '
  'all in one atomic statement/connection, to rule out cross-request '
  'pooling effects as an explanation.';
