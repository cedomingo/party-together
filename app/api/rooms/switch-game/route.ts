// Host picks a game for a room without anyone leaving it — this is the one
// place `rooms.game_id` is ever changed after creation. Serves two flows,
// both landing on /games?room=CODE:
//   - create-then-pick: the home page creates a game-less shell (room
//     code, no game) and sends the host here to choose the first game
//     (room status = 'lobby').
//   - "Play More Games" after a finished game (recap screen -> this route
//     -> /games/[gameId]/room/CODE). Same room code, same players.
//
// Authorization mirrors play-again/route.ts's shape (room lookup + explicit
// host check via the caller's own cookie-authenticated client). The write
// is guarded on status being 'lobby' or 'finished' — never 'in_progress' —
// so a live in-progress session can never be stranded under a mismatched
// game_id, and a double-submit is a harmless no-op on the second call.
//
// No cleanup of per-game tables: all game data (who_am_i_assignments,
// questions_log, who_are_you_* etc.) hangs off `game_sessions.session_id`,
// not `rooms.game_id`, and sessions are keyed to the room — exactly like
// play-again, the just-finished session is left in place as history and the
// new game's start route creates a fresh session with its own game_id.
// (Verified in the Phase 0 investigation — nothing references
// rooms.game_id via FK.)
//
// The resulting rooms UPDATE (game_id + status -> 'lobby') is picked up by
// every player in the room through RoomClient's existing `postgres_changes`
// subscription on `rooms` — no new subscription needed (the host is
// redirected to the new game's room URL; other players see the room flip
// back to the lobby with the new game via RoomClient's gameConfig resolved
// from room.game_id).

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { normalizeRoomCode } from "@/lib/rooms";
import { getGameConfig } from "@/lib/games-registry";

export async function POST(request: Request) {
  let body: { roomId?: unknown; code?: unknown; gameId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { roomId, code, gameId } = body;
  if (typeof gameId !== "string" || gameId.length === 0) {
    return NextResponse.json({ error: "gameId (string) is required." }, { status: 400 });
  }
  // At least one of roomId/code is required — the recap screen has room.id,
  // while the /games?room=CODE page only has the code. Prefer roomId when
  // both happen to be present.
  const hasRoomId = typeof roomId === "string" && roomId.length > 0;
  const hasCode = typeof code === "string" && code.length > 0;
  if (!hasRoomId && !hasCode) {
    return NextResponse.json({ error: "roomId or code (string) is required." }, { status: 400 });
  }

  // The target game must actually be registered — an unknown gameId would
  // strand the room in a state nothing can start.
  if (!getGameConfig(gameId)) {
    return NextResponse.json({ error: `Unknown game \"${gameId}\".` }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  // RLS-scoped read (rooms_select_any_authenticated) — same as
  // play-again/route.ts's equivalent lookup, resolved by id or code.
  const query = supabase.from("rooms").select("id, status, game_id");
  const { data: room, error: roomError } = await (hasRoomId
    ? query.eq("id", roomId as string)
    : query.eq("code", normalizeRoomCode(code as string))
  ).maybeSingle();

  if (roomError || !room) {
    return NextResponse.json({ error: "Room not found." }, { status: 404 });
  }

  // A room can be given its first game ('lobby' shell) or swapped after a
  // finished game, but never while a game is mid-play — a live in-progress
  // session must not be stranded under a mismatched game_id.
  if (room.status === "in_progress") {
    return NextResponse.json({ error: "A game is already in progress in this room — end it before switching." }, { status: 409 });
  }

  // RLS-scoped read (players_select_room_members) — only succeeds if the
  // caller's own auth session actually has a player row in this room.
  const { data: callerPlayer, error: callerError } = await supabase
    .from("players")
    .select("id, is_host")
    .eq("room_id", room.id)
    .eq("auth_id", userData.user.id)
    .maybeSingle();

  if (callerError || !callerPlayer) {
    return NextResponse.json({ error: "You're not a member of this room." }, { status: 403 });
  }
  if (!callerPlayer.is_host) {
    return NextResponse.json({ error: "Only the host can switch games." }, { status: 403 });
  }

  // Guarded on status being 'lobby' or 'finished' so a double-submit (two
  // card clicks) is a harmless no-op on the second call — same pattern as
  // play-again's status-guarded update. `rooms_update_host_only` (RLS) lets
  // the verified host flip their own room's game_id/status, so no admin
  // client needed. For a fresh shell this just sets the game (status is
  // already 'lobby'); for a finished room it also flips back to 'lobby'.
  const { error: updateError, data: updatedRoom } = await supabase
    .from("rooms")
    .update({ game_id: gameId, status: "lobby" })
    .eq("id", room.id)
    .in("status", ["lobby", "finished"])
    .select("id")
    .maybeSingle();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }
  if (!updatedRoom) {
    return NextResponse.json({ error: "This room can't switch games right now." }, { status: 409 });
  }

  return NextResponse.json({ ok: true });
}
