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
// skip already-solved players. Phase 6b (SPEC.md §8 points 6-7) added
// `solvedPlayerIds`: it tracks who has correctly guessed, and every
// transition that picks "who's up next" skips them. A solved player is
// never removed from `turnOrder` itself (they still need a stable seat to
// answer other players' questions from, per SPEC.md §8 point 6: "removed
// from asking rotation but can remain to answer others' questions") —
// only skipped when choosing the next asker.
//
// This revision replaces the *broadcast* question model (one public
// question per turn, every other player answers it in sequence) with real
// 1:1 targeting: the active player asks a DIFFERENT question to EACH other
// player, one at a time. `answeringOrder` still means the same thing it
// always did — the fixed rotation of who gets a turn in the spotlight this
// round — but now each entry in it gets its own ask/answer cycle instead
// of all of them answering one shared question. See `answeringOrder` and
// `answeringIndex` below, and `startAnswering`/`advanceAfterAnswer` for the
// transitions this drives. `answeringOrder` is now built up front, for the
// whole turn, the moment a new asker's turn begins (`initialTurnState` /
// `resetToNextAsker`) rather than lazily when the first (and, previously,
// only) question of the turn was submitted — the asker needs to know who
// they're composing a question *for* before they've written one.

export type WhoAmITurnPhase = "asking" | "answering" | "reviewing";

/**
 * Win-condition variant, chosen by the host in the lobby before the game
 * starts (see the "First One Out Wins?" checkbox — games/who-am-i/config.ts
 * `LobbyOptions`) and fixed for the whole session, same as `turnOrder`.
 *
 * - "last-standing-loses" (the default/"Normal" mode): play continues
 *   until every player but one has correctly guessed their character —
 *   that single remaining unsolved player is the loser, everyone who
 *   solved is a winner.
 * - "first-out-wins": play stops the instant the FIRST player correctly
 *   guesses their character — that player wins outright and the game
 *   ends immediately, regardless of how many players are still unsolved.
 *
 * The lobby checkbox for "first-out-wins" is disabled with only 2 players
 * in the room (see LobbyOptions) because the two modes become degenerate
 * at 2 players — the first correct guess is simultaneously "the first one
 * out" and "everyone but the last player," so there's no meaningful choice
 * to offer. `start/route.ts` also re-derives/clamps this server-side
 * rather than trusting the client-disabled checkbox.
 */
export type WhoAmIGameMode = "last-standing-loses" | "first-out-wins";

export const DEFAULT_GAME_MODE: WhoAmIGameMode = "last-standing-loses";

export interface WhoAmITurnState {
  /** Player ids, fixed for the whole session, established at game start. */
  turnOrder: string[];
  /** Index into turnOrder of the player whose turn it currently is. */
  currentTurnIndex: number;
  phase: WhoAmITurnPhase;
  /**
   * questions_log.id of the question currently being asked/answered — i.e.
   * the question directed at `answeringOrder[answeringIndex]`. Null
   * whenever the asker hasn't yet submitted THAT responder's question
   * (phase "asking" and this isn't the very first responder of the turn,
   * or the turn has just started).
   */
  activeQuestionId: string | null;
  /**
   * The fixed rotation of who gets individually asked a question this
   * turn — same rotation semantics as always (starts with whoever is next
   * after the asker in `turnOrder`, wraps around), but now built once, up
   * front, for the whole turn (see `resetToNextAsker`) rather than derived
   * from a single shared question.
   */
  answeringOrder: string[];
  /**
   * Index into `answeringOrder` of whoever currently has the spotlight —
   * being composed a question for (phase "asking", after the very first
   * target) or actively answering one (phase "answering"). Advances by one
   * every time a question gets fully answered; once it reaches
   * `answeringOrder.length`, every responder has had their own question
   * this turn and the phase moves to "reviewing".
   */
  answeringIndex: number;
  /**
   * questions_log.id values asked so far THIS turn, in order — one per
   * `answeringOrder` entry once the turn is complete. Reset to `[]`
   * whenever a new asker's turn begins. This is what the review screen
   * (SPEC.md §8 point 4: "reviews the public answers") reads to show every
   * question+answer from the turn, not just the last one — with one
   * question per responder there's no longer a single "the" active
   * question left standing by the time review happens.
   */
  turnQuestionIds: string[];
  /**
   * Player ids who have correctly guessed their own character, in the
   * order they solved it (SPEC.md §8 point 7: recap shows "in what
   * order"). Still present in `turnOrder` and still answer other players'
   * questions — just skipped when picking the next asker.
   */
  solvedPlayerIds: string[];
  /** Win-condition variant for this session — see `WhoAmIGameMode` above. */
  gameMode: WhoAmIGameMode;
}

export class TurnStateError extends Error {}

/**
 * The state a freshly-started session begins in: first player in
 * turnOrder is up to ask, nobody's answering yet.
 */
export function initialTurnState(
  turnOrder: readonly string[],
  gameMode: WhoAmIGameMode = DEFAULT_GAME_MODE
): WhoAmITurnState {
  if (turnOrder.length === 0) {
    throw new TurnStateError("Cannot start a turn loop with no players.");
  }
  if (gameMode === "first-out-wins" && turnOrder.length <= 2) {
    // Defensive, mirrors the disabled lobby checkbox (games/who-am-i/config.ts
    // `LobbyOptions`) — the modes are degenerate at 2 players, so silently
    // fall back rather than trust a client that bypassed the disabled UI.
    gameMode = "last-standing-loses";
  }
  const firstAskerId = turnOrder[0]!;
  return {
    turnOrder: [...turnOrder],
    currentTurnIndex: 0,
    phase: "asking",
    activeQuestionId: null,
    answeringOrder: buildAnsweringOrder(turnOrder, firstAskerId),
    answeringIndex: 0,
    turnQuestionIds: [],
    solvedPlayerIds: [],
    gameMode,
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
    Array.isArray(v.turnQuestionIds) &&
    v.turnQuestionIds.every((id) => typeof id === "string") &&
    Array.isArray(v.solvedPlayerIds) &&
    v.solvedPlayerIds.every((id) => typeof id === "string") &&
    (v.gameMode === "last-standing-loses" || v.gameMode === "first-out-wins")
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
 * Who the asker should be composing/has just submitted a question FOR —
 * i.e. the 1:1 target — while `phase` is "asking". Same underlying index
 * as `currentResponderId`, just valid during the other phase: "asking"
 * means "about to (or has just started to) ask this person," "answering"
 * means "this person is now answering." Null once every responder in
 * `answeringOrder` has already had their question this turn (which is
 * exactly when `phase` should already have moved to "reviewing").
 */
export function currentAskTargetId(state: WhoAmITurnState): string | null {
  if (state.phase !== "asking") return null;
  return state.answeringOrder[state.answeringIndex] ?? null;
}

/**
 * Every player has correctly guessed — always a game-over condition
 * regardless of `gameMode` (in "last-standing-loses" this is the edge case
 * where the would-be loser guesses correctly on their very last possible
 * turn instead of running out of unsolved company; in "first-out-wins" it
 * can only happen if `isGameOver` somehow didn't already stop play after
 * the first solve, which shouldn't occur, but this keeps the check
 * unconditionally true as a fallback).
 */
export function isGameFullySolved(state: WhoAmITurnState): boolean {
  return state.turnOrder.length > 0 && state.solvedPlayerIds.length >= state.turnOrder.length;
}

/**
 * Mode-aware game-end check — this is what callers (guess/route.ts) should
 * use instead of `isGameFullySolved` directly, since "when is the game
 * over" now depends on `state.gameMode`:
 *   - "first-out-wins": over the instant one player has solved.
 *   - "last-standing-loses": over once every player but (at most) one has
 *     solved — the one left is the loser. Also covers the edge case where
 *     literally everyone ends up solved.
 */
export function isGameOver(state: WhoAmITurnState): boolean {
  if (state.turnOrder.length === 0) return false;
  if (state.gameMode === "first-out-wins") {
    return state.solvedPlayerIds.length >= 1;
  }
  return state.solvedPlayerIds.length >= state.turnOrder.length - 1;
}

export interface WhoAmIGameOutcome {
  gameOver: boolean;
  /** Player ids considered winners once `gameOver` is true, else []. */
  winnerPlayerIds: string[];
  /** Player ids considered losers once `gameOver` is true, else []. */
  loserPlayerIds: string[];
}

/**
 * Resolves who won/lost once `isGameOver(state)` is true. Safe to call
 * before that too — just returns `gameOver: false` with empty lists.
 *
 *   - "first-out-wins": the single first solver is the winner; everyone
 *     else (solved or not) is a loser — being first is the whole point,
 *     so a second player solving afterward wouldn't matter, and can't
 *     happen anyway since play stops at `isGameOver`.
 *   - "last-standing-loses": everyone who solved is a winner; whichever
 *     player(s) never solved (normally exactly one — see `isGameOver`)
 *     are the loser(s).
 */
export function getGameOutcome(state: WhoAmITurnState): WhoAmIGameOutcome {
  if (!isGameOver(state)) {
    return { gameOver: false, winnerPlayerIds: [], loserPlayerIds: [] };
  }
  if (state.gameMode === "first-out-wins") {
    const winner = state.solvedPlayerIds[0];
    return {
      gameOver: true,
      winnerPlayerIds: winner ? [winner] : [],
      loserPlayerIds: state.turnOrder.filter((id) => id !== winner),
    };
  }
  return {
    gameOver: true,
    winnerPlayerIds: [...state.solvedPlayerIds],
    loserPlayerIds: state.turnOrder.filter((id) => !state.solvedPlayerIds.includes(id)),
  };
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
 * reset to a fresh "asking" phase for whichever unsolved player is next,
 * and build THEIR answeringOrder up front for the whole turn (see
 * `WhoAmITurnState.answeringOrder`'s doc comment for why this happens
 * eagerly now instead of lazily on the first submitted question).
 */
function resetToNextAsker(state: WhoAmITurnState): WhoAmITurnState {
  const nextIndex = nextAskerIndex(state);
  const nextAskerId = state.turnOrder[nextIndex]!;
  return {
    ...state,
    currentTurnIndex: nextIndex,
    phase: "asking",
    activeQuestionId: null,
    answeringOrder: buildAnsweringOrder(state.turnOrder, nextAskerId),
    answeringIndex: 0,
    turnQuestionIds: [],
  };
}

/**
 * Every player except the asker gets individually asked a question, one at
 * a time (SPEC.md §8 point 3, reinterpreted for real 1:1 targeting — see
 * this file's header). Order starts with whoever is next after the asker
 * in turnOrder and wraps around — an arbitrary but stable choice; nothing
 * in the spec requires a specific order, only that it's sequential.
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
 * Transition: asker submits a question targeted at the current responder
 * (`currentAskTargetId`) -> that one player starts answering it. Throws if
 * it isn't actually the asking phase, or if there's no target left to ask
 * (every responder in `answeringOrder` already got their question this
 * turn — shouldn't happen since `phase` would already be "reviewing" by
 * then, but this keeps the invariant enforced rather than assumed), so a
 * caller (the API route) can turn either into a 409 rather than silently
 * corrupting state.
 */
export function startAnswering(state: WhoAmITurnState, questionId: string): WhoAmITurnState {
  if (state.phase !== "asking") {
    throw new TurnStateError(`Cannot submit a question during phase "${state.phase}".`);
  }
  const askerId = currentAskerId(state);
  if (!askerId) {
    throw new TurnStateError("No current asker.");
  }
  const targetId = currentAskTargetId(state);
  if (!targetId) {
    throw new TurnStateError("No target left to ask a question this turn.");
  }
  return {
    ...state,
    phase: "answering",
    activeQuestionId: questionId,
    turnQuestionIds: [...state.turnQuestionIds, questionId],
  };
}

/**
 * Transition: the current responder answers THEIR OWN targeted question.
 * Advances the spotlight to the next responder in `answeringOrder` — back
 * to "asking" so the active player can compose a fresh question for that
 * next person — or, once every responder has had their turn, flips to
 * "reviewing" so the asker can look back over all of this turn's
 * questions/answers (see `turnQuestionIds`), update their board, and press
 * "I'm Done."
 */
export function advanceAfterAnswer(state: WhoAmITurnState): WhoAmITurnState {
  if (state.phase !== "answering") {
    throw new TurnStateError(`Cannot record an answer during phase "${state.phase}".`);
  }
  const nextIndex = state.answeringIndex + 1;
  if (nextIndex >= state.answeringOrder.length) {
    return { ...state, phase: "reviewing", answeringIndex: nextIndex, activeQuestionId: null };
  }
  return { ...state, phase: "asking", answeringIndex: nextIndex, activeQuestionId: null };
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
 * (SPEC.md §8 point 6). Allowed ONLY before they've submitted a question
 * this turn — i.e. during "asking", before `startAnswering` has fired.
 * Guessing is instead-of asking, not in addition to it: once a question
 * round has started (`phase` moved to "answering"/"reviewing"), the guess
 * option is gone for the rest of that turn and the asker's only move left
 * is "I'm Done". This was previously also allowed during "reviewing" (a
 * guess after your own question resolved), but that let a player question
 * *then* guess in the same turn, which isn't how the game is meant to
 * play — a turn is "ask, or guess," never "ask, then guess."
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
 *
 * With real 1:1 targeting, `phase` returns to "asking" between EACH
 * responder's question within the same turn (see `advanceAfterAnswer`) —
 * not just once, like the old broadcast model. So "before you've asked
 * your question this turn" now also requires `turnQuestionIds` to still
 * be empty, not just `phase === "asking"` — otherwise a player could ask
 * one responder, see their answer, and only then decide to guess, which
 * is exactly the "ask, then guess" sequence this was written to prevent.
 */
export function submitGuess(
  state: WhoAmITurnState,
  guesserId: string,
  correct: boolean
): WhoAmITurnState {
  if (state.phase !== "asking" || state.turnQuestionIds.length > 0) {
    throw new TurnStateError("You can only guess before asking a question this turn.");
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
