// GameConfig for "Who Am I?" — see /lib/games-registry.ts for the shape
// and for how this gets wired into the platform.
//
// This is metadata only (id/name/description/player counts/thumbnail) so
// the platform core has something to register and the create-room game
// picker (SPEC.md §7) has something to pick. The actual rules — board,
// turn system, question log — are NOT implemented here; that's a later,
// dedicated game-module phase (SPEC.md §8-§9). `thumbnailPath` points at
// an asset that doesn't exist yet either (roster/seed phase); the UI treats
// a missing thumbnail as optional.

import type { GameConfig } from "@/lib/games-registry";

export const whoAmIConfig: GameConfig = {
  id: "who-am-i",
  displayName: "Who Am I?",
  description:
    "Everyone can see your secret character except you. Ask yes/no questions to figure out who you are before anyone else does.",
  minPlayers: 3,
  maxPlayers: 12,
  thumbnailPath: "/characters/who-am-i/thumbnail.png",
};
