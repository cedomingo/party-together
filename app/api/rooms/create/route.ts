// Room creation endpoint (SPEC.md §7 flow, §10 "server-side rate limiting
// on room creation ... endpoints"). Before Phase 9, `createRoom` (lib/rooms)
// was called straight from the browser's Supabase client — RLS scoped what
// it could write, but nothing server-side could throttle *how often* it
// could be called, which is exactly the "room-flooding" spam SPEC.md §10
// calls out. This route moves that call behind a route handler purely so
// it has somewhere to sit a rate-limit check in front of it; the actual
// room-creation logic/bootstrap sequence is unchanged (see lib/rooms).
//
// Cloudflare (see /cloudflare/README.md) is meant to be the first line of
// defense in front of this at the edge; this is the backstop that still
// holds even if that layer is misconfigured or bypassed.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getClientIp } from "@/lib/http/clientIp";
import { enforceRateLimit, RateLimitError } from "@/lib/rateLimit";
import { createRoom, InvalidNicknameError, RoomError } from "@/lib/rooms";

// Generous enough for a host retrying a typo'd nickname or picking a
// different game, tight enough to make automated room-flooding pointless.
const LIMIT = 5;
const WINDOW_SECONDS = 10 * 60;

export async function POST(request: Request) {
  let body: { gameId?: unknown; nickname?: unknown; maxPlayers?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { gameId, nickname, maxPlayers } = body;
  if (typeof gameId !== "string" || gameId.length === 0) {
    return NextResponse.json({ error: "gameId (string) is required." }, { status: 400 });
  }
  if (typeof nickname !== "string") {
    return NextResponse.json({ error: "nickname (string) is required." }, { status: 400 });
  }
  const parsedMaxPlayers =
    typeof maxPlayers === "number" && Number.isFinite(maxPlayers) && maxPlayers > 0
      ? Math.floor(maxPlayers)
      : null;

  try {
    await enforceRateLimit({
      key: `room-create:${getClientIp(request)}`,
      limit: LIMIT,
      windowSeconds: WINDOW_SECONDS,
    });

    const supabase = await createSupabaseServerClient();
    const result = await createRoom({ supabase, gameId, nickname, maxPlayers: parsedMaxPlayers });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json(
        { error: err.message },
        { status: 429, headers: { "Retry-After": String(err.retryAfterSeconds) } }
      );
    }
    if (err instanceof InvalidNicknameError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof RoomError) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    return NextResponse.json({ error: "Failed to create room." }, { status: 500 });
  }
}
