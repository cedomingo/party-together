import "server-only";

// Shared setup for every "Who Are You?" turn-loop API route — mirrors
// app/api/games/who-am-i/_lib/turnSession.ts. Deliberately uses the
// caller's own cookie-authenticated client for reads/writes RLS already
// permits; the guess route additionally uses the admin client to compare
// against who_are_you_selections (owner-only) without ever returning
// character_id to the client.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isWhoAreYouTurnsState, type WhoAreYouTurnsState } from "@/games/who-are-you/logic/turnState";

export class TurnRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "TurnRequestError";
  }
}

export interface LoadedTurnSession {
  supabase: SupabaseClient;
  sessionId: string;
  roomId: string;
  callerPlayerId: string;
  callerIsHost: boolean;
  state: WhoAreYouTurnsState;
}

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
    throw new TurnRequestError("Session not found.", 404);
  }
  if (session.game_id !== "who-are-you") {
    throw new TurnRequestError("This session isn't a Who Are You? session.", 400);
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

  if (!isWhoAreYouTurnsState(session.state)) {
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

export async function saveTurnState(
  supabase: SupabaseClient,
  sessionId: string,
  state: WhoAreYouTurnsState
): Promise<void> {
  const { error } = await supabase.from("game_sessions").update({ state }).eq("id", sessionId);
  if (error) {
    throw new TurnRequestError(error.message, 500);
  }
}

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

export { createSupabaseAdminClient };
