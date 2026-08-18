// Stale-player lobby sweep endpoint. Room pages call this periodically while
// the room is in the lobby (see LOBBY_SWEEP_INTERVAL_MS in lib/rooms and the
// sweep effects in RoomClient/GamesListing) so the roster — and the host's
// player-count gate — reflects only players who are actually here, without
// waiting for a reload. The deletes go through the admin client because RLS
// deliberately only lets a player delete their own row (players_delete_self);
// the same sweep runs authoritatively inside the game-start routes, so a
// stale roster here is cosmetic, never load-bearing.
//
// Any room member can trigger it: the operation is idempotent (players who
// have heartbeated recently are never touched) and cheap, and the host being
// the only one allowed to sweep would leave a room dead in the water if the
// host themselves went offline.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getClientIp } from "@/lib/http/clientIp";
import { enforceRateLimit, RateLimitError } from "@/lib/rateLimit";
import { sweepStalePlayers, RoomError } from "@/lib/rooms";

// One member sweeping once a minute is ~10 per 10 minutes; 30 leaves room
// for a few members' pages refreshing at once.
const LIMIT = 30;
const WINDOW_SECONDS = 10 * 60;

export async function POST(request: Request) {
  let body: { roomId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { roomId } = body;
  if (typeof roomId !== "string" || roomId.length === 0) {
    return NextResponse.json({ error: "roomId (string) is required." }, { status: 400 });
  }

  try {
    await enforceRateLimit({
      key: `room-sweep:${getClientIp(request)}`,
      limit: LIMIT,
      windowSeconds: WINDOW_SECONDS,
    });

    const supabase = await createSupabaseServerClient();

    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }

    // RLS-scoped read (rooms_select_any_authenticated) — any signed-in
    // session can read room metadata; the membership check below is the
    // actual gate.
    const { data: room, error: roomError } = await supabase
      .from("rooms")
      .select("id, status")
      .eq("id", roomId)
      .maybeSingle();

    if (roomError || !room) {
      return NextResponse.json({ error: "Room not found." }, { status: 404 });
    }
    // Sweeping mid-game is meaningless (and could orphan session state);
    // the lobby is the only place stale seats matter.
    if (room.status !== "lobby") {
      return NextResponse.json({ ok: true, removed: [] });
    }

    // Only room members may sweep — RLS-scoped read of the caller's own row.
    const { data: memberRow, error: memberError } = await supabase
      .from("players")
      .select("id")
      .eq("room_id", roomId)
      .eq("auth_id", userData.user.id)
      .maybeSingle();

    if (memberError || !memberRow) {
      return NextResponse.json({ error: "You're not a member of this room." }, { status: 403 });
    }

    const removed = await sweepStalePlayers(createSupabaseAdminClient(), roomId);
    return NextResponse.json({ ok: true, removed });
  } catch (err) {
    // players.last_seen_at doesn't exist yet (migration not applied) —
    // nothing to sweep, so behave as a no-op instead of erroring every
    // minute from every room page.
    if (err instanceof RoomError && (err as RoomError & { code?: string }).code === "42703") {
      return NextResponse.json({ ok: true, removed: [] });
    }
    if (err instanceof RateLimitError) {
      return NextResponse.json(
        { error: err.message },
        { status: 429, headers: { "Retry-After": String(err.retryAfterSeconds) } }
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to sweep the room." },
      { status: 500 }
    );
  }
}
