"use client";

// Platform-core "Create Room" form (SPEC.md §7). Game-agnostic: it creates
// a room for the single game it's told about via `fixedGameId` - currently
// only the per-game landing pages at /games/<id> render it, where the game
// is fixed by the page itself. Choosing a game is otherwise done on the
// /games page (app/components/GamePicker.tsx + GamesListing.tsx): either by
// creating a game-less shell on the home page first (CreateRoomShellForm)
// and picking there, or from the /games?room=CODE swap flow.
//
// `nickname` comes from the shared avatar creator (app/components/AvatarCreator.tsx
// via RoomForms.tsx) rather than a field of its own - there used to be a
// second "Your nickname" input here, but the avatar creator above already
// asks for a name once, and everything on this page shares it.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { RoomError } from "@/lib/rooms";
import { createRoomViaApi } from "@/lib/rooms/client";

export function CreateRoomForm({
  fixedGameId,
  nickname,
  mushroomIndex,
  accessoryIndex,
}: {
  /** The game this form creates a room for - fixed by the page that renders it. */
  fixedGameId: string;
  nickname: string;
  mushroomIndex: number;
  accessoryIndex: number;
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
        gameId: fixedGameId,
        nickname,
        maxPlayers: parsedMax && parsedMax > 0 ? parsedMax : null,
        mushroomIndex,
        accessoryIndex,
      });
      router.push(`/games/${fixedGameId}/room/${code}`);
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

      {/* Deliberately NOT gated on avatar-image preloading: the avatar
          indices are already known (localStorage/defaults) and nothing
          about creation needs the PNGs - the ~29 MB preload only feeds the
          preview. Blocking the CTA on it made create/join feel dead for
          seconds on slow connections. The preview still shows its skeleton
          until assets arrive (AvatarCreator's assetsReady). */}
      <button type="submit" disabled={loading}>
        {loading ? "Creating…" : "Create a room"}
      </button>
    </form>
  );
}
