// Submit a question targeted at your current 1:1 opponent on your turn
// (WHO-ARE-YOU-SPEC.md §6). Mirrors who-am-i/question/route.ts.

import { NextResponse } from "next/server";
import {
  TurnRequestError,
  loadSessionForTurn,
  saveTurnState,
} from "@/app/api/games/who-are-you/_lib/turnSession";
import {
  TurnStateError,
  currentAskerId,
  currentAskTargetId,
  startAnswering,
} from "@/games/who-are-you/logic/turnState";
import { enforceRateLimit, RateLimitError } from "@/lib/rateLimit";
import { stripUnsafeChars } from "@/lib/rooms";

const MAX_QUESTION_LENGTH = 280;
const LIMIT = 10;
const WINDOW_SECONDS = 60;

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
      key: `who-are-you-question:${callerPlayerId}`,
      limit: LIMIT,
      windowSeconds: WINDOW_SECONDS,
    });

    if (currentAskerId(state) !== callerPlayerId) {
      return NextResponse.json({ error: "It isn't your turn to ask a question." }, { status: 403 });
    }
    if (state.finishedAskerIds.includes(callerPlayerId)) {
      return NextResponse.json({ error: "You've already finished — no more questions." }, { status: 409 });
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
