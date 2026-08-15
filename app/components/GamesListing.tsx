"use client";

// The /games listing page's interactive half (server page: app/games/page.tsx).
// Renders the shared <GamePicker> and decides what a card click means:
//   - browse mode (no `roomCode`): navigate to that game's landing page
//     (/games/[game]) where a room can be created for it.
//   - room mode (?room=CODE): switch the EXISTING room to the clicked game
//     (app/api/rooms/switch-game/route.ts — host-only, same room code and
//     players, room back in the lobby) then redirect into that game's
//     waiting room.
//
// The switch is deliberately a POST to the route rather than a client-side
// rooms update: switching requires host verification + a status guard, and
// only the server-side route can enforce both (same reason the existing
// play-again routes go through their own API).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { GamePicker } from "@/app/components/GamePicker";
import type { GameSummary } from "@/lib/games-registry";

export function GamesListing({
  games,
  roomCode,
}: {
  games: GameSummary[];
  /** Set when the page was opened as /games?room=CODE (game-swap flow). */
  roomCode?: string | null;
}) {
  const router = useRouter();
  // Which game's card is currently mid-switch (blocks double-clicks while
  // the route + redirect are in flight).
  const [switchingGameId, setSwitchingGameId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSelect(gameId: string) {
    if (!roomCode) {
      router.push(`/games/${gameId}`);
      return;
    }
    if (switchingGameId) return;
    setSwitchingGameId(gameId);
    setError(null);
    try {
      const response = await fetch("/api/rooms/switch-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: roomCode, gameId }),
      });
      const payload = await response.json().catch(() => ({}) as { error?: string });
      if (!response.ok) throw new Error(payload.error ?? "Couldn't switch games.");
      // Same room code, same players — just a new game (and a room that's
      // back in the lobby waiting for the host to start it).
      router.push(`/games/${gameId}/room/${roomCode}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't switch games.");
      setSwitchingGameId(null);
    }
  }

  return (
    <>
      {roomCode && (
        <p className="muted">
          Room <strong>{roomCode}</strong> — share this code with friends (they can join once
          you&rsquo;ve picked a game), then choose a game to move everyone to its waiting room.
          Same room code, same players.
        </p>
      )}
      <GamePicker games={games} selectedGameId={null} onSelect={(id) => void handleSelect(id)} />
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
