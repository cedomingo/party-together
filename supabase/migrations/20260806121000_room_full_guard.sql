-- ---------------------------------------------------------------------------
-- Phase 10: room-full guard (SPEC.md §7 "host can optionally set [a max
-- player] cap"; §11 "clean ... error states for ... room-full").
-- ---------------------------------------------------------------------------
-- `rooms.max_players` has existed since Phase 1, but nothing enforced it —
-- a host could set a cap and it would be silently ignored. `lib/rooms.ts`'s
-- `joinRoomByCode` now checks it application-side for a friendly error
-- message, but that check-then-insert isn't atomic against a concurrent
-- join racing it (two people submitting the join form for the last open
-- seat at the same moment could both pass the count check before either
-- insert lands). RLS runs the `with check` for every row as part of the
-- same insert statement/transaction, so tightening it here is what actually
-- makes the cap hold under a race, not just in the common case.
--
-- Same policy that already gated inserts on room status
-- (`players_insert_self_join_lobby`, supabase/migrations/
-- 20260806120400_rls_core.sql) — this just adds the player-count condition
-- alongside the existing lobby-status one, rather than introducing a
-- second overlapping policy.
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
          or (select count(*) from public.players p where p.room_id = r.id) < r.max_players
        )
    )
  );

comment on policy players_insert_self_join_lobby on public.players is
  'Allows a session to insert its own player row while the room is still '
  'in lobby and (if the host set one) under the max_players cap. Existing '
  'members reconnecting never re-run this policy — UPDATE, not INSERT, '
  'handles that path (players_update_self) — so a room filling up after '
  'someone already joined never evicts them.';
