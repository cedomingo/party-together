-- ---------------------------------------------------------------------------
-- Phase 2: enable Supabase Realtime (Postgres changes) on room/player tables
-- ---------------------------------------------------------------------------
-- The lobby needs to reflect join/leave/connect/disconnect and host-start
-- events live (SPEC.md §7, §9: "Postgres changes subscription on
-- rooms/players for lobby presence and room state"). Tables aren't
-- broadcast over Realtime until they're added to the `supabase_realtime`
-- publication - RLS still applies on top of this, a client only receives
-- change events for rows it's allowed to SELECT.
--
-- Presence and Broadcast (also §9) are client-side channel features and
-- don't need a publication entry.

alter publication supabase_realtime add table public.rooms;
alter publication supabase_realtime add table public.players;
