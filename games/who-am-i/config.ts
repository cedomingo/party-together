// GameConfig for "Who Am I?" — see /lib/games-registry.ts for the shape
// and for how this gets wired into the platform.
//
// Metadata (id/name/description/player counts/thumbnail) plus, as of the
// Setup & Board phase (SPEC.md §8 "Setup"), `onStart`: the character
// assignment hook that runs instead of the platform core's generic
// `startGame` stub when the host presses "Start Game" in this room. Turn
// system / question log are still NOT implemented here — that's the next
// game-module phase (SPEC.md §8 "Turn Loop" / §9).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { GameConfig } from "@/lib/games-registry";
import type { Room } from "@/lib/rooms";

export const whoAmIConfig: GameConfig = {
  id: "who-am-i",
  displayName: "Who Am I?",
  description:
    "Everyone can see your secret character except you. Ask yes/no questions to figure out who you are before anyone else does.",
  minPlayers: 3,
  maxPlayers: 12,
  thumbnailPath: "/characters/who-am-i/thumbnail.png",
  onStart: startWhoAmIGame,
};

/**
 * Randomly assigns each connected player a character (no repeats) and
 * flips the room to `in_progress`, all as one trusted server-side
 * operation — see app/api/games/who-am-i/start/route.ts for why this can't
 * go through the normal RLS-authenticated client directly
 * (who_am_i_assignments has no INSERT grant at all). Throws on any
 * failure, which RoomClient surfaces to the host and leaves the room in
 * `lobby` so they can retry.
 */
async function startWhoAmIGame(_supabase: SupabaseClient, room: Room): Promise<void> {
  const response = await fetch("/api/games/who-am-i/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId: room.id }),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}) as { error?: string });
    throw new Error(payload.error ?? "Failed to start the game.");
  }
}
