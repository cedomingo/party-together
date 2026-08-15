// Submit a yes/no/other answer to the question directed at you
// (WHO-ARE-YOU-SPEC.md §6). Mirrors who-am-i/answer/route.ts.

import { NextResponse } from "next/server";
import {
  TurnRequestError,
  loadSessionForTurn,
  saveTurnState,
} from "@/app/api/games/who-are-you/_lib/turnSession";
import { TurnStateError, advanceAfterAnswer, currentResponderId } from "@/games/who-are-you/logic/turnState";
import { enforceRateLimit, RateLimitError } from "@/lib/rateLimit";
import { stripUnsafeChars } from "@/lib/rooms";

const LIMIT = 20;
const WINDOW_SECONDS = 60;
const MAX_ANSWER_LENGTH = 140;

type AnswerValue = "yes" | "no" | string;

function isAnswerValue(value: unknown): value is AnswerValue {
  return typeof value === "string" && value.length > 0;
}

function normalizeAnswer(raw: string): AnswerValue {
  if (raw === "yes" || raw === "no") return raw;
  const cleaned = stripUnsafeChars(raw).replace(/\s+/g, " ").trim().slice(0, MAX_ANSWER_LENGTH);
  if (cleaned.length < 1) {
    throw new TurnRequestError("Answer must be between 1 and 140 characters.", 400);
  }
  return cleaned;
}

export async function POST(request: Request) {
  let body: { sessionId?: unknown; answer?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { sessionId, answer } = body;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return NextResponse.json({ error: "sessionId (string) is required." }, { status: 400 });
  }
  if (!isAnswerValue(answer)) {
    return NextResponse.json({ error: "answer must be a non-empty string." }, { status: 400 });
  }

  try {
    const cleanAnswer = normalizeAnswer(answer);
    const { supabase, callerPlayerId, state } = await loadSessionForTurn(sessionId);

    await enforceRateLimit({
      key: `who-are-you-answer:${callerPlayerId}`,
      limit: LIMIT,
      windowSeconds: WINDOW_SECONDS,
    });

    if (currentResponderId(state) !== callerPlayerId) {
      return NextResponse.json(
        { error: "It isn't your turn to answer this question." },
        { status: 403 }
      );
    }
    if (!state.activeQuestionId) {
      return NextResponse.json({ error: "There's no active question to answer." }, { status: 409 });
    }

    const { data: questionRow, error: questionError } = await supabase
      .from("questions_log")
      .select("id, session_id, target_player_id, answers, resolved")
      .eq("id", state.activeQuestionId)
      .maybeSingle();

    if (questionError || !questionRow) {
      return NextResponse.json({ error: "Active question not found." }, { status: 404 });
    }
    if (questionRow.session_id !== sessionId) {
      return NextResponse.json({ error: "Active question belongs to a different session." }, {
        status: 409,
      });
    }
    if (questionRow.target_player_id !== callerPlayerId) {
      return NextResponse.json({ error: "This question isn't addressed to you." }, { status: 403 });
    }
    if (questionRow.resolved) {
      return NextResponse.json({ error: "This question has already been answered." }, {
        status: 409,
      });
    }

    const existingAnswers = (questionRow.answers ?? {}) as Record<string, AnswerValue>;
    if (callerPlayerId in existingAnswers) {
      return NextResponse.json({ error: "You've already answered this question." }, { status: 409 });
    }

    const nextState = advanceAfterAnswer(state);

    const { error: updateError } = await supabase
      .from("questions_log")
      .update({
        answers: { ...existingAnswers, [callerPlayerId]: cleanAnswer },
        resolved: true,
      })
      .eq("id", state.activeQuestionId);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    await saveTurnState(supabase, sessionId, nextState);

    return NextResponse.json({ state: nextState });
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
    return NextResponse.json({ error: "Failed to submit answer." }, { status: 500 });
  }
}
