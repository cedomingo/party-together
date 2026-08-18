// Pure session-state shape for "Who Are You?" (WHO-ARE-YOU-SPEC.md §3, §6, §8).
// No React, no I/O - shared by the start route, begin-turns route, and RoomView.
//
// Step 1 only ever produced phase "setup". Step 2 extends this same state
// shape: lobby-configurable modes live on both phases, and once every
// player has picked, begin-turns flips phase to "turns" and nests the
// full turn-loop fields (see turnState.ts).

export type WhoAreYouPhase = "setup" | "turns";

/**
 * Base win-condition mode (WHO-ARE-YOU-SPEC.md §8):
 *   - "guess-everyone" (default): correctly guess every other player;
 *     natural end is last-standing-loses unless firstWinEnds is on.
 *   - "rival-match": only guessing your assigned rival counts toward a win;
 *     natural end is every rival matchup resolved.
 */
export type WhoAreYouBaseMode = "guess-everyone" | "rival-match";

export const DEFAULT_BASE_MODE: WhoAreYouBaseMode = "guess-everyone";
export const DEFAULT_FIRST_WIN_ENDS = false;

export interface WhoAreYouSetupState {
  phase: "setup";
  /**
   * Player ids, fixed for the whole session, established at game start -
   * same join-order convention as who-am-i's `turnOrder`.
   */
  turnOrder: string[];
  baseMode: WhoAreYouBaseMode;
  /** Independent checkbox layered on either base mode (§8). */
  firstWinEnds: boolean;
}

export class SessionStateError extends Error {}

/**
 * The state a freshly-started "Who Are You?" session begins in: every
 * player in `turnOrder` still needs to pick (WHO-ARE-YOU-SPEC.md §3).
 */
export function initialWhoAreYouState(
  turnOrder: readonly string[],
  baseMode: WhoAreYouBaseMode = DEFAULT_BASE_MODE,
  firstWinEnds: boolean = DEFAULT_FIRST_WIN_ENDS
): WhoAreYouSetupState {
  if (turnOrder.length === 0) {
    throw new SessionStateError("Cannot start a session with no players.");
  }
  return {
    phase: "setup",
    turnOrder: [...turnOrder],
    baseMode,
    firstWinEnds,
  };
}

export function isWhoAreYouSetupState(value: unknown): value is WhoAreYouSetupState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.phase !== "setup") return false;
  if (!Array.isArray(v.turnOrder) || !v.turnOrder.every((id) => typeof id === "string")) {
    return false;
  }
  // Step 1 sessions may lack baseMode/firstWinEnds - normalize in place so
  // readers always see a complete setup state.
  if (v.baseMode !== "guess-everyone" && v.baseMode !== "rival-match") {
    (v as { baseMode: WhoAreYouBaseMode }).baseMode = DEFAULT_BASE_MODE;
  }
  if (typeof v.firstWinEnds !== "boolean") {
    (v as { firstWinEnds: boolean }).firstWinEnds = DEFAULT_FIRST_WIN_ENDS;
  }
  return true;
}

/**
 * Broad type guard for whatever comes back out of `game_sessions.state`
 * during either phase. Prefer `isWhoAreYouSetupState` /
 * `isWhoAreYouTurnsState` when you need phase-specific fields.
 */
export type WhoAreYouSessionState = WhoAreYouSetupState | import("./turnState").WhoAreYouTurnsState;

export function isWhoAreYouSessionState(value: unknown): value is WhoAreYouSessionState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.phase === "setup") return isWhoAreYouSetupState(value);
  if (v.phase === "turns") {
    // Lightweight shape check - turnState.isWhoAreYouTurnsState is canonical
    // for the full turns payload.
    return (
      Array.isArray(v.turnOrder) &&
      (v.baseMode === "guess-everyone" || v.baseMode === "rival-match") &&
      typeof v.firstWinEnds === "boolean"
    );
  }
  return false;
}
