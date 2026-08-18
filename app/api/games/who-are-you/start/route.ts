// Server-side game start for "Who Are You?" (WHO-ARE-YOU-SPEC.md §3 point
// 1, §8 lobby modes). Creates a setup-phase session with turnOrder + mode
// options; per-player picks happen later via who_are_you_selections.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { sweepStalePlayers } from "@/lib/rooms";
import {
  DEFAULT_BASE_MODE,
  DEFAULT_FIRST_WIN_ENDS,
  initialWhoAreYouState,
  type WhoAreYouBaseMode,
} from "@/games/who-are-you/logic/sessionState";

function parseBaseMode(value: unknown): WhoAreYouBaseMode {
  if (value === "guess-everyone" || value === "rival-match") return value;
  return DEFAULT_BASE_MODE;
}

export async function POST(request: Request) {
  let body: { roomId?: unknown; baseMode?: unknown; firstWinEnds?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { roomId } = body;
  if (typeof roomId !== "string" || roomId.length === 0) {
    return NextResponse.json({ error: "roomId (string) is required." }, { status: 400 });
  }

  const baseMode = parseBaseMode(body.baseMode);
  const firstWinEnds = typeof body.firstWinEnds === "boolean" ? body.firstWinEnds : DEFAULT_FIRST_WIN_ENDS;

  const supabase = await createSupabaseServerClient();

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

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

  // Drop seats that have been offline past the grace window BEFORE deciding
  // who's playing — who-are-you's setup phase waits on every player to pick
  // a character, so an abandoned tab would stall the game before it ever
  // really starts. See sweepStalePlayers in lib/rooms; keyed on
  // `last_seen_at` (a 30s heartbeat), not the twitchy `connected` flag.
  const supabaseAdmin = createSupabaseAdminClient();
  try {
    await sweepStalePlayers(supabaseAdmin, roomId);
  } catch (err) {
    // players.last_seen_at doesn't exist yet (migration not applied) —
    // fall back to the old behavior rather than blocking the start.
    if ((err as { code?: string })?.code !== "42703") throw err;
  }

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

  const { data: sessionRow, error: sessionError } = await supabase
    .from("game_sessions")
    .insert({
      room_id: roomId,
      game_id: "who-are-you",
      started_at: new Date().toISOString(),
      state: initialWhoAreYouState(playerIds, baseMode, firstWinEnds),
    })
    .select("id")
    .single();

  if (sessionError || !sessionRow) {
    return NextResponse.json(
      { error: sessionError?.message ?? "Failed to create game session." },
      { status: 500 }
    );
  }

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
    return NextResponse.json({ error: "This game has already started." }, { status: 409 });
  }

  return NextResponse.json({ sessionId: sessionRow.id });
}
