// GameConfig for "Who Are You?" — see /lib/games-registry.ts for the shape
// and how this gets wired into the platform.
//
// Step 1 (WHO-ARE-YOU-SPEC.md's build-prompt doc) only covers metadata plus
// `onStart`: flipping the room into the setup/picking phase. No
// `LobbyOptions` yet — the host-configurable game modes (WHO-ARE-YOU-
// SPEC.md §8) are turn-loop concerns, deferred to Step 2, same as
// games/who-am-i/config.tsx's "First One Out Wins?" checkbox was added
// only once the turn loop existed.
//
// This module proves the exact same plugin pattern who-am-i did (SPEC.md
// §3(B)/§12.8): a new folder under /games/, a new registry entry, no
// changes to platform core.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { GameConfig } from "@/lib/games-registry";
import type { Room } from "@/lib/rooms";

export const whoAreYouConfig: GameConfig = {
  id: "who-are-you",
  displayName: "Who Are You?",
  description:
    "Everyone secretly picks a character. Ask yes/no questions to figure out who everyone else picked — before they figure out you.",
  minPlayers: 3,
  maxPlayers: 12,
  // Reuses Who Am I's thumbnail placeholder for now (WHO-ARE-YOU-SPEC.md
  // §2: same 25-character roster/art, no new asset work needed yet).
  thumbnailPath: "/characters/who-am-i/thumbnail.png",
  onStart: startWhoAreYouGame,
};

/**
 * Flips the room into the setup/picking phase (WHO-ARE-YOU-SPEC.md §3
 * point 1) — and only that. Unlike who-am-i's `onStart`, this does NOT
 * assign anything to anyone: each player's own pick is a player-initiated
 * write against `who_are_you_selections` made from RoomView itself, once
 * they land on the character picker (see WHO-ARE-YOU-SPEC.md §3 point 5 —
 * "not something assigned by the host/server like Who Am I's random
 * assignment"). This just creates the session (turnOrder fixed now, state
 * "setup") and marks the room in_progress, via
 * app/api/games/who-are-you/start/route.ts.
 */
async function startWhoAreYouGame(_supabase: SupabaseClient, room: Room): Promise<void> {
  const response = await fetch("/api/games/who-are-you/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId: room.id }),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}) as { error?: string });
    throw new Error(payload.error ?? "Failed to start the game.");
  }
}
