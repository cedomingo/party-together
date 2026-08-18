-- ---------------------------------------------------------------------------
-- Phase 1: RLS - rooms, players, characters, game_sessions, questions_log
-- ---------------------------------------------------------------------------
-- (who_am_i_assignments is handled separately in the next migration - it
-- needs column-level grants and a masking view, not just row policies.)

-- ============================================================ rooms ======
alter table public.rooms enable row level security;

-- Rooms hold no secret data (no character info, nothing per-player), so
-- letting any signed-in (anonymous) session read a room by code is what
-- makes the join-by-code flow possible before you're a member of anything.
-- See "Open RLS edge cases" in the Phase 1 doc for the trade-off.
create policy rooms_select_any_authenticated
  on public.rooms for select
  to authenticated
  using (true);

-- host_player_id must be null at insert time - see bootstrap sequence in
-- the Phase 1 doc for why (players.id doesn't exist yet).
create policy rooms_insert_any_authenticated
  on public.rooms for insert
  to authenticated
  with check (host_player_id is null);

create policy rooms_update_host_only
  on public.rooms for update
  to authenticated
  using (public.is_room_host(id))
  with check (public.is_room_host(id));

-- No delete policy: rooms are never deleted by end users. Expiry cleanup
-- runs via the service-role admin client (lib/supabase/admin.ts), which
-- bypasses RLS entirely.

-- =========================================================== players ====
alter table public.players enable row level security;

create policy players_select_room_members
  on public.players for select
  to authenticated
  using (public.is_room_member(room_id));

-- Anyone can create their own player row in a room that's still in the
-- lobby (covers both "join an existing room" and "the host bootstrapping
-- their own player row right after creating the room").
create policy players_insert_self_join_lobby
  on public.players for insert
  to authenticated
  with check (
    auth_id = auth.uid()
    and exists (
      select 1 from public.rooms r
      where r.id = room_id and r.status = 'lobby'
    )
  );

-- Self-service updates only (nickname pre-game, connected flag on
-- disconnect/reconnect). Host-driven actions on *other* players (kick,
-- transfer host) are intentionally NOT covered by a policy yet - see
-- "Open RLS edge cases".
create policy players_update_self
  on public.players for update
  to authenticated
  using (auth_id = auth.uid())
  with check (auth_id = auth.uid());

create policy players_delete_self
  on public.players for delete
  to authenticated
  using (auth_id = auth.uid());

-- ======================================================== characters ====
alter table public.characters enable row level security;

-- Global, non-secret roster. Readable by anyone (even pre-session) so
-- landing/marketing pages can show it without requiring a room.
create policy characters_select_active
  on public.characters for select
  to anon, authenticated
  using (active = true);

-- No insert/update/delete policy: the roster is only ever written by the
-- seed script, which uses the service-role admin client.

-- ====================================================== game_sessions ====
alter table public.game_sessions enable row level security;

create policy game_sessions_select_room_members
  on public.game_sessions for select
  to authenticated
  using (public.is_room_member(room_id));

create policy game_sessions_insert_host_only
  on public.game_sessions for insert
  to authenticated
  with check (public.is_room_host(room_id));

-- Any room member can update session state (turn index, phase, etc. inside
-- `state` jsonb) since the active player - not just the host - drives turn
-- progression. See "Open RLS edge cases": this is coarser than ideal.
create policy game_sessions_update_room_members
  on public.game_sessions for update
  to authenticated
  using (public.is_room_member(room_id))
  with check (public.is_room_member(room_id));

-- ======================================================== questions_log ==
alter table public.questions_log enable row level security;

create policy questions_log_select_room_members
  on public.questions_log for select
  to authenticated
  using (
    exists (
      select 1 from public.game_sessions gs
      where gs.id = session_id and public.is_room_member(gs.room_id)
    )
  );

-- Only the asker can log their own question. This does NOT yet verify it's
-- actually their turn - see "Open RLS edge cases".
create policy questions_log_insert_asker_only
  on public.questions_log for insert
  to authenticated
  with check (
    exists (
      select 1 from public.game_sessions gs
      where gs.id = session_id
        and asking_player_id = public.current_player_id_in_room(gs.room_id)
    )
  );

-- Any room member can update `answers` / `resolved` - needed so responders
-- can write their yes/no into the shared jsonb. Same caveat as above: this
-- doesn't yet stop one member from clobbering another's answer.
create policy questions_log_update_room_members
  on public.questions_log for update
  to authenticated
  using (
    exists (
      select 1 from public.game_sessions gs
      where gs.id = session_id and public.is_room_member(gs.room_id)
    )
  )
  with check (
    exists (
      select 1 from public.game_sessions gs
      where gs.id = session_id and public.is_room_member(gs.room_id)
    )
  );
