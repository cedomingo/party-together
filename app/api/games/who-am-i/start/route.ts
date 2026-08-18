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
import { sweepStalePlayers } from "@/lib/rooms";
import {
  DEFAULT_GAME_MODE,
  initialTurnState,
  type WhoAmIGameMode,
} from "@/games/who-am-i/logic/turnState";

function parseGameMode(value: unknown): WhoAmIGameMode {
  // Trusted server-side validation of the host's lobby checkbox (see
  // games/who-am-i/config.ts `LobbyOptions`) — anything other than the
  // exact "first-out-wins" string falls back to the default "normal" mode
  // rather than erroring, so a stale client / missing field never blocks
  // starting the game.
  return value === "first-out-wins" ? "first-out-wins" : DEFAULT_GAME_MODE;
}

export async function POST(request: Request) {
  let body: { roomId?: unknown; gameMode?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { roomId } = body;
  if (typeof roomId !== "string" || roomId.length === 0) {
    return NextResponse.json({ error: "roomId (string) is required." }, { status: 400 });
  }
  const requestedGameMode = parseGameMode(body.gameMode);

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

  // Everything from here on is privileged: reading the full character
  // roster for assignment purposes is fine either way, but writing
  // game_sessions/who_am_i_assignments and flipping room status requires
  // the admin client.
  const supabaseAdmin = createSupabaseAdminClient();

  // Drop seats that have been offline past the grace window BEFORE deciding
  // who's playing — a tab that died mid-lobby shouldn't leave the game
  // assigning a character (and a turn) to someone who isn't coming back, or
  // count toward the minPlayers gate. See sweepStalePlayers in lib/rooms.
  // Deliberately keyed on `last_seen_at` (a 30s heartbeat from the room
  // pages), NOT `connected` (which pagehide flips false the instant a tab
  // is backgrounded — see the note on the player query below): a player
  // who merely switched tabs still heartbeats inside the grace window.
  try {
    await sweepStalePlayers(supabaseAdmin, roomId);
  } catch (err) {
    // players.last_seen_at doesn't exist yet (migration not applied) —
    // fall back to the old behavior (every room member plays) rather than
    // blocking the start.
    if ((err as { code?: string })?.code !== "42703") throw err;
  }

  // Ordered by join order — this doubles as turnOrder below (SPEC.md §8
  // point 1: "join order or randomized"; join order is simpler to reason
  // about and keeps "who's up next" predictable for players watching the
  // lobby fill up).
  //
  // Deliberately NOT filtered by `connected` here. `connected` is
  // presence/UX state only (a status dot — see
  // supabase/RECONNECT_VERIFICATION.md, "Who's online right now" row: it's
  // explicitly ephemeral and reset on reconnect, never load-bearing for
  // game state). It can be transiently false for a player who is very much
  // still in the room — e.g. `pagehide` fires and flips it via
  // sendBeacon() on a background tab-switch or screen lock, which can
  // easily coincide with the exact moment everyone is tapping their phone
  // to react to the host clicking Start. Filtering on it here silently
  // dropped real participants from the round with no way to ever recover
  // (nothing revisits this list after start). Abandoned seats are instead
  // removed *before* this list is built by the sweep above (which requires
  // the player to have stopped heartbeating for the full grace window, not
  // just to have backgrounded a tab). A player who genuinely isn't in the
  // room yet is already excluded by definition (they have no row to
  // select), and anyone joining *after* this point is already blocked
  // separately (room leaves `lobby`, enforced by both the join route and
  // RLS) — so this list is exactly "current room members," full stop.
  const { data: roomPlayers, error: playersError } = await supabase
    .from("players")
    .select("id")
    .eq("room_id", roomId)
    .order("joined_at", { ascending: true });

  if (playersError) {
    return NextResponse.json({ error: playersError.message }, { status: 500 });
  }

  const playerIds = (roomPlayers ?? []).map((p) => p.id as string);
  if (playerIds.length < 2) {
    return NextResponse.json(
      {
        error: `At least 2 players are needed to start the game — only ${playerIds.length} player${
          playerIds.length === 1 ? "" : "s"
        } ${playerIds.length === 1 ? "is" : "are"} still in the room.`,
      },
      { status: 400 }
    );
  }

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

  // Turn order + turn loop state (SPEC.md §8 "Turn Loop") lives in this
  // session's `state` jsonb from the moment it's created — see
  // games/who-am-i/logic/turnState.ts for the shape and every transition
  // out of it. playerIds here is already join-ordered (see query above),
  // so it's used directly as turnOrder rather than reshuffled.
  const { data: sessionRow, error: sessionError } = await supabaseAdmin
    .from("game_sessions")
    .insert({
      room_id: roomId,
      game_id: "who-am-i",
      started_at: new Date().toISOString(),
      state: initialTurnState(playerIds, requestedGameMode),
    })
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
