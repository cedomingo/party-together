// Guess a specific opponent's character instead of asking them
// (WHO-ARE-YOU-SPEC.md §5). Mirrors who-am-i/guess/route.ts's trusted-
// comparison pattern: this route never returns character_id to the client.
//
// Correctness is resolved with the service-role client reading the
// target's who_are_you_selections row (owner-only under RLS - the caller's
// own client could never see it), comparing server-side, then writing
// is_solved / guessed_character_id / solved_turn_number on the viewer's
// who_are_you_boards row (those columns have no authenticated UPDATE grant).

import { NextResponse } from "next/server";
import {
  TurnRequestError,
  createSupabaseAdminClient,
  endGameSession,
  loadSessionForTurn,
  saveTurnState,
} from "@/app/api/games/who-are-you/_lib/turnSession";
import {
  TurnStateError,
  currentAskTargetId,
  currentAskerId,
  isGameOver,
  submitGuess,
} from "@/games/who-are-you/logic/turnState";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  let body: { sessionId?: unknown; characterId?: unknown; targetPlayerId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { sessionId, characterId, targetPlayerId } = body;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return NextResponse.json({ error: "sessionId (string) is required." }, { status: 400 });
  }
  if (typeof characterId !== "string" || !UUID_PATTERN.test(characterId)) {
    return NextResponse.json(
      { error: "characterId (uuid string) is required." },
      { status: 400 }
    );
  }
  if (typeof targetPlayerId !== "string" || !UUID_PATTERN.test(targetPlayerId)) {
    return NextResponse.json(
      { error: "targetPlayerId (uuid string) is required." },
      { status: 400 }
    );
  }

  try {
    const { supabase, roomId, callerPlayerId, state } = await loadSessionForTurn(sessionId);

    if (currentAskerId(state) !== callerPlayerId) {
      return NextResponse.json({ error: "It isn't your turn to guess." }, { status: 403 });
    }
    if (state.turnPhase !== "asking") {
      return NextResponse.json(
        {
          error:
            state.turnPhase === "answering"
              ? "You can't guess while an answer is still being collected."
              : "You've finished this turn's opponents - press \"I'm Done\" instead.",
        },
        { status: 409 }
      );
    }

    const expectedTarget = currentAskTargetId(state);
    if (!expectedTarget || expectedTarget !== targetPlayerId) {
      return NextResponse.json(
        { error: "That isn't the opponent you're currently up against." },
        { status: 409 }
      );
    }

    const supabaseAdmin = createSupabaseAdminClient();

    // Trusted comparison - never select character_id through the caller's
    // client, and never return it in this response.
    const { data: selectionRow, error: selectionError } = await supabaseAdmin
      .from("who_are_you_selections")
      .select("character_id")
      .eq("session_id", sessionId)
      .eq("player_id", targetPlayerId)
      .maybeSingle();

    if (selectionError || !selectionRow) {
      return NextResponse.json(
        { error: selectionError?.message ?? "Couldn't find that player's pick." },
        { status: 500 }
      );
    }

    const correct = selectionRow.character_id === characterId;

    // Persist board solve state via admin (column grants block the caller).
    const boardUpdate: Record<string, unknown> = {
      guessed_character_id: characterId,
    };
    if (correct) {
      boardUpdate.is_solved = true;
      boardUpdate.solved_turn_number = state.turnNumber;
    }

    const { error: boardError } = await supabaseAdmin
      .from("who_are_you_boards")
      .update(boardUpdate)
      .eq("session_id", sessionId)
      .eq("viewer_player_id", callerPlayerId)
      .eq("target_player_id", targetPlayerId);

    if (boardError) {
      return NextResponse.json({ error: boardError.message }, { status: 500 });
    }

    const nextState = submitGuess(state, callerPlayerId, targetPlayerId, correct);
    await saveTurnState(supabase, sessionId, nextState);

    // Log in questions_log with target_player_id so per-opponent conversations
    // / recap can nest guesses (WHO-ARE-YOU-SPEC.md §5, §9). Best-effort.
    const { error: logError } = await supabase.from("questions_log").insert({
      session_id: sessionId,
      asking_player_id: callerPlayerId,
      target_player_id: targetPlayerId,
      question_text: correct
        ? "Guessed their character - correct!"
        : "Guessed their character - not quite.",
      is_guess: true,
      guessed_character_id: characterId,
      answers: { [callerPlayerId]: correct ? "correct" : "incorrect" },
      resolved: true,
    });
    if (logError) {
      console.error("Failed to log who-are-you guess in questions_log:", logError.message);
    }

    let gameEnded = false;
    if (correct && isGameOver(nextState)) {
      await endGameSession(supabaseAdmin, roomId, sessionId);
      gameEnded = true;
    }

    return NextResponse.json({ correct, state: nextState, gameEnded });
  } catch (err) {
    if (err instanceof TurnRequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof TurnStateError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to submit guess." }, { status: 500 });
  }
}
