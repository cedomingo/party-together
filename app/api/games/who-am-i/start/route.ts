// Trusted server-side character assignment for "Who Am I?" game start
// (SPEC.md §8 "Setup"). This can't happen through the normal RLS-scoped
// client: who_am_i_assignments has NO insert grant for authenticated/anon
// at all (see supabase/migrations/..._who_am_i_identity_protection.sql,
// point 4 in its header comment) — character assignment is deliberately
// trusted server logic using the service-role admin client, which is
// exactly what that migration deferred to "a later phase." This is that
// phase.
//
// The admin client bypasses RLS entirely, so every check RLS would
// normally provide has to happen explicitly, here, before any privileged
// write:
//   1. the caller has a real session (cookie-authenticated server client)
//   2. the room exists, is a "who-am-i" room, and is still `lobby`
//   3. the caller is that room's host (only the host may start the game)
// Steps 1-3 run through the caller's own cookie-authenticated session
// (`createSupabaseServerClient`), so RLS is still what enforces "you can
// only see rooms/players you're a member of" for those reads — this route
// only reaches for the admin client afterward, for the writes RLS forbids
// outright.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { assignCharacters, AssignmentError } from "@/games/who-am-i/logic/assignCharacters";

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
  if (room.game_id !== "who-am-i") {
    return NextResponse.json({ error: "This room isn't a Who Am I? room." }, { status: 400 });
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

  const { data: connectedPlayers, error: playersError } = await supabase
    .from("players")
    .select("id")
    .eq("room_id", roomId)
    .eq("connected", true);

  if (playersError) {
    return NextResponse.json({ error: playersError.message }, { status: 500 });
  }

  const playerIds = (connectedPlayers ?? []).map((p) => p.id as string);
  if (playerIds.length === 0) {
    return NextResponse.json({ error: "No connected players to start with." }, { status: 400 });
  }

  // Everything from here on is privileged: reading the full character
  // roster for assignment purposes is fine either way, but writing
  // game_sessions/who_am_i_assignments and flipping room status requires
  // the admin client.
  const supabaseAdmin = createSupabaseAdminClient();

  const { data: characterRows, error: charactersError } = await supabaseAdmin
    .from("characters")
    .select("id")
    .eq("active", true);

  if (charactersError) {
    return NextResponse.json({ error: charactersError.message }, { status: 500 });
  }

  let assignments;
  try {
    assignments = assignCharacters(
      playerIds,
      (characterRows ?? []).map((c) => c.id as string)
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof AssignmentError ? err.message : "Failed to assign characters." },
      { status: 400 }
    );
  }

  const { data: sessionRow, error: sessionError } = await supabaseAdmin
    .from("game_sessions")
    .insert({ room_id: roomId, game_id: "who-am-i", started_at: new Date().toISOString() })
    .select("id")
    .single();

  if (sessionError || !sessionRow) {
    return NextResponse.json(
      { error: sessionError?.message ?? "Failed to create game session." },
      { status: 500 }
    );
  }

  const { error: assignError } = await supabaseAdmin.from("who_am_i_assignments").insert(
    assignments.map(({ playerId, characterId }) => ({
      session_id: sessionRow.id as string,
      player_id: playerId,
      character_id: characterId,
    }))
  );

  if (assignError) {
    // Best-effort cleanup so a failed assignment doesn't leave an orphan
    // session sitting around in `lobby` limbo.
    await supabaseAdmin.from("game_sessions").delete().eq("id", sessionRow.id);
    return NextResponse.json({ error: assignError.message }, { status: 500 });
  }

  // Only flip lobby -> in_progress once assignment has fully succeeded, and
  // guard against a double-submit (two "Start Game" clicks) re-running this
  // whole route by re-checking status in the same WHERE clause.
  const { error: roomUpdateError, data: updatedRoom } = await supabaseAdmin
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
    // now-orphaned session/assignments we just wrote — harmless, and safer
    // than deleting a session another request may already be reading.
    return NextResponse.json({ error: "This game has already started." }, { status: 409 });
  }

  return NextResponse.json({ sessionId: sessionRow.id });
}
