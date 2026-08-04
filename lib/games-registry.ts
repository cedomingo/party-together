// ---------------------------------------------------------------------------
// Central registry of pluggable game modules.
// ---------------------------------------------------------------------------
// This is the ONLY file the platform core is allowed to import game modules
// from. To add a new game later:
//   1. Create /games/<new-game>/config.ts exporting a GameConfig
//   2. Import it below and add it to the `games` array
// No other change to /app or /lib/rooms should be required.

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

// Phase 0: no game modules exist yet, so the registry is empty.
// Phase for "who-am-i" will add:
//   import { whoAmIConfig } from "@/games/who-am-i/config";
export const games: GameConfig[] = [];

export function getGameConfig(id: string): GameConfig | undefined {
  return games.find((g) => g.id === id);
}
