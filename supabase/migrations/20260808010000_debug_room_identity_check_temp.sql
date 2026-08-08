create or replace function public.debug_room_identity_check_temp(
  target_room_id uuid
)
returns table (
  auth_uid uuid,
  current_player_id uuid,
  matched_player_id uuid,
  matched_player_auth_id uuid
)
language sql
stable
security invoker
as $$
  select
    auth.uid() as auth_uid,
    public.current_player_id_in_room(target_room_id) as current_player_id,
    p.id as matched_player_id,
    p.auth_id as matched_player_auth_id
  from (select 1) as one
  left join public.players p
    on p.room_id = target_room_id
   and p.auth_id = auth.uid();
$$;