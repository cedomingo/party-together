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

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
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
    .select("id, room_id, game_id, state")
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

  const { data: callerPlayer, error: callerError } = await supabase
    .from("players")
    .select("id")
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
