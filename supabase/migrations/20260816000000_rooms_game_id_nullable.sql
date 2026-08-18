-- ---------------------------------------------------------------------------
-- Rooms can be created as a game-less "shell" (room code + max players, no
-- game yet) and the game is chosen afterwards on the /games page
-- (app/games/page.tsx + app/api/rooms/switch-game/route.ts): creating a
-- room on the home page produces a code first, the host can share it, and
-- picking a game moves the room to that game's waiting room. A room may
-- therefore exist with game_id = null until the host picks a game.
--
-- Nothing references rooms.game_id via FK, and all per-game data hangs off
-- game_sessions.session_id (keyed to the room), so a null/updated game_id
-- never orphans anything. The join flow rejects game-less rooms with a
-- friendly error (lib/rooms joinRoomByCode) - there's no room URL to land
-- on until a game is picked - and the game start routes already refuse
-- anything that isn't their own game_id.
-- ---------------------------------------------------------------------------
alter table public.rooms
  alter column game_id drop not null;
