-- ---------------------------------------------------------------------------
-- Offline-player handling: players.last_seen_at (lobby sweep signal)
-- ---------------------------------------------------------------------------
-- `players.connected` flips to false the instant a tab is backgrounded
-- (pagehide beacon — see app/api/presence/route.ts), which makes it useless
-- on its own for telling "tab-switched for a second" from "closed the tab
-- for good": sweeping on it would boot players who merely locked their
-- phone. `last_seen_at` is the honest signal — room pages (RoomClient,
-- GamesListing) heartbeat it every 30s, and it only goes stale once the
-- page truly stops running (closed tab, dead network, background throttling
-- still lands inside the grace window). The sweep (lib/rooms
-- sweepStalePlayers) removes players whose last_seen_at is older than the
-- grace window so a stale seat never:
--   - blocks a game start (who-are-you waits on every player to pick;
--     who-am-i assigns a character — and a turn — to everyone in the room),
--   - counts toward the host's minPlayers gate, or
--   - eats a max_players slot that a real joiner could take.
-- The host is never swept (is_host rows are excluded by the sweep).

alter table public.players
  add column last_seen_at timestamptz not null default now();

comment on column public.players.last_seen_at is
  'Last time the player''s room page confirmed it was alive (30s heartbeat, '
  'see RoomClient/GamesListing). Updated only on the player''s own row via '
  'players_update_self; read by sweepStalePlayers (lib/rooms) to drop seats '
  'offline past the grace window so they can''t block a game start.';

-- The sweep scans by (room_id, last_seen_at) on every room load and game
-- start — keep it cheap.
create index players_last_seen_room_idx on public.players (room_id, last_seen_at);
