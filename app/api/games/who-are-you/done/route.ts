// "I'm Done" - asker ends their turn once every opponent slot this turn
// has been asked or guessed (WHO-ARE-YOU-SPEC.md §6).

import { NextResponse } from "next/server";
import {
  TurnRequestError,
  loadSessionForTurn,
  saveTurnState,
} from "@/app/api/games/who-are-you/_lib/turnSession";
import { TurnStateError, advanceTurn, currentAskerId } from "@/games/who-are-you/logic/turnState";

export async function POST(request: Request) {
  let body: { sessionId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { sessionId } = body;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return NextResponse.json({ error: "sessionId (string) is required." }, { status: 400 });
  }

  try {
    const { supabase, callerPlayerId, state } = await loadSessionForTurn(sessionId);

    if (currentAskerId(state) !== callerPlayerId) {
      return NextResponse.json({ error: "It isn't your turn to end." }, { status: 403 });
    }
    if (state.turnPhase !== "reviewing") {
      return NextResponse.json(
        { error: "You can't end your turn until you've gone through every opponent." },
        { status: 409 }
      );
    }

    const nextState = advanceTurn(state);
    await saveTurnState(supabase, sessionId, nextState);

    return NextResponse.json({ state: nextState });
  } catch (err) {
    if (err instanceof TurnRequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof TurnStateError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to end turn." }, { status: 500 });
  }
}
