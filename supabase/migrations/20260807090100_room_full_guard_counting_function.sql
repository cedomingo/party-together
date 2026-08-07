-- ---------------------------------------------------------------------------
-- Fix: room_full_guard's player-count subquery undercounts to zero for the
-- exact people it's supposed to gate (new, not-yet-member joiners).
-- ---------------------------------------------------------------------------
-- 20260806121000_room_full_guard.sql's WITH CHECK does:
--
--   (select count(*) from public.players p where p.room_id = r.id) < r.max_players
--
-- This is a plain subquery on `players`, inside a policy that is itself ON
-- `players`. Unlike is_room_member()/is_room_host() (SECURITY DEFINER, see
-- 20260806120300_helper_functions.sql), a bare subquery here runs with the
-- CALLER's privileges — so it's filtered by players_select_room_members
-- ("using (public.is_room_member(room_id))"). A brand-new joiner has no
-- player row in that room yet, so is_room_member() is false for every row,
-- the subquery always returns 0 rows, and `0 < max_players` is true
-- regardless of how full the room actually is. Net effect: any host-set
-- cap is silently unenforced for outside joiners (RLS-level; the
-- application-side check in lib/rooms/index.ts still works for the common
-- non-race case, since it runs as an ordinary authenticated SELECT that
-- doesn't fight is_room_member() the same way — it just isn't atomic under
-- a race, which is the whole reason this policy exists).
--
-- Fix: count through a SECURITY DEFINER function, same pattern as
-- is_room_member/is_room_host, so it sees every row in the room regardless
-- of the caller's own membership.

create or replace function public.room_player_count(target_room_id uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int from public.players where room_id = target_room_id;
$$;

revoke execute on function public.room_player_count(uuid) from public;
grant execute on function public.room_player_count(uuid) to anon, authenticated;

alter policy players_insert_self_join_lobby
  on public.players
  with check (
    auth_id = auth.uid()
    and exists (
      select 1 from public.rooms r
      where r.id = room_id
        and r.status = 'lobby'
        and (
          r.max_players is null
          or public.room_player_count(r.id) < r.max_players
        )
    )
  );

comment on policy players_insert_self_join_lobby on public.players is
  'Allows a session to insert its own player row while the room is still '
  'in lobby and (if the host set one) under the max_players cap, counted '
  'via room_player_count() so a non-member joiner is counted against the '
  'real room size instead of their own (always-empty) RLS-filtered view '
  'of it. Existing members reconnecting never re-run this policy — '
  'UPDATE, not INSERT, handles that path (players_update_self).';
