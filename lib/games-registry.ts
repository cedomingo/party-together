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
import type { SupabaseClient } from "@supabase/supabase-js";
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
  /**
   * Optional game-specific replacement for the platform core's generic
   * `startGame` (lib/rooms), run when the host presses "Start Game". Most
   * games can omit this and get the generic status-flip stub. "Who Am I?"
   * needs its own (SPEC.md §8 "Setup": random no-repeat character
   * assignment has to happen as part of game start, via trusted server
   * logic — see games/who-am-i/config.ts) — this is the extension point
   * that lets it do that without RoomClient (platform core) ever knowing
   * "Who Am I?" exists. Should throw on failure; RoomClient surfaces the
   * error and leaves the room in `lobby`.
   */
  onStart?: (supabase: SupabaseClient, room: Room) => Promise<void>;
}

/**
 * Serializable subset of GameConfig, safe to pass as a prop from a Server
 * Component into a Client Component (e.g. the game picker on the landing
 * page). `onStart` is a function — React can't serialize it across the
 * server/client boundary, so anything that needs to actually call it (e.g.
 * RoomClient) must resolve the full GameConfig itself, client-side, via
 * `getGameConfig()` — the same pattern already used for `getGameRoomView`.
 */
export type GameSummary = Omit<GameConfig, "onStart">;

export function toGameSummary(config: GameConfig): GameSummary {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
  const { onStart, ...summary } = config;
  return summary;
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
  /**
   * Player ids currently tracked as online by the platform core's Presence
   * channel (SPEC.md §9 "Presence to track which players are currently
   * connected") — see RoomClient.tsx's `room-presence:<room.id>` channel.
   * Passed down rather than re-tracked here so there's only ever one
   * Presence subscription per room, shared by the lobby view and whichever
   * game module is rendering. A game module is free to ignore this if it
   * has no use for live online/offline status.
   */
  onlineIds: Set<string>;
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
