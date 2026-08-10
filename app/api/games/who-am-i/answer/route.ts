// Submit a yes/no answer to the question directed at you, one responder at
// a time (SPEC.md §8 "Turn Loop" point 3, reinterpreted for real 1:1
// targeting — see games/who-am-i/logic/turnState.ts's file header). Only
// the player whose turn it is to answer (per the session's turn state) may
// call this, and only while the loop is in the "answering" phase.
//
// `answers` is a jsonb map on questions_log ({ player_id: 'yes'|'no' }),
// not a normal relational column, so "add my answer" is a read-modify-
// write rather than a single atomic update — same trade-off the
// `questions_log_update_room_members` RLS policy comment already flags
// ("this doesn't yet stop one member from clobbering another's answer").
// This route narrows that window as much as it reasonably can without a
// bigger schema change: it re-checks the responder-order invariant against
// the state it just read, confirms the active question's own
// `target_player_id` is actually the caller (not just that turnState
// *thinks* it's their turn — belt and suspenders against the two ever
// drifting apart), and rejects a second answer from the same player for
// the same question outright. With one question now always aimed at
// exactly one player, `answers` should only ever end up with a single
// entry, but the map shape is kept as-is — see the targeted-questions
// migration's comment for why.

import { NextResponse } from "next/server";
import {
  TurnRequestError,
  loadSessionForTurn,
  saveTurnState,
} from "@/app/api/games/who-am-i/_lib/turnSession";
import { TurnStateError, advanceAfterAnswer, currentResponderId } from "@/games/who-am-i/logic/turnState";
import { enforceRateLimit, RateLimitError } from "@/lib/rateLimit";
import { stripUnsafeChars } from "@/lib/rooms";

// SPEC.md §10: "rate-limit ... answer submissions server-side ... to
// prevent spam-turn abuse." Same reasoning as question/route.ts — keyed by
// player, backstop behind the responder-order check below, not a
// replacement for it.
const LIMIT = 20;
const WINDOW_SECONDS = 60;

// A responder isn't limited to "yes"/"no" — they can also type a free-text
// answer ("Other...") for cases a strict yes/no can't cover ("kind of",
// "depends", a clarifying detail, etc). `questions_log.answers` is an
// unconstrained jsonb map (see supabase/migrations/
// ..._who_am_i_guess_log_and_free_text_answers.sql), so this is purely an
// application-layer validation choice, not a schema one.
const MAX_ANSWER_LENGTH = 140;

type AnswerValue = "yes" | "no" | string;

function isAnswerValue(value: unknown): value is AnswerValue {
  return typeof value === "string" && value.length > 0;
}

/**
 * "yes"/"no" pass straight through untouched. Anything else is a free-text
 * "Other" answer — sanitize it the same way question text is sanitized
 * (strip unsafe chars, collapse whitespace, cap length) before it ever
 * reaches the DB.
 */
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
      // Belt-and-suspenders: turnState already said it's this player's
      // turn to answer, but this question's own target should always
      // agree — if it doesn't, something's drifted and this is the
      // caller's fault either way (stale client state), not a 500.
      return NextResponse.json(
        { error: "This question isn't addressed to you." },
        { status: 403 }
      );
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
        // A targeted question only ever gets one answer — from
        // target_player_id, just confirmed above — so this always
        // resolves it outright rather than waiting on other responders
        // the way the old broadcast model did.
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
