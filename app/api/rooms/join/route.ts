// Room join endpoint (SPEC.md §7 flow, §10 "server-side rate limiting on
// ... join ... endpoints"). Same rationale as app/api/rooms/create — moves
// `joinRoomByCode` (lib/rooms) behind a route handler so a rate limit can
// sit in front of it. This only covers *new* joins (someone submitting a
// code + nickname); reconnecting an existing player row on page load
// (app/games/[game]/room/[code]/RoomClient.tsx's initial-load effect)
// doesn't call this at all, so a normal refresh never counts against it —
// see supabase/PHASE9_NOTES.md.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getClientIp } from "@/lib/http/clientIp";
import { enforceRateLimit, RateLimitError } from "@/lib/rateLimit";
import {
  joinRoomByCode,
  InvalidNicknameError,
  RoomAlreadyStartedError,
  RoomError,
  RoomFullError,
  RoomNotFoundError,
} from "@/lib/rooms";

// Looser than room-create — legitimate rooms can see a burst of guests
// joining in quick succession (a host sharing a link right before the
// game starts), and this is still per-IP, not per-room.
const LIMIT = 20;
const WINDOW_SECONDS = 10 * 60;

export async function POST(request: Request) {
  let body: { code?: unknown; nickname?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { code, nickname } = body;
  if (typeof code !== "string" || code.length === 0) {
    return NextResponse.json({ error: "code (string) is required." }, { status: 400 });
  }
  if (typeof nickname !== "string") {
    return NextResponse.json({ error: "nickname (string) is required." }, { status: 400 });
  }

  try {
    await enforceRateLimit({
      key: `room-join:${getClientIp(request)}`,
      limit: LIMIT,
      windowSeconds: WINDOW_SECONDS,
    });

    const supabase = await createSupabaseServerClient();
    const result = await joinRoomByCode(supabase, code, nickname);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json(
        { error: err.message },
        { status: 429, headers: { "Retry-After": String(err.retryAfterSeconds) } }
      );
    }
    if (err instanceof RoomNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof RoomAlreadyStartedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof RoomFullError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof InvalidNicknameError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof RoomError) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    return NextResponse.json({ error: "Failed to join room." }, { status: 500 });
  }
}
