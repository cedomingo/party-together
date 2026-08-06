-- ---------------------------------------------------------------------------
-- Phase 1: RLS helper functions
-- ---------------------------------------------------------------------------
-- These are SECURITY DEFINER on purpose: they query `players` directly.
-- If they were SECURITY INVOKER (the default) and `players` itself has a
-- policy that calls one of these functions, you get the query planner
-- evaluating players' own RLS while checking players' own RLS — recursive
-- and fragile. Running as the (table-owning) definer sidesteps that, since
-- the table owner is exempt from its own RLS policies by default (we never
-- set FORCE ROW LEVEL SECURITY, so this holds). `search_path` is pinned to
-- avoid search_path hijacking in a SECURITY DEFINER function.

create or replace function public.is_room_member(target_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.players
    where room_id = target_room_id
      and auth_id = auth.uid()
  );
$$;

create or replace function public.is_room_host(target_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.players
    where room_id = target_room_id
      and auth_id = auth.uid()
      and is_host = true
  );
$$;

-- Resolves the caller's own player row within a given room. Null if the
-- calling auth session has no player row there.
create or replace function public.current_player_id_in_room(target_room_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.players
  where room_id = target_room_id
    and auth_id = auth.uid()
  limit 1;
$$;

revoke execute on function public.is_room_member(uuid) from public;
revoke execute on function public.is_room_host(uuid) from public;
revoke execute on function public.current_player_id_in_room(uuid) from public;

grant execute on function public.is_room_member(uuid) to anon, authenticated;
grant execute on function public.is_room_host(uuid) to anon, authenticated;
grant execute on function public.current_player_id_in_room(uuid) to anon, authenticated;
