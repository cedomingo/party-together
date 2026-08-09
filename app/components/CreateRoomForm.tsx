"use client";

// Platform-core "Create Room" form (SPEC.md §7). Game-agnostic: it just
// reads whatever is in the games registry and lets the host pick one — it
// has no idea "Who Am I?" specifically exists.
//
// `nickname` comes from the shared avatar creator (app/components/AvatarCreator.tsx
// via RoomForms.tsx) rather than a field of its own — there used to be a
// second "Your nickname" input here, but the avatar creator above already
// asks for a name once, and everything on this page shares it.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { RoomError } from "@/lib/rooms";
import { createRoomViaApi } from "@/lib/rooms/client";
import type { GameSummary } from "@/lib/games-registry";

export function CreateRoomForm({
  games,
  fixedGameId,
  nickname,
  mushroomIndex,
  accessoryIndex,
}: {
  games: GameSummary[];
  fixedGameId?: string;
  nickname: string;
  mushroomIndex: number;
  accessoryIndex: number;
}) {
  const router = useRouter();
  const [gameId, setGameId] = useState(fixedGameId ?? games[0]?.id ?? "");
  const [maxPlayers, setMaxPlayers] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!gameId) {
      setError("No games are available to play yet.");
      return;
    }
    if (!nickname.trim()) {
      setError("Add a name up above first.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const parsedMax = maxPlayers.trim() ? Number(maxPlayers) : null;
      const { code } = await createRoomViaApi({
        gameId,
        nickname,
        maxPlayers: parsedMax && parsedMax > 0 ? parsedMax : null,
        mushroomIndex,
        accessoryIndex,
      });
      router.push(`/games/${gameId}/room/${code}`);
    } catch (err) {
      setError(err instanceof RoomError ? err.message : "Something went wrong creating the room.");
      setLoading(false);
    }
  }

  return (
    <form className="panel-form" onSubmit={handleSubmit}>
      <h2>Create a room</h2>

      {!fixedGameId && (
        <label className="field">
          <span>Game</span>
          <select value={gameId} onChange={(e) => setGameId(e.target.value)} disabled={games.length === 0}>
            {games.length === 0 && <option value="">No games available yet</option>}
            {games.map((game) => (
              <option key={game.id} value={game.id}>
                {game.displayName}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="field">
        <span>Max players (optional)</span>
        <input
          type="number"
          min={1}
          value={maxPlayers}
          onChange={(e) => setMaxPlayers(e.target.value)}
          placeholder="No limit"
        />
      </label>

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      <button type="submit" disabled={loading || !gameId}>
        {loading ? "Creating…" : "Create a room"}
      </button>
    </form>
  );
}
