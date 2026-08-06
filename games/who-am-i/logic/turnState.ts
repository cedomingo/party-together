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
// Deliberately out of scope for this phase (Phase 6a): guessing/solved
// state and the game-end condition. `turnOrder` never shrinks or
// reorders itself here — advancing just walks around a fixed ring. A
// later phase (6b) that adds guessing will need to teach `advanceTurn`
// to skip already-solved players; that's a follow-up, not something to
// half-implement now.

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
    typeof v.answeringIndex === "number"
  );
}

export function currentAskerId(state: WhoAmITurnState): string | null {
  return state.turnOrder[state.currentTurnIndex] ?? null;
}

export function currentResponderId(state: WhoAmITurnState): string | null {
  if (state.phase !== "answering") return null;
  return state.answeringOrder[state.answeringIndex] ?? null;
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
 * Transition: asker presses "I'm Done" — turn passes to the next player
 * in turnOrder (wrapping around) and the loop resets to "asking" for
 * them. Guessing/solved-skipping is explicitly not handled here — see
 * file header.
 */
export function advanceTurn(state: WhoAmITurnState): WhoAmITurnState {
  if (state.phase !== "reviewing") {
    throw new TurnStateError(`Cannot end a turn during phase "${state.phase}".`);
  }
  return {
    ...state,
    currentTurnIndex: (state.currentTurnIndex + 1) % state.turnOrder.length,
    phase: "asking",
    activeQuestionId: null,
    answeringOrder: [],
    answeringIndex: 0,
  };
}
