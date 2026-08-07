alter policy players_select_room_members
  on public.players
  using (
    public.is_room_member(room_id)
    or auth_id = auth.uid()
  );

comment on policy players_select_room_members on public.players is
  'Room members can see all players in their room (is_room_member(), a '
  'self-referential SECURITY DEFINER lookup). The auth_id = auth.uid() '
  'fallback lets a session see its OWN just-inserted row when this policy '
  'is applied to an INSERT ... RETURNING output within the same statement '
  '-- is_room_member()''s subquery can''t see a row the current statement '
  'itself just created.';
