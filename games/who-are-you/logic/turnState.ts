// Pure turn-loop state machine for "Who Are You?" (WHO-ARE-YOU-SPEC.md §5–§8).
// Adapted from games/who-am-i/logic/turnState.ts to operate per-opponent-board
// instead of per-shared-board:
//   - answeringOrder = unsolved opponents for the current asker only
//   - one question OR one guess per opponent per turn
//   - a wrong guess wastes that opponent's slot only (does NOT end the whole turn)
//   - a correct guess solves that pairing; the asker keeps going on the rest
//   - finishedAskerIds tracks players who've met the active mode's win condition
//
// No React, no I/O — shared by begin-turns / question / answer / done / guess
// routes and RoomView.

import type { WhoAreYouBaseMode } from "@/games/who-are-you/logic/sessionState";

export type WhoAreYouTurnPhase = "asking" | "answering" | "reviewing";

export interface WhoAreYouSolvedPairing {
  viewerId: string;
  targetId: string;
  /** 1-based turn number when this pairing was solved (recap §9). */
  turnNumber: number;
}

export interface WhoAreYouTurnsState {
  phase: "turns";
  turnOrder: string[];
  baseMode: WhoAreYouBaseMode;
  /** Independent of baseMode — WHO-ARE-YOU-SPEC.md §8 "First Win Ends Game". */
  firstWinEnds: boolean;
  currentTurnIndex: number;
  turnPhase: WhoAreYouTurnPhase;
  activeQuestionId: string | null;
  answeringOrder: string[];
  answeringIndex: number;
  turnQuestionIds: string[];
  /** All correctly-guessed (viewer → target) pairings, in solve order. */
  solvedPairings: WhoAreYouSolvedPairing[];
  /**
   * Players who've satisfied the active base mode's win condition and are
   * skipped when choosing the next asker (they still answer others).
   */
  finishedAskerIds: string[];
  /**
   * Monotonic counter: 1 for the first asker's turn, increments each time
   * a new asker's turn begins. Used for recap "solved on turn N".
   */
  turnNumber: number;
}

export class TurnStateError extends Error {}

/** Confirmed rival pairing (WHO-ARE-YOU-SPEC.md §8 Mode 2): Player i → i+1, wrap. */
export function rivalOf(turnOrder: readonly string[], playerId: string): string | null {
  const index = turnOrder.indexOf(playerId);
  if (index === -1 || turnOrder.length < 2) return null;
  return turnOrder[(index + 1) % turnOrder.length]!;
}

export function isPairingSolved(
  solvedPairings: readonly WhoAreYouSolvedPairing[],
  viewerId: string,
  targetId: string
): boolean {
  return solvedPairings.some((p) => p.viewerId === viewerId && p.targetId === targetId);
}

export function solvedTargetsFor(
  solvedPairings: readonly WhoAreYouSolvedPairing[],
  viewerId: string
): string[] {
  return solvedPairings.filter((p) => p.viewerId === viewerId).map((p) => p.targetId);
}

/**
 * Has this player satisfied the active base mode's win condition?
 *   - guess-everyone: correctly guessed every other player
 *   - rival-match: correctly guessed their assigned rival
 */
export function hasPlayerFinished(
  turnOrder: readonly string[],
  baseMode: WhoAreYouBaseMode,
  solvedPairings: readonly WhoAreYouSolvedPairing[],
  playerId: string
): boolean {
  if (baseMode === "rival-match") {
    const rival = rivalOf(turnOrder, playerId);
    return rival != null && isPairingSolved(solvedPairings, playerId, rival);
  }
  const others = turnOrder.filter((id) => id !== playerId);
  return others.length > 0 && others.every((id) => isPairingSolved(solvedPairings, playerId, id));
}

/**
 * Unsolved opponents for this asker, in rotation order starting after the
 * asker (WHO-ARE-YOU-SPEC.md §6: unsolved-only).
 */
export function buildAnsweringOrder(
  turnOrder: readonly string[],
  askerId: string,
  solvedPairings: readonly WhoAreYouSolvedPairing[]
): string[] {
  const askerIndex = turnOrder.indexOf(askerId);
  const rotated =
    askerIndex === -1
      ? turnOrder.filter((id) => id !== askerId)
      : [...turnOrder.slice(askerIndex + 1), ...turnOrder.slice(0, askerIndex)];
  return rotated.filter((id) => !isPairingSolved(solvedPairings, askerId, id));
}

export function initialTurnsState(
  turnOrder: readonly string[],
  baseMode: WhoAreYouBaseMode,
  firstWinEnds: boolean
): WhoAreYouTurnsState {
  if (turnOrder.length === 0) {
    throw new TurnStateError("Cannot start a turn loop with no players.");
  }
  const firstAskerId = turnOrder[0]!;
  return {
    phase: "turns",
    turnOrder: [...turnOrder],
    baseMode,
    firstWinEnds,
    currentTurnIndex: 0,
    turnPhase: "asking",
    activeQuestionId: null,
    answeringOrder: buildAnsweringOrder(turnOrder, firstAskerId, []),
    answeringIndex: 0,
    turnQuestionIds: [],
    solvedPairings: [],
    finishedAskerIds: [],
    turnNumber: 1,
  };
}

export function isWhoAreYouTurnsState(value: unknown): value is WhoAreYouTurnsState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.phase === "turns" &&
    Array.isArray(v.turnOrder) &&
    v.turnOrder.every((id) => typeof id === "string") &&
    (v.baseMode === "guess-everyone" || v.baseMode === "rival-match") &&
    typeof v.firstWinEnds === "boolean" &&
    typeof v.currentTurnIndex === "number" &&
    (v.turnPhase === "asking" || v.turnPhase === "answering" || v.turnPhase === "reviewing") &&
    (v.activeQuestionId === null || typeof v.activeQuestionId === "string") &&
    Array.isArray(v.answeringOrder) &&
    v.answeringOrder.every((id) => typeof id === "string") &&
    typeof v.answeringIndex === "number" &&
    Array.isArray(v.turnQuestionIds) &&
    v.turnQuestionIds.every((id) => typeof id === "string") &&
    Array.isArray(v.solvedPairings) &&
    v.solvedPairings.every(
      (p) =>
        p &&
        typeof p === "object" &&
        typeof (p as WhoAreYouSolvedPairing).viewerId === "string" &&
        typeof (p as WhoAreYouSolvedPairing).targetId === "string" &&
        typeof (p as WhoAreYouSolvedPairing).turnNumber === "number"
    ) &&
    Array.isArray(v.finishedAskerIds) &&
    v.finishedAskerIds.every((id) => typeof id === "string") &&
    typeof v.turnNumber === "number"
  );
}

export function currentAskerId(state: WhoAreYouTurnsState): string | null {
  return state.turnOrder[state.currentTurnIndex] ?? null;
}

export function currentResponderId(state: WhoAreYouTurnsState): string | null {
  if (state.turnPhase !== "answering") return null;
  return state.answeringOrder[state.answeringIndex] ?? null;
}

export function currentAskTargetId(state: WhoAreYouTurnsState): string | null {
  if (state.turnPhase !== "asking") return null;
  return state.answeringOrder[state.answeringIndex] ?? null;
}

/**
 * Mode-aware game-end check (WHO-ARE-YOU-SPEC.md §8):
 *   - firstWinEnds: over the instant any player finishes
 *   - guess-everyone (default end): last-standing-loses — over once every
 *     player but (at most) one has finished
 *   - rival-match (default end): over once every player has finished their
 *     rival matchup
 */
export function isGameOver(state: WhoAreYouTurnsState): boolean {
  if (state.turnOrder.length === 0) return false;
  const finished = state.finishedAskerIds.length;
  if (state.firstWinEnds) {
    return finished >= 1;
  }
  if (state.baseMode === "rival-match") {
    return finished >= state.turnOrder.length;
  }
  return finished >= state.turnOrder.length - 1;
}

export interface WhoAreYouGameOutcome {
  gameOver: boolean;
  winnerPlayerIds: string[];
  loserPlayerIds: string[];
}

export function getGameOutcome(state: WhoAreYouTurnsState): WhoAreYouGameOutcome {
  if (!isGameOver(state)) {
    return { gameOver: false, winnerPlayerIds: [], loserPlayerIds: [] };
  }
  if (state.firstWinEnds) {
    // First player in finishedAskerIds who crossed the finish line wins.
    const winner = state.finishedAskerIds[0];
    return {
      gameOver: true,
      winnerPlayerIds: winner ? [winner] : [],
      loserPlayerIds: state.turnOrder.filter((id) => id !== winner),
    };
  }
  if (state.baseMode === "rival-match") {
    // Everyone who solved their rival wins; anyone who somehow hasn't
    // (shouldn't happen at game-over) loses.
    return {
      gameOver: true,
      winnerPlayerIds: [...state.finishedAskerIds],
      loserPlayerIds: state.turnOrder.filter((id) => !state.finishedAskerIds.includes(id)),
    };
  }
  // guess-everyone last-standing-loses
  return {
    gameOver: true,
    winnerPlayerIds: [...state.finishedAskerIds],
    loserPlayerIds: state.turnOrder.filter((id) => !state.finishedAskerIds.includes(id)),
  };
}

function nextAskerIndex(state: WhoAreYouTurnsState): number {
  const total = state.turnOrder.length;
  for (let step = 1; step <= total; step++) {
    const candidateIndex = (state.currentTurnIndex + step) % total;
    if (!state.finishedAskerIds.includes(state.turnOrder[candidateIndex]!)) {
      return candidateIndex;
    }
  }
  return state.currentTurnIndex;
}

function resetToNextAsker(state: WhoAreYouTurnsState): WhoAreYouTurnsState {
  const nextIndex = nextAskerIndex(state);
  const nextAskerId = state.turnOrder[nextIndex]!;
  const nextTurnNumber = state.turnNumber + 1;
  const answeringOrder = buildAnsweringOrder(state.turnOrder, nextAskerId, state.solvedPairings);
  // Empty answeringOrder should only happen if this asker is already
  // finished (nextAskerIndex fallback when everyone is done). Send them
  // straight to reviewing so "I'm Done" can advance / end cleanly.
  return {
    ...state,
    currentTurnIndex: nextIndex,
    turnPhase: answeringOrder.length === 0 ? "reviewing" : "asking",
    activeQuestionId: null,
    answeringOrder,
    answeringIndex: 0,
    turnQuestionIds: [],
    turnNumber: nextTurnNumber,
  };
}

export function startAnswering(state: WhoAreYouTurnsState, questionId: string): WhoAreYouTurnsState {
  if (state.turnPhase !== "asking") {
    throw new TurnStateError(`Cannot submit a question during phase "${state.turnPhase}".`);
  }
  const askerId = currentAskerId(state);
  if (!askerId) throw new TurnStateError("No current asker.");
  const targetId = currentAskTargetId(state);
  if (!targetId) throw new TurnStateError("No target left to ask a question this turn.");
  return {
    ...state,
    turnPhase: "answering",
    activeQuestionId: questionId,
    turnQuestionIds: [...state.turnQuestionIds, questionId],
  };
}

/**
 * After an answer (or a guess that consumed this opponent's slot): advance
 * the spotlight to the next unsolved opponent, or to reviewing.
 */
export function advanceAfterAnswer(state: WhoAreYouTurnsState): WhoAreYouTurnsState {
  if (state.turnPhase !== "answering" && state.turnPhase !== "asking") {
    // Guesses fire while still in "asking"; answers while "answering".
    throw new TurnStateError(`Cannot advance during phase "${state.turnPhase}".`);
  }
  const nextIndex = state.answeringIndex + 1;
  if (nextIndex >= state.answeringOrder.length) {
    return { ...state, turnPhase: "reviewing", answeringIndex: nextIndex, activeQuestionId: null };
  }
  return {
    ...state,
    turnPhase: "asking",
    answeringIndex: nextIndex,
    activeQuestionId: null,
  };
}

export function advanceTurn(state: WhoAreYouTurnsState): WhoAreYouTurnsState {
  if (state.turnPhase !== "reviewing") {
    throw new TurnStateError(`Cannot end a turn during phase "${state.turnPhase}".`);
  }
  return resetToNextAsker(state);
}

/**
 * Guess the current ask-target's character instead of asking them
 * (WHO-ARE-YOU-SPEC.md §5). Allowed only while phase is "asking" for that
 * specific opponent (before a question has been submitted for them).
 *
 * Unlike Who Am I, a wrong guess does NOT end the whole turn — it only
 * wastes this opponent's slot. A correct guess solves that pairing and
 * the asker continues with remaining opponents.
 */
export function submitGuess(
  state: WhoAreYouTurnsState,
  guesserId: string,
  targetId: string,
  correct: boolean
): WhoAreYouTurnsState {
  if (state.turnPhase !== "asking") {
    throw new TurnStateError("You can only guess instead of asking, while composing for an opponent.");
  }
  if (currentAskerId(state) !== guesserId) {
    throw new TurnStateError("It isn't your turn to guess.");
  }
  if (state.finishedAskerIds.includes(guesserId)) {
    throw new TurnStateError("You've already finished — no more asking or guessing.");
  }
  const expectedTarget = currentAskTargetId(state);
  if (!expectedTarget || expectedTarget !== targetId) {
    throw new TurnStateError("That isn't the opponent you're currently up against.");
  }
  if (isPairingSolved(state.solvedPairings, guesserId, targetId)) {
    throw new TurnStateError("You've already solved that opponent.");
  }

  let next: WhoAreYouTurnsState = { ...state };
  if (correct) {
    const solvedPairings: WhoAreYouSolvedPairing[] = [
      ...state.solvedPairings,
      { viewerId: guesserId, targetId, turnNumber: state.turnNumber },
    ];
    next = {
      ...next,
      solvedPairings,
      finishedAskerIds: state.turnOrder.filter((id) =>
        hasPlayerFinished(state.turnOrder, state.baseMode, solvedPairings, id)
      ),
    };
    // Keep answeringOrder as-is and advance the index past this slot —
    // filtering mid-turn would desync answeringIndex. Same as a normal answer.
  }

  return advanceAfterAnswer(next);
}
