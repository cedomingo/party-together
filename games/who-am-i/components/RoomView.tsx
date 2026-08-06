"use client";

// Phase 3 scaffolding only (SPEC.md §3(B), §6). This is the component the
// platform core hands rendering off to once a room's status is
// "in_progress" and its game_id resolves to "who-am-i" — see
// /lib/games-registry.ts's `getGameRoomView`. The room core (RoomClient)
// never imports this file directly; it only asks the registry for
// "whatever component is registered for this game id."
//
// No board, turn system, or question log yet — that's SPEC.md §8-§9's
// dedicated game-module phase. This just proves the plumbing: a real,
// player-visible component in a game's own folder, and nothing in
// /app or /lib/rooms had to change to reach it.

import type { GameRoomViewProps } from "@/lib/games-registry";

export function WhoAmIRoomView({ gameConfig }: GameRoomViewProps) {
  return (
    <section className="game-placeholder" aria-live="polite">
      <p>{gameConfig.displayName}</p>
      <p>Game starting soon</p>
    </section>
  );
}
