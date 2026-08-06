"use client";

// Platform-core "Join Room" form (SPEC.md §7): code + nickname, no account.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { RoomError } from "@/lib/rooms";
import { joinRoomByCodeViaApi } from "@/lib/rooms/client";

export function JoinRoomForm({ fixedCode }: { fixedCode?: string } = {}) {
  const router = useRouter();
  const [code, setCode] = useState(fixedCode ?? "");
  const [nickname, setNickname] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const result = await joinRoomByCodeViaApi(code, nickname);
      router.push(`/games/${result.gameId}/room/${result.code}`);
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

      <label className="field">
        <span>Your nickname</span>
        <input
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          maxLength={32}
          required
          placeholder="e.g. Jordan"
          autoComplete="off"
        />
      </label>

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      <button type="submit" disabled={loading}>
        {loading ? "Joining…" : "Join room"}
      </button>
    </form>
  );
}
