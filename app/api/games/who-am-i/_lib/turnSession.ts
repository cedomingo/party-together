import "server-only";

// Shared setup for every Turn Loop API route (question/answer/done —
// SPEC.md §8 "Turn Loop"). Each of those routes needs the exact same
// preamble: confirm the caller is signed in, resolve their player row in
// the session's room, and load+parse the session's turn state. Centralizing
// it means the three routes can't drift on what "not your turn" or
// "session not found" actually checks.
//
// Deliberately uses the caller's own cookie-authenticated client
// (`createSupabaseServerClient`), not the admin client — every read here
// is something RLS already lets a room member do
// (game_sessions_select_room_members, players_select_room_members), and
// every write these routes go on to make (questions_log insert/update,
// game_sessions update) is likewise something RLS already permits for a
// room member (see supabase/migrations/20260806120400_rls_core.sql). RLS
// just doesn't yet know about turn order — that's what these routes check
// on top, in application code (see the RLS migration's own "Open RLS edge
// cases" comments for why that's deferred rather than pushed into a
// policy).
//
// Phase 6b addition: `loadSessionForTurn` now also resolves whether the
// caller is the room's host (needed by the manual "end game" route) and
// rejects any turn-loop action outright once the session has already
// ended (`ended_at` set) — SPEC.md §8 point 7's game-end condition should
// be a hard stop for question/answer/done/guess, not just something the
// UI happens to hide.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isWhoAmITurnState, type WhoAmITurnState } from "@/games/who-am-i/logic/turnState";

export class TurnRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

export interface LoadedTurnSession {
  supabase: SupabaseClient;
  sessionId: string;
  roomId: string;
  callerPlayerId: string;
  callerIsHost: boolean;
  state: WhoAmITurnState;
}

/**
 * Resolves everything a turn-loop route needs, or throws a
 * `TurnRequestError` with the right HTTP status already attached so the
 * route can just `catch` once and respond.
 */
export async function loadSessionForTurn(sessionId: string): Promise<LoadedTurnSession> {
  const supabase = await createSupabaseServerClient();

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    throw new TurnRequestError("Not signed in.", 401);
  }

  const { data: session, error: sessionError } = await supabase
    .from("game_sessions")
    .select("id, room_id, game_id, state, ended_at")
    .eq("id", sessionId)
    .maybeSingle();

  if (sessionError || !session) {
    // RLS-scoped select — this also covers "you're not in this room" by
    // simply returning no row, same as a genuinely missing session.
    throw new TurnRequestError("Session not found.", 404);
  }
  if (session.game_id !== "who-am-i") {
    throw new TurnRequestError("This session isn't a Who Am I? session.", 400);
  }
  if (session.ended_at) {
    throw new TurnRequestError("This game has already ended.", 409);
  }

  const { data: callerPlayer, error: callerError } = await supabase
    .from("players")
    .select("id, is_host")
    .eq("room_id", session.room_id)
    .eq("auth_id", userData.user.id)
    .maybeSingle();

  if (callerError || !callerPlayer) {
    throw new TurnRequestError("You're not a member of this room.", 403);
  }

  if (!isWhoAmITurnState(session.state)) {
    throw new TurnRequestError("This session's turn loop hasn't started yet.", 409);
  }

  return {
    supabase,
    sessionId: session.id as string,
    roomId: session.room_id as string,
    callerPlayerId: callerPlayer.id as string,
    callerIsHost: callerPlayer.is_host as boolean,
    state: session.state,
  };
}

/**
 * Persists an updated turn state back onto the session. Callers pass the
 * exact next state produced by a games/who-am-i/logic/turnState.ts
 * transition — this function doesn't compute anything, just writes.
 */
export async function saveTurnState(
  supabase: SupabaseClient,
  sessionId: string,
  state: WhoAmITurnState
): Promise<void> {
  const { error } = await supabase.from("game_sessions").update({ state }).eq("id", sessionId);
  if (error) {
    throw new TurnRequestError(error.message, 500);
  }
}

/**
 * Ends a "Who Am I?" game (SPEC.md §8 point 7): flips `rooms.status` to
 * `finished` and stamps `game_sessions.ended_at`. Called from two places,
 * each authorizing differently before it gets here:
 *
 *   - `guess/route.ts`, when a correct guess makes every player solved.
 *     That's a system-detected condition, not a host action, and the
 *     solving player is frequently *not* the host — `rooms_update_host_only`
 *     (RLS) would reject that player's own client trying to flip `rooms`,
 *     so this path always uses the service-role admin client. The
 *     legitimacy of the call was already established by the guess route
 *     re-deriving `isGameFullySolved` from state it just verified.
 *   - `end/route.ts`, when the host manually ends the game. There, the
 *     caller genuinely is the host, so their own cookie-authenticated
 *     client already satisfies `rooms_update_host_only` and
 *     `game_sessions_update_room_members` — no admin client needed, and
 *     using one would just be an unnecessary RLS bypass for a write RLS
 *     already allows.
 *
 * Both writes are guarded (`status = 'in_progress'`, `ended_at is null`)
 * so a race between the two end-paths (or a double-submit of either) is a
 * harmless no-op on the second call rather than a duplicate/conflicting
 * write.
 */
export async function endGameSession(
  client: SupabaseClient,
  roomId: string,
  sessionId: string
): Promise<void> {
  const { error: sessionUpdateError } = await client
    .from("game_sessions")
    .update({ ended_at: new Date().toISOString() })
    .eq("id", sessionId)
    .is("ended_at", null);

  if (sessionUpdateError) {
    throw new TurnRequestError(sessionUpdateError.message, 500);
  }

  const { error: roomUpdateError } = await client
    .from("rooms")
    .update({ status: "finished" })
    .eq("id", roomId)
    .eq("status", "in_progress");

  if (roomUpdateError) {
    throw new TurnRequestError(roomUpdateError.message, 500);
  }
}

/**
 * Thin re-export so callers that need the admin client for the
 * system-detected "all players solved" end path (see `endGameSession`
 * doc above) don't need their own import of `lib/supabase/admin`.
 */
export { createSupabaseAdminClient };
