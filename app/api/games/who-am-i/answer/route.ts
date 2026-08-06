// Submit a yes/no answer to the active question, one responder at a time
// (SPEC.md §8 "Turn Loop" point 3). Only the player whose turn it is to
// answer (per the session's turn state) may call this, and only while the
// loop is in the "answering" phase.
//
// `answers` is a jsonb map on questions_log ({ player_id: 'yes'|'no' }),
// not a normal relational column, so "add my answer" is a read-modify-
// write rather than a single atomic update — same trade-off the
// `questions_log_update_room_members` RLS policy comment already flags
// ("this doesn't yet stop one member from clobbering another's answer").
// This route narrows that window as much as it reasonably can without a
// schema change: it re-checks the responder-order invariant against the
// state it just read, and rejects a second answer from the same player
// for the same question outright.

import { NextResponse } from "next/server";
import {
  TurnRequestError,
  loadSessionForTurn,
  saveTurnState,
} from "@/app/api/games/who-am-i/_lib/turnSession";
import { TurnStateError, advanceAfterAnswer, currentResponderId } from "@/games/who-am-i/logic/turnState";
import { enforceRateLimit, RateLimitError } from "@/lib/rateLimit";

// SPEC.md §10: "rate-limit ... answer submissions server-side ... to
// prevent spam-turn abuse." Same reasoning as question/route.ts — keyed by
// player, backstop behind the responder-order check below, not a
// replacement for it.
const LIMIT = 20;
const WINDOW_SECONDS = 60;

type AnswerValue = "yes" | "no";

function isAnswerValue(value: unknown): value is AnswerValue {
  return value === "yes" || value === "no";
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
    return NextResponse.json({ error: 'answer must be "yes" or "no".' }, { status: 400 });
  }

  try {
    const { supabase, callerPlayerId, state } = await loadSessionForTurn(sessionId);

    await enforceRateLimit({
      key: `who-am-i-answer:${callerPlayerId}`,
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
      .select("id, session_id, answers, resolved")
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
    if (questionRow.resolved) {
      return NextResponse.json({ error: "This question has already been fully answered." }, {
        status: 409,
      });
    }

    const existingAnswers = (questionRow.answers ?? {}) as Record<string, AnswerValue>;
    if (callerPlayerId in existingAnswers) {
      return NextResponse.json({ error: "You've already answered this question." }, { status: 409 });
    }

    const nextState = advanceAfterAnswer(state);
    const nowResolved = nextState.phase === "reviewing";

    const { error: updateError } = await supabase
      .from("questions_log")
      .update({
        answers: { ...existingAnswers, [callerPlayerId]: answer },
        resolved: nowResolved,
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
