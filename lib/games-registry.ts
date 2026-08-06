// ---------------------------------------------------------------------------
// Central registry of pluggable game modules.
// ---------------------------------------------------------------------------
// This is the ONLY file the platform core is allowed to import game modules
// from. To add a new game later:
//   1. Create /games/<new-game>/config.ts exporting a GameConfig
//   2. Create /games/<new-game>/components/RoomView.tsx exporting a
//      component with the signature (props: GameRoomViewProps) => ReactNode
//   3. Import both below and add entries to `games` and `roomViews`
// No other change to /app or /lib/rooms should be required — this is what
// SPEC.md §3(B) and §12.8 ("confirm the whole platform can add a second
// game by only adding a folder + a registry entry") are proving.

import type { ComponentType } from "react";
import type { Player, Room } from "@/lib/rooms";

export interface GameConfig {
  /** Stable machine id, also used as the URL slug: /games/<id> */
  id: string;
  /** Human-readable name shown in the game picker and landing page <title> */
  displayName: string;
  /** Short marketing description for the SEO landing page + game picker card */
  description: string;
  minPlayers: number;
  maxPlayers: number;
  /** Path under /public to the thumbnail used in the game picker + OG image */
  thumbnailPath: string;
}

/**
 * Props handed to a game module's registered room-view component once a
 * room's status is "in_progress". Deliberately game-agnostic — a specific
 * game module is free to ignore fields it doesn't need yet (e.g. this
 * phase's placeholder only reads `gameConfig`).
 */
export interface GameRoomViewProps {
  gameConfig: GameConfig;
  room: Room;
  players: Player[];
  currentPlayer: Player;
}

type GameRoomView = ComponentType<GameRoomViewProps>;

// Phase 2 registered the metadata (GameConfig) only. Phase 3 adds the
// room-view component per game, resolved by id — this is the piece that
// lets RoomClient (platform core) hand off rendering for an in-progress
// game without ever importing /games/** itself.
import { whoAmIConfig } from "@/games/who-am-i/config";
import { WhoAmIRoomView } from "@/games/who-am-i/components/RoomView";

export const games: GameConfig[] = [whoAmIConfig];

const roomViews: Record<string, GameRoomView> = {
  [whoAmIConfig.id]: WhoAmIRoomView,
};

export function getGameConfig(id: string): GameConfig | undefined {
  return games.find((g) => g.id === id);
}

/** Resolves the registered in-room view component for a game id, if any. */
export function getGameRoomView(id: string): GameRoomView | undefined {
  return roomViews[id];
}
