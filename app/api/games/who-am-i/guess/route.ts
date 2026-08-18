// Guess your own identity on your turn (SPEC.md §8 "Turn Loop" point 6).
// Only the current asker (per the session's turn state) may call this -
// see app/api/games/who-am-i/_lib/turnSession.ts for how the caller/
// session are resolved, and games/who-am-i/logic/turnState.ts for the
// phase/turn-ownership rules `submitGuess` enforces.
//
// Correctness is determined without this route (or turnState.ts) ever
// touching `character_id` directly:
//   1. Write the guess to `who_am_i_assignments.guessed_character_id`
//      through the caller's own cookie-authenticated client. RLS
//      (`who_am_i_assignments_update_own_row`) plus the column-level grant
//      from supabase/migrations/..._who_am_i_identity_protection.sql only
//      let a player write their own row's `guessed_character_id` - there
//      is no grant that would let them write `character_id` itself.
//   2. Read back `is_guessed` for that same row through the
//      `who_am_i_board` masking view - a *generated* column computed
//      server-side as `guessed_character_id = character_id`. This route
//      never selects `character_id`, so there's nothing here that could
//      leak it even by accident.
//
// If that guess is correct and it makes every player solved (SPEC.md §8
// point 7), this route also ends the game - see `endGameSession` in
// _lib/turnSession.ts for why that specific write needs the admin client
// even though everything else in this route uses the caller's own scoped
// client.

import { NextResponse } from "next/server";
import {
  TurnRequestError,
  createSupabaseAdminClient,
  endGameSession,
  loadSessionForTurn,
  saveTurnState,
} from "@/app/api/games/who-am-i/_lib/turnSession";
import {
  TurnStateError,
  currentAskerId,
  isGameOver,
  submitGuess,
} from "@/games/who-am-i/logic/turnState";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  let body: { sessionId?: unknown; characterId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { sessionId, characterId } = body;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return NextResponse.json({ error: "sessionId (string) is required." }, { status: 400 });
  }
  if (typeof characterId !== "string" || !UUID_PATTERN.test(characterId)) {
    return NextResponse.json(
      { error: "characterId (uuid string) is required." },
      { status: 400 }
    );
  }

  try {
    const { supabase, roomId, callerPlayerId, state } = await loadSessionForTurn(sessionId);

    if (currentAskerId(state) !== callerPlayerId) {
      return NextResponse.json({ error: "It isn't your turn to guess." }, { status: 403 });
    }
    // With real 1:1 targeting, `phase` cycles back to "asking" between
    // EACH responder's question within the same turn (see turnState.ts's
    // `advanceAfterAnswer`) - so "haven't asked yet this turn" needs
    // `turnQuestionIds` too, not just the phase, or a player could ask one
    // responder, see the answer, and only then guess.
    if (state.phase !== "asking" || state.turnQuestionIds.length > 0) {
      return NextResponse.json(
        {
          error:
            state.phase === "answering"
              ? "You can't guess while an answer is still being collected."
              : "You've already asked a question this turn - press \"I'm Done\" instead, or guess next turn.",
        },
        { status: 409 }
      );
    }

    // Record the guess. This is the ONLY write this route makes to
    // who_am_i_assignments, and the column grant means it's physically
    // impossible for it to touch character_id.
    //
    // Chaining .select() here - restricted to the only two columns we
    // actually have a SELECT grant on
    // (20260807090000_who_am_i_assignments_filter_grant.sql) - switches
    // PostgREST off `Prefer: return=minimal` and back to returning the
    // affected row(s). Without this, "0 rows matched, no error" (see the
    // no-assignment-row branch below) and a genuine success look
    // byte-for-byte identical over the wire, which is exactly what let
    // that case go unnoticed for a while - keep this rather than trim it
    // for a "smaller" query.
    const { data: guessUpdateRows, error: guessUpdateError } = await supabase
      .from("who_am_i_assignments")
      .update({ guessed_character_id: characterId })
      .eq("session_id", sessionId)
      .eq("player_id", callerPlayerId)
      .select("session_id, player_id");

    if (guessUpdateError) {
      // Most likely a bad characterId (FK violation) or a race where the
      // assignment row doesn't exist for some reason - either way, this
      // is the caller's fault, not a server error.
      return NextResponse.json({ error: guessUpdateError.message }, { status: 400 });
    }

    if (!guessUpdateRows || guessUpdateRows.length === 0) {
      // No error, but nothing matched. Root-caused: this used to happen
      // because start/route.ts only snapshotted players with
      // `connected = true` at the instant Start was clicked, which could
      // silently drop a real in-room player (e.g. a backgrounded tab
      // flipping `connected` via pagehide/sendBeacon right at that
      // moment - see supabase/RECONNECT_VERIFICATION.md). start/route.ts
      // no longer filters by `connected` for exactly this reason, so this
      // branch should now only be reachable for a genuinely late joiner.
      // Keeping it as a real, honest branch (not a 500) rather than
      // deleting it - a server-side log line here (not user-facing) means
      // a recurrence still leaves a trace instead of needing another round
      // of temporary debug infra.
      console.error("[who-am-i guess] no assignment row for an in-turn caller", {
        sessionId,
        callerPlayerId,
      });
      return NextResponse.json(
        {
          error:
            "You don't have a character assigned for this round - you may have joined or reconnected after it started. Sit tight for the next round, or ask the host to check.",
        },
        { status: 409 }
      );
    }

    // Read the result back through the masking view only - never touch
    // who_am_i_assignments.character_id, and never select it even
    // indirectly by selecting `*`.
    const { data: boardRow, error: boardError } = await supabase
      .from("who_am_i_board")
      .select("is_guessed")
      .eq("session_id", sessionId)
      .eq("player_id", callerPlayerId)
      .maybeSingle();

    if (boardError || !boardRow) {
      return NextResponse.json(
        { error: boardError?.message ?? "Failed to resolve your guess." },
        { status: 500 }
      );
    }

    const correct = boardRow.is_guessed === true;
    const nextState = submitGuess(state, callerPlayerId, correct);
    await saveTurnState(supabase, sessionId, nextState);

    // Log the guess in `questions_log` - SPEC.md §8 point 6 treats
    // guessing as a first-class turn action, so it belongs in the same
    // shared log every other player already scrolls through, the same as
    // an asked question. This never touches the caller's own (secret)
    // character_id: `characterId` here is only ever the character the
    // guesser themselves picked, and `correct`/`is_guessed` was already
    // resolved above without this route ever selecting character_id
    // directly. Best-effort - a failure here shouldn't fail the guess
    // itself, since the guess has already been recorded and the turn
    // state already advanced.
    const { error: logError } = await supabase.from("questions_log").insert({
      session_id: sessionId,
      asking_player_id: callerPlayerId,
      question_text: correct ? "Guessed their identity - correct!" : "Guessed their identity - not quite.",
      is_guess: true,
      guessed_character_id: characterId,
      answers: { [callerPlayerId]: correct ? "correct" : "incorrect" },
      resolved: true,
    });
    if (logError) {
      console.error("Failed to log guess in questions_log:", logError.message);
    }

    // Mode-aware: "first-out-wins" ends the game on the very first correct
    // guess; "last-standing-loses" (the default) keeps going until only one
    // unsolved player remains. See games/who-am-i/logic/turnState.ts
    // `isGameOver` for the per-mode rule.
    let gameEnded = false;
    if (correct && isGameOver(nextState)) {
      // System-detected end condition, not a host action - see the doc
      // comment on `endGameSession` for why this specifically needs the
      // admin client rather than the caller's own scoped one.
      const supabaseAdmin = createSupabaseAdminClient();
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