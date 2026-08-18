// Transition setup → turns once every player has locked in a pick
// (WHO-ARE-YOU-SPEC.md §3 point 5 → §6). Creates all directed
// who_are_you_boards rows (N×(N−1)) and writes initialTurnsState onto
// game_sessions.state. Idempotent: if phase is already "turns", returns
// the current state without rewriting boards.
//
// Board inserts need the service-role client (no authenticated INSERT
// policy on who_are_you_boards - see 20260815000000_who_are_you_boards.sql).
// The session-state update uses the caller's own client
// (game_sessions_update_room_members).

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isWhoAreYouSetupState } from "@/games/who-are-you/logic/sessionState";
import {
  initialTurnsState,
  isWhoAreYouTurnsState,
  type WhoAreYouTurnsState,
} from "@/games/who-are-you/logic/turnState";

export async function POST(request: Request) {
  let body: { sessionId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { sessionId } = body;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return NextResponse.json({ error: "sessionId (string) is required." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const { data: session, error: sessionError } = await supabase
    .from("game_sessions")
    .select("id, room_id, game_id, state, ended_at")
    .eq("id", sessionId)
    .maybeSingle();

  if (sessionError || !session) {
    return NextResponse.json({ error: "Session not found." }, { status: 404 });
  }
  if (session.game_id !== "who-are-you") {
    return NextResponse.json({ error: "This session isn't a Who Are You? session." }, { status: 400 });
  }
  if (session.ended_at) {
    return NextResponse.json({ error: "This game has already ended." }, { status: 409 });
  }

  const { data: callerPlayer, error: callerError } = await supabase
    .from("players")
    .select("id")
    .eq("room_id", session.room_id)
    .eq("auth_id", userData.user.id)
    .maybeSingle();

  if (callerError || !callerPlayer) {
    return NextResponse.json({ error: "You're not a member of this room." }, { status: 403 });
  }

  // Already in turns - idempotent success (another client won the race).
  if (isWhoAreYouTurnsState(session.state)) {
    return NextResponse.json({ state: session.state as WhoAreYouTurnsState, alreadyStarted: true });
  }

  if (!isWhoAreYouSetupState(session.state)) {
    return NextResponse.json({ error: "This session isn't ready to begin turns." }, { status: 409 });
  }

  const setup = session.state;
  const turnOrder = setup.turnOrder;

  // Every player in turnOrder must have a ready row (and therefore a pick).
  const { data: readyRows, error: readyError } = await supabase
    .from("who_are_you_ready")
    .select("player_id")
    .eq("session_id", sessionId);

  if (readyError) {
    return NextResponse.json({ error: readyError.message }, { status: 500 });
  }

  const readyIds = new Set((readyRows ?? []).map((r) => r.player_id as string));
  const missing = turnOrder.filter((id) => !readyIds.has(id));
  if (missing.length > 0) {
    return NextResponse.json(
      { error: "Not everyone has locked in a character yet." },
      { status: 409 }
    );
  }

  const turnsState = initialTurnsState(turnOrder, setup.baseMode, setup.firstWinEnds);

  // Bulk-create directed boards via admin (no authenticated INSERT grant).
  const boardRows: Array<{
    session_id: string;
    viewer_player_id: string;
    target_player_id: string;
  }> = [];
  for (const viewer of turnOrder) {
    for (const target of turnOrder) {
      if (viewer === target) continue;
      boardRows.push({
        session_id: sessionId,
        viewer_player_id: viewer,
        target_player_id: target,
      });
    }
  }

  const supabaseAdmin = createSupabaseAdminClient();
  const { error: boardsError } = await supabaseAdmin.from("who_are_you_boards").insert(boardRows);
  if (boardsError) {
    // Unique violation = another concurrent begin-turns already inserted -
    // keep going and try to flip state.
    if (boardsError.code !== "23505") {
      return NextResponse.json({ error: boardsError.message }, { status: 500 });
    }
  }

  // Guarded update via admin + phase check: only flip if still in setup, so
  // a concurrent begin-turns can't clobber an already-advanced turn state.
  const { data: updated, error: updateError } = await supabaseAdmin
    .from("game_sessions")
    .update({ state: turnsState })
    .eq("id", sessionId)
    .is("ended_at", null)
    .filter("state->>phase", "eq", "setup")
    .select("id, state")
    .maybeSingle();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  // Re-read in case we lost the race on the update.
  if (!updated) {
    const { data: latest } = await supabase
      .from("game_sessions")
      .select("state")
      .eq("id", sessionId)
      .maybeSingle();
    if (isWhoAreYouTurnsState(latest?.state)) {
      return NextResponse.json({ state: latest.state, alreadyStarted: true });
    }
    return NextResponse.json({ error: "Failed to begin the turn loop." }, { status: 500 });
  }

  return NextResponse.json({
    state: isWhoAreYouTurnsState(updated.state) ? updated.state : turnsState,
    alreadyStarted: false,
  });
}
