// Pure turn-loop state machine for "Who Am I?" (SPEC.md §8 "Turn Loop").
// No React, no I/O, no Supabase import — same rationale as
// ../logic/assignCharacters.ts: keeping the state transitions here means
// they're trivially unit-testable in isolation, and every API route that
// mutates `game_sessions.state` (question/route.ts, answer/route.ts,
// done/route.ts) shares exactly one implementation of "what happens next."
//
// This state lives in `game_sessions.state jsonb` (SPEC.md §5: "state
// (jsonb — flexible per-game state)") — that's the column this whole
// module is designed around. It is NOT stored anywhere else.
//
// Phase 6a shipped the ask/answer/done loop only and deliberately left
// guessing/solved state and the game-end condition out — see that phase's
// comment (now superseded below) about `advanceTurn` needing to learn to
// skip already-solved players. This is that follow-up (Phase 6b, SPEC.md
// §8 points 6-7): `turnOrder` still never shrinks or reorders — it's a
// fixed ring for the whole session — but `solvedPlayerIds` now tracks who
// has correctly guessed, and every transition that picks "who's up next"
// skips them. A solved player is never removed from `turnOrder` itself
// (they still need a stable seat to answer other players' questions from,
// per SPEC.md §8 point 6: "removed from asking rotation but can remain to
// answer others' questions") — only skipped when choosing the next asker.

export type WhoAmITurnPhase = "asking" | "answering" | "reviewing";

export interface WhoAmITurnState {
  /** Player ids, fixed for the whole session, established at game start. */
  turnOrder: string[];
  /** Index into turnOrder of the player whose turn it currently is. */
  currentTurnIndex: number;
  phase: WhoAmITurnPhase;
  /** questions_log.id of the question currently being asked/answered. */
  activeQuestionId: string | null;
  /** Responder player ids for the active question, in answering order. */
  answeringOrder: string[];
  /** Index into answeringOrder of whose turn it is to answer next. */
  answeringIndex: number;
  /**
   * Player ids who have correctly guessed their own character, in the
   * order they solved it (SPEC.md §8 point 7: recap shows "in what
   * order"). Still present in `turnOrder` and still answer other players'
   * questions — just skipped when picking the next asker.
   */
  solvedPlayerIds: string[];
}

export class TurnStateError extends Error {}

/**
 * The state a freshly-started session begins in: first player in
 * turnOrder is up to ask, nobody's answering yet.
 */
export function initialTurnState(turnOrder: readonly string[]): WhoAmITurnState {
  if (turnOrder.length === 0) {
    throw new TurnStateError("Cannot start a turn loop with no players.");
  }
  return {
    turnOrder: [...turnOrder],
    currentTurnIndex: 0,
    phase: "asking",
    activeQuestionId: null,
    answeringOrder: [],
    answeringIndex: 0,
    solvedPlayerIds: [],
  };
}

/**
 * Type guard + shape check for whatever comes back out of
 * `game_sessions.state`. That column defaults to `{}` (see
 * supabase/migrations/..._game_tables.sql), so any reader has to handle
 * "not initialized yet" as a distinct case from "malformed."
 */
export function isWhoAmITurnState(value: unknown): value is WhoAmITurnState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.turnOrder) &&
    v.turnOrder.every((id) => typeof id === "string") &&
    typeof v.currentTurnIndex === "number" &&
    (v.phase === "asking" || v.phase === "answering" || v.phase === "reviewing") &&
    (v.activeQuestionId === null || typeof v.activeQuestionId === "string") &&
    Array.isArray(v.answeringOrder) &&
    v.answeringOrder.every((id) => typeof id === "string") &&
    typeof v.answeringIndex === "number" &&
    Array.isArray(v.solvedPlayerIds) &&
    v.solvedPlayerIds.every((id) => typeof id === "string")
  );
}

export function currentAskerId(state: WhoAmITurnState): string | null {
  return state.turnOrder[state.currentTurnIndex] ?? null;
}

export function currentResponderId(state: WhoAmITurnState): string | null {
  if (state.phase !== "answering") return null;
  return state.answeringOrder[state.answeringIndex] ?? null;
}

/** SPEC.md §8 point 7: "Game ends when all players have guessed correctly." */
export function isGameFullySolved(state: WhoAmITurnState): boolean {
  return state.turnOrder.length > 0 && state.solvedPlayerIds.length >= state.turnOrder.length;
}

/**
 * Walks forward around `turnOrder` from the current asker, skipping any
 * player already in `solvedPlayerIds`, and returns the index of the next
 * player who should be up to ask. Falls back to the current index if
 * every player is solved (that's the game-end condition — callers should
 * check `isGameFullySolved` and stop driving the turn loop before this
 * fallback would ever actually surface to a player).
 */
function nextAskerIndex(state: WhoAmITurnState): number {
  const total = state.turnOrder.length;
  for (let step = 1; step <= total; step++) {
    const candidateIndex = (state.currentTurnIndex + step) % total;
    if (!state.solvedPlayerIds.includes(state.turnOrder[candidateIndex]!)) {
      return candidateIndex;
    }
  }
  return state.currentTurnIndex;
}

/**
 * Shared tail end of both `advanceTurn` ("I'm Done") and `submitGuess`:
 * reset to a fresh "asking" phase for whichever unsolved player is next.
 */
function resetToNextAsker(state: WhoAmITurnState): WhoAmITurnState {
  return {
    ...state,
    currentTurnIndex: nextAskerIndex(state),
    phase: "asking",
    activeQuestionId: null,
    answeringOrder: [],
    answeringIndex: 0,
  };
}

/**
 * Every player except the asker answers, one at a time (SPEC.md §8 point
 * 3). Order starts with whoever is next after the asker in turnOrder and
 * wraps around — an arbitrary but stable choice; nothing in the spec
 * requires a specific responder order, only that it's sequential.
 */
export function buildAnsweringOrder(turnOrder: readonly string[], askerId: string): string[] {
  const askerIndex = turnOrder.indexOf(askerId);
  if (askerIndex === -1) {
    return turnOrder.filter((id) => id !== askerId);
  }
  const rotated = [...turnOrder.slice(askerIndex + 1), ...turnOrder.slice(0, askerIndex)];
  return rotated;
}

/**
 * Transition: asker submits a public question -> everyone else starts
 * answering in sequence. Throws if it isn't actually the asking phase,
 * so a caller (the API route) can turn that into a 409 rather than
 * silently corrupting state.
 */
export function startAnswering(state: WhoAmITurnState, questionId: string): WhoAmITurnState {
  if (state.phase !== "asking") {
    throw new TurnStateError(`Cannot submit a question during phase "${state.phase}".`);
  }
  const askerId = currentAskerId(state);
  if (!askerId) {
    throw new TurnStateError("No current asker.");
  }
  const answeringOrder = buildAnsweringOrder(state.turnOrder, askerId);
  if (answeringOrder.length === 0) {
    throw new TurnStateError("No other players available to answer.");
  }
  return {
    ...state,
    phase: "answering",
    activeQuestionId: questionId,
    answeringOrder,
    answeringIndex: 0,
  };
}

/**
 * Transition: the current responder answers. Advances to the next
 * responder, or — once everyone has answered — flips to "reviewing" so
 * the asker can update their board and press "I'm Done."
 */
export function advanceAfterAnswer(state: WhoAmITurnState): WhoAmITurnState {
  if (state.phase !== "answering") {
    throw new TurnStateError(`Cannot record an answer during phase "${state.phase}".`);
  }
  const nextIndex = state.answeringIndex + 1;
  if (nextIndex >= state.answeringOrder.length) {
    return { ...state, phase: "reviewing", answeringIndex: nextIndex };
  }
  return { ...state, answeringIndex: nextIndex };
}

/**
 * Transition: asker presses "I'm Done" — turn passes to the next
 * not-yet-solved player in turnOrder (wrapping around, skipping anyone in
 * `solvedPlayerIds`) and the loop resets to "asking" for them.
 */
export function advanceTurn(state: WhoAmITurnState): WhoAmITurnState {
  if (state.phase !== "reviewing") {
    throw new TurnStateError(`Cannot end a turn during phase "${state.phase}".`);
  }
  return resetToNextAsker(state);
}

/**
 * Transition: the current asker attempts to guess their own identity
 * (SPEC.md §8 point 6). Allowed "at any point on their turn instead of/
 * after asking a question" — read here as: before they've submitted a
 * question this turn ("asking" phase) or after a question round has
 * fully resolved and they're reviewing the board ("reviewing" phase).
 * Guessing mid-"answering" (while other players are still mid-response to
 * the question this same player just asked) is deliberately not allowed —
 * that would leave a question half-resolved with no clean way to unwind
 * it, which the spec doesn't describe. This mirrors the "no penalty for
 * a wrong guess" default the spec calls out as an open design decision.
 *
 * `correct` is the caller's job to determine (by writing the player's
 * guess to `who_am_i_assignments.guessed_character_id` and reading back
 * the generated `is_guessed` column via the `who_am_i_board` masking
 * view) — this function never sees or needs `character_id` itself, so
 * there's no way for this module to leak it.
 *
 * Either way (right or wrong) the guess ends the current player's turn,
 * same as pressing "I'm Done" — see SPEC.md §8 point 6: a wrong guess
 * just "wastes the turn," and a right one has nothing left to do this
 * turn since the player is now solved.
 */
export function submitGuess(
  state: WhoAmITurnState,
  guesserId: string,
  correct: boolean
): WhoAmITurnState {
  if (state.phase !== "asking" && state.phase !== "reviewing") {
    throw new TurnStateError(`Cannot guess during phase "${state.phase}".`);
  }
  if (currentAskerId(state) !== guesserId) {
    throw new TurnStateError("It isn't your turn to guess.");
  }
  if (state.solvedPlayerIds.includes(guesserId)) {
    throw new TurnStateError("You've already solved your identity.");
  }

  const solvedPlayerIds = correct ? [...state.solvedPlayerIds, guesserId] : state.solvedPlayerIds;

  return resetToNextAsker({ ...state, solvedPlayerIds });
}
