"use client";

// Platform-core "Create Room" form for the SHELL-first flow (SPEC.md §7,
// game-agnostic). It creates a room with NO game attached yet — just the
// room code + max players — and sends the host to /games?room=CODE, where
// they can share the code and pick a game (app/components/GamesListing.tsx
// + app/api/rooms/switch-game/route.ts). The game is chosen AFTER
// creation, never here, so this form deliberately has no game picker.
//
// `nickname` comes from the shared avatar creator (app/components/AvatarCreator.tsx
// via RoomForms.tsx) rather than a field of its own — the avatar creator
// above already asks for a name once, and everything on this page shares it.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { RoomError } from "@/lib/rooms";
import { createRoomViaApi } from "@/lib/rooms/client";

export function CreateRoomShellForm({
  nickname,
  mushroomIndex,
  accessoryIndex,
  avatarAssetsReady = true,
}: {
  nickname: string;
  mushroomIndex: number;
  accessoryIndex: number;
  /** False while avatar images are still preloading — see RoomForms.tsx.
   * Held true by default so callers that don't preload keep working. */
  avatarAssetsReady?: boolean;
}) {
  const router = useRouter();
  const [maxPlayers, setMaxPlayers] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!nickname.trim()) {
      setError("Add a name up above first.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const parsedMax = maxPlayers.trim() ? Number(maxPlayers) : null;
      const { code } = await createRoomViaApi({
        // No gameId — the room is created as a game-less shell; the host
        // picks the game on /games?room=CODE afterwards.
        nickname,
        maxPlayers: parsedMax && parsedMax > 0 ? parsedMax : null,
        mushroomIndex,
        accessoryIndex,
      });
      router.push(`/games?room=${code}`);
    } catch (err) {
      setError(err instanceof RoomError ? err.message : "Something went wrong creating the room.");
      setLoading(false);
    }
  }

  return (
    <form className="panel-form" onSubmit={handleSubmit}>
      <h2>Create a room</h2>

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

      <button type="submit" disabled={loading || !nickname.trim() || !avatarAssetsReady}>
        {loading ? "Creating…" : avatarAssetsReady ? "Create a room" : "Loading avatar…"}
      </button>
    </form>
  );
}
