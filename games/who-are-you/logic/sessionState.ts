// Pure session-state shape for "Who Are You?" (WHO-ARE-YOU-SPEC.md §3, §6).
// No React, no I/O, no Supabase import — same rationale as
// games/who-am-i/logic/turnState.ts: this is the one shared definition of
// what `game_sessions.state jsonb` looks like for this game, read by both
// the start route (which creates it) and RoomView (which reads it).
//
// Step 1 only ever produces phase "setup" — every player independently
// picking a character, with no turn loop yet (WHO-ARE-YOU-SPEC.md's Step 1
// build prompt: "this step stops right where gameplay would begin"). "turns"
// is listed here already so Step 2 (turn loop, per-opponent boards,
// guessing — WHO-ARE-YOU-SPEC.md §4-§9) can extend this same state shape
// in place rather than replacing it, and so `who_are_you_selections`'s
// insert RLS policy (which checks `state->>'phase' = 'setup'`, see
// supabase/migrations/20260811000000_who_are_you_setup.sql) has a real
// "not setup anymore" value to eventually compare against. Nothing in this
// file yet builds or transitions into "turns" — that arrives with Step 2.
export type WhoAreYouPhase = "setup" | "turns";

export interface WhoAreYouSessionState {
  phase: WhoAreYouPhase;
  /**
   * Player ids, fixed for the whole session, established at game start —
   * same join-order convention as who-am-i's `turnOrder`
   * (games/who-am-i/logic/turnState.ts). Not used for anything yet in Step
   * 1 (there's no turn loop to order), but fixing it now, at start, means
   * Step 2 doesn't need a second "who was in the room when we started"
   * write later — and matches how who-am-i already establishes turnOrder
   * once, at the same moment the session is created.
   */
  turnOrder: string[];
}

export class SessionStateError extends Error {}

/**
 * The state a freshly-started "Who Are You?" session begins in: every
 * player in `turnOrder` still needs to pick (WHO-ARE-YOU-SPEC.md §3 points
 * 1-2), nobody has yet.
 */
export function initialWhoAreYouState(turnOrder: readonly string[]): WhoAreYouSessionState {
  if (turnOrder.length === 0) {
    throw new SessionStateError("Cannot start a session with no players.");
  }
  return {
    phase: "setup",
    turnOrder: [...turnOrder],
  };
}

/**
 * Type guard + shape check for whatever comes back out of
 * `game_sessions.state`. That column defaults to `{}` (see
 * supabase/migrations/..._game_tables.sql), so any reader has to handle
 * "not initialized yet" as a distinct case from "malformed" — mirrors
 * `isWhoAmITurnState` in games/who-am-i/logic/turnState.ts.
 */
export function isWhoAreYouSessionState(value: unknown): value is WhoAreYouSessionState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    (v.phase === "setup" || v.phase === "turns") &&
    Array.isArray(v.turnOrder) &&
    v.turnOrder.every((id) => typeof id === "string")
  );
}
