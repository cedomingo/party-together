"use client";

// Platform-core "Create Room" form (SPEC.md §7). Game-agnostic: it just
// reads whatever is in the games registry and lets the host pick one — it
// has no idea "Who Am I?" specifically exists.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { createRoom, RoomError } from "@/lib/rooms";
import type { GameSummary } from "@/lib/games-registry";

export function CreateRoomForm({ games, fixedGameId }: { games: GameSummary[]; fixedGameId?: string }) {
  const router = useRouter();
  const [nickname, setNickname] = useState("");
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
    setLoading(true);
    setError(null);
    try {
      const supabase = createSupabaseBrowserClient();
      const parsedMax = maxPlayers.trim() ? Number(maxPlayers) : null;
      const { code } = await createRoom({
        supabase,
        gameId,
        nickname,
        maxPlayers: parsedMax && parsedMax > 0 ? parsedMax : null,
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

      <label className="field">
        <span>Your nickname</span>
        <input
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          maxLength={32}
          required
          placeholder="e.g. Sam"
          autoComplete="off"
        />
      </label>

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
        {loading ? "Creating…" : "Create room"}
      </button>
    </form>
  );
}
