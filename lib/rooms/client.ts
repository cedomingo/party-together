"use client";

// Browser-side wrappers for the room create/join API routes
// (app/api/rooms/{create,join}/route.ts — SPEC.md §10). Phase 9 moved the
// actual `createRoom`/`joinRoomByCode` calls (lib/rooms/index.ts) behind
// route handlers so they could be rate-limited server-side; these
// functions are what Client Components call instead, keeping the
// call-and-catch shape (`RoomError` subclasses) the existing forms already
// expect.

import { RoomError, type CreateRoomResult, type JoinRoomResult } from "@/lib/rooms";

async function postJson<T>(url: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new RoomError("Couldn't reach the server. Check your connection and try again.");
  }

  const data = await response.json().catch(() => ({}) as Record<string, unknown>);

  if (!response.ok) {
    const message =
      typeof (data as { error?: unknown }).error === "string"
        ? ((data as { error: string }).error)
        : "Something went wrong.";
    throw new RoomError(message);
  }

  return data as T;
}

export async function createRoomViaApi(params: {
  /** Optional — the home page creates a game-less shell and the host picks
   * the game afterwards on /games; per-game landing pages pass it up
   * front. */
  gameId?: string | null;
  nickname: string;
  maxPlayers?: number | null;
  mushroomIndex?: number;
  accessoryIndex?: number;
}): Promise<CreateRoomResult> {
  return postJson<CreateRoomResult>("/api/rooms/create", params);
}

export async function joinRoomByCodeViaApi(
  code: string,
  nickname: string,
  mushroomIndex?: number,
  accessoryIndex?: number
): Promise<JoinRoomResult> {
  return postJson<JoinRoomResult>("/api/rooms/join", { code, nickname, mushroomIndex, accessoryIndex });
}
