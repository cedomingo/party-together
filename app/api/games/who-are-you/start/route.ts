// Server-side game start for "Who Are You?" (WHO-ARE-YOU-SPEC.md §3 point
// 1). Unlike app/api/games/who-am-i/start/route.ts, this route does NOT
// need the service-role admin client anywhere: nothing it writes is secret
// at write time (`game_sessions.state` here is just `{ phase: "setup",
// turnOrder }}` — no character is assigned to anyone by this route), so
// every write it makes is one the host's own RLS-scoped session is already
// allowed to make directly:
//   - game_sessions insert: game_sessions_insert_host_only lets the host
//     insert a session for their own room.
//   - rooms status flip lobby -> in_progress: rooms_update_host_only lets
//     the host update their own room.
// (see supabase/migrations/20260806120400_rls_core.sql for both policies.)
// This route still exists (rather than writing straight from the client in
// games/who-are-you/config.tsx) so the "am I actually the host of a lobby
// room for this game" checks happen once, server-side, the same shape as
// every other game-start path in this codebase — and so a future game mode
// / turnOrder change here doesn't require touching the client.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { initialWhoAreYouState } from "@/games/who-are-you/logic/sessionState";

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

  const supabase = await createSupabaseServerClient();

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  // RLS-scoped read (rooms_select_any_authenticated) — any signed-in
  // session can read room metadata, but that's fine: nothing secret lives
  // on `rooms`.
  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .select("id, status, game_id")
    .eq("id", roomId)
    .maybeSingle();

  if (roomError || !room) {
    return NextResponse.json({ error: "Room not found." }, { status: 404 });
  }
  if (room.game_id !== "who-are-you") {
    return NextResponse.json({ error: "This room isn't a Who Are You? room." }, { status: 400 });
  }
  if (room.status !== "lobby") {
    return NextResponse.json({ error: "This game has already started." }, { status: 409 });
  }

  // RLS-scoped read (players_select_room_members) — only succeeds if the
  // caller's own auth session actually has a player row in this room.
  const { data: callerPlayer, error: callerError } = await supabase
    .from("players")
    .select("id, is_host")
    .eq("room_id", roomId)
    .eq("auth_id", userData.user.id)
    .maybeSingle();

  if (callerError || !callerPlayer) {
    return NextResponse.json({ error: "You're not a member of this room." }, { status: 403 });
  }
  if (!callerPlayer.is_host) {
    return NextResponse.json({ error: "Only the host can start the game." }, { status: 403 });
  }

  // Ordered by join order, fixed as turnOrder for the whole session — same
  // convention as who-am-i's start route, and same reasoning for NOT
  // filtering by `connected` (see that route's comment): `connected` is
  // ephemeral presence/UX state, not load-bearing for who's actually a
  // member of this round.
  const { data: roomPlayers, error: playersError } = await supabase
    .from("players")
    .select("id")
    .eq("room_id", roomId)
    .order("joined_at", { ascending: true });

  if (playersError) {
    return NextResponse.json({ error: playersError.message }, { status: 500 });
  }

  const playerIds = (roomPlayers ?? []).map((p) => p.id as string);
  if (playerIds.length === 0) {
    return NextResponse.json({ error: "No players in the room to start with." }, { status: 400 });
  }

  const { data: sessionRow, error: sessionError } = await supabase
    .from("game_sessions")
    .insert({
      room_id: roomId,
      game_id: "who-are-you",
      started_at: new Date().toISOString(),
      state: initialWhoAreYouState(playerIds),
    })
    .select("id")
    .single();

  if (sessionError || !sessionRow) {
    return NextResponse.json(
      { error: sessionError?.message ?? "Failed to create game session." },
      { status: 500 }
    );
  }

  // Only flip lobby -> in_progress once the session write above has fully
  // succeeded, and guard against a double-submit (two "Start Game" clicks)
  // re-running this whole route by re-checking status in the same WHERE
  // clause — same race guard as who-am-i's start route.
  const { error: roomUpdateError, data: updatedRoom } = await supabase
    .from("rooms")
    .update({ status: "in_progress" })
    .eq("id", roomId)
    .eq("status", "lobby")
    .select("id")
    .maybeSingle();

  if (roomUpdateError) {
    return NextResponse.json({ error: roomUpdateError.message }, { status: 500 });
  }
  if (!updatedRoom) {
    // Someone else's concurrent "Start Game" click won the race and already
    // flipped the room after our own status check above. Leave the
    // now-orphaned session we just wrote — harmless, and safer than
    // deleting a session another request may already be reading.
    return NextResponse.json({ error: "This game has already started." }, { status: 409 });
  }

  return NextResponse.json({ sessionId: sessionRow.id });
}
