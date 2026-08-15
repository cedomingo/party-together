"use client";

// Platform-core "Join Room" form (SPEC.md §7): code + nickname, no account.
//
// `nickname` comes from the shared avatar creator (app/components/AvatarCreator.tsx
// via RoomForms.tsx) — there used to be a second "Your nickname" input
// here, but the avatar creator above already asks for a name once, and
// everything on this page shares it.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { RoomError } from "@/lib/rooms";
import { joinRoomByCodeViaApi } from "@/lib/rooms/client";

export function JoinRoomForm({
  fixedCode,
  nickname,
  mushroomIndex,
  accessoryIndex,
  avatarAssetsReady = true,
}: {
  fixedCode?: string;
  nickname: string;
  mushroomIndex: number;
  accessoryIndex: number;
  /** False while avatar images are still preloading — see RoomForms.tsx.
   * Held true by default so callers that don't preload keep working. */
  avatarAssetsReady?: boolean;
}) {
  const router = useRouter();
  const [code, setCode] = useState(fixedCode ?? "");
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
      const result = await joinRoomByCodeViaApi(code, nickname, mushroomIndex, accessoryIndex);
      // A game-less room has no /games/<game>/room/<code> URL yet — send the
      // joiner to the picker page with the room code instead, where they'll
      // see the roster and wait with everyone else until the host picks a
      // game (after which they land in the game's waiting room).
      router.push(result.gameId ? `/games/${result.gameId}/room/${result.code}` : `/games?room=${result.code}`);
    } catch (err) {
      setError(err instanceof RoomError ? err.message : "Something went wrong joining the room.");
      setLoading(false);
    }
  }

  return (
    <form className="panel-form" onSubmit={handleSubmit}>
      <h2>Join a room</h2>

      <label className="field">
        <span>Room code</span>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          maxLength={8}
          required
          placeholder="e.g. ABCD"
          autoComplete="off"
          disabled={Boolean(fixedCode)}
          style={{ textTransform: "uppercase" }}
        />
      </label>

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      <button type="submit" disabled={loading || !avatarAssetsReady}>
        {loading ? "Joining…" : avatarAssetsReady ? "Join a room" : "Loading avatar…"}
      </button>
    </form>
  );
}
