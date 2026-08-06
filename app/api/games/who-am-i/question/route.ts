// Submit a public question on your turn (SPEC.md §8 "Turn Loop" point 2).
// Only the current asker (per the session's turn state) may call this, and
// only while the loop is in the "asking" phase — see
// app/api/games/who-am-i/_lib/turnSession.ts for how the caller/session are
// resolved, and games/who-am-i/logic/turnState.ts for the phase transition
// (`startAnswering`) this route drives.
//
// Writes go through the caller's own cookie-authenticated client, not the
// admin client — `questions_log_insert_asker_only` (RLS) already requires
// asking_player_id to equal the caller's own player id in this room, and
// `game_sessions_update_room_members` already allows a room member to
// write the new state. This route adds the one check RLS doesn't yet make:
// that it's actually this player's turn to ask (see "Open RLS edge cases"
// in supabase/migrations/20260806120400_rls_core.sql).

import { NextResponse } from "next/server";
import {
  TurnRequestError,
  loadSessionForTurn,
  saveTurnState,
} from "@/app/api/games/who-am-i/_lib/turnSession";
import { TurnStateError, currentAskerId, startAnswering } from "@/games/who-am-i/logic/turnState";

const MAX_QUESTION_LENGTH = 280;

/**
 * Same sanitization spirit as `sanitizeNickname` in lib/rooms: strip angle
 * brackets, collapse whitespace, trim, and fail fast with a friendly error
 * before ever hitting the DB's own `question_text` check constraint
 * (supabase/migrations/20260806120200_game_tables.sql).
 */
function sanitizeQuestionText(raw: string): string {
  const stripped = raw.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_QUESTION_LENGTH);
  if (stripped.length < 1) {
    throw new TurnRequestError("Question must be between 1 and 280 characters.", 400);
  }
  return stripped;
}

export async function POST(request: Request) {
  let body: { sessionId?: unknown; questionText?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { sessionId, questionText } = body;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return NextResponse.json({ error: "sessionId (string) is required." }, { status: 400 });
  }
  if (typeof questionText !== "string") {
    return NextResponse.json({ error: "questionText (string) is required." }, { status: 400 });
  }

  try {
    const cleanQuestion = sanitizeQuestionText(questionText);
    const { supabase, callerPlayerId, state } = await loadSessionForTurn(sessionId);

    if (currentAskerId(state) !== callerPlayerId) {
      return NextResponse.json({ error: "It isn't your turn to ask a question." }, { status: 403 });
    }

    const { data: questionRow, error: insertError } = await supabase
      .from("questions_log")
      .insert({
        session_id: sessionId,
        asking_player_id: callerPlayerId,
        question_text: cleanQuestion,
      })
      .select("id")
      .single();

    if (insertError || !questionRow) {
      return NextResponse.json(
        { error: insertError?.message ?? "Failed to submit question." },
        { status: 500 }
      );
    }

    const nextState = startAnswering(state, questionRow.id as string);
    await saveTurnState(supabase, sessionId, nextState);

    return NextResponse.json({ questionId: questionRow.id, state: nextState });
  } catch (err) {
    if (err instanceof TurnRequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof TurnStateError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to submit question." }, { status: 500 });
  }
}
