// Submit a question directed at your current 1:1 target on your turn
// (SPEC.md §8 "Turn Loop" point 2, reinterpreted for real 1:1 targeting -
// see games/who-am-i/logic/turnState.ts's file header). Only the current
// asker (per the session's turn state) may call this, and only while the
// loop is in the "asking" phase - see
// app/api/games/who-am-i/_lib/turnSession.ts for how the caller/session are
// resolved, and games/who-am-i/logic/turnState.ts for the phase transition
// (`startAnswering`) this route drives.
//
// The target isn't taken from the request body - it's derived server-side
// from `currentAskTargetId(state)`, the same turn state this route already
// has to trust for "whose turn is it to ask." That way a compromised or
// buggy client can't name a different target than the one the turn loop
// actually has queued up.
//
// Writes go through the caller's own cookie-authenticated client, not the
// admin client - `questions_log_insert_asker_only` (RLS) already requires
// asking_player_id to equal the caller's own player id in this room (and,
// as of the targeted-questions migration, that target_player_id names an
// actual member of that room), and `game_sessions_update_room_members`
// already allows a room member to write the new state. This route adds the
// one check RLS doesn't yet make: that it's actually this player's turn to
// ask, and that the target is actually who the turn loop expects (see
// "Open RLS edge cases" in supabase/migrations/20260806120400_rls_core.sql).

import { NextResponse } from "next/server";
import {
  TurnRequestError,
  loadSessionForTurn,
  saveTurnState,
} from "@/app/api/games/who-am-i/_lib/turnSession";
import {
  TurnStateError,
  currentAskerId,
  currentAskTargetId,
  startAnswering,
} from "@/games/who-am-i/logic/turnState";
import { enforceRateLimit, RateLimitError } from "@/lib/rateLimit";
import { stripUnsafeChars } from "@/lib/rooms";

const MAX_QUESTION_LENGTH = 280;

// SPEC.md §10: "rate-limit question submissions ... server-side ... to
// prevent spam-turn abuse." Keyed by player, not IP - the turn loop
// already only lets one player ask at a time, so this is purely a backstop
// against a single (possibly compromised/scripted) session hammering the
// endpoint, not a substitute for the turn-order check below.
const LIMIT = 10;
const WINDOW_SECONDS = 60;

/**
 * Same sanitization as `sanitizeNickname` in lib/rooms (shares
 * `stripUnsafeChars`): strip angle brackets/control/zero-width chars,
 * collapse whitespace, trim, and fail fast with a friendly error before
 * ever hitting the DB's own `question_text` check constraint
 * (supabase/migrations/20260806120200_game_tables.sql).
 */
function sanitizeQuestionText(raw: string): string {
  const stripped = stripUnsafeChars(raw).replace(/\s+/g, " ").trim().slice(0, MAX_QUESTION_LENGTH);
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

    await enforceRateLimit({
      key: `who-am-i-question:${callerPlayerId}`,
      limit: LIMIT,
      windowSeconds: WINDOW_SECONDS,
    });

    if (currentAskerId(state) !== callerPlayerId) {
      return NextResponse.json({ error: "It isn't your turn to ask a question." }, { status: 403 });
    }

    const targetPlayerId = currentAskTargetId(state);
    if (!targetPlayerId) {
      return NextResponse.json(
        { error: "There's no one left to ask a question this turn." },
        { status: 409 }
      );
    }

    const { data: questionRow, error: insertError } = await supabase
      .from("questions_log")
      .insert({
        session_id: sessionId,
        asking_player_id: callerPlayerId,
        target_player_id: targetPlayerId,
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
    if (err instanceof RateLimitError) {
      return NextResponse.json(
        { error: err.message },
        { status: 429, headers: { "Retry-After": String(err.retryAfterSeconds) } }
      );
    }
    if (err instanceof TurnRequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof TurnStateError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to submit question." }, { status: 500 });
  }
}
