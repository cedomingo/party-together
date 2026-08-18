// "I'm Done" - the asker ends their turn once every other player has
// individually answered their own question (SPEC.md §8 "Turn Loop" point
// 4; see games/who-am-i/logic/turnState.ts's file header for the 1:1
// targeting model). Only the current asker may call this, and only once
// the loop has reached "reviewing" (i.e. every responder in
// answeringOrder has had - and answered - their own question this turn -
// see `advanceAfterAnswer` in turnState.ts, which is what flips phase to
// "reviewing" in the first place).
//
// Deliberately NOT implemented here (that's a separate follow-up per the
// user's phase split): guess/solved handling and the game-end condition.
// This route only ever rotates turnOrder to the next player - see
// `advanceTurn`.

import { NextResponse } from "next/server";
import {
  TurnRequestError,
  loadSessionForTurn,
  saveTurnState,
} from "@/app/api/games/who-am-i/_lib/turnSession";
import { TurnStateError, advanceTurn, currentAskerId } from "@/games/who-am-i/logic/turnState";

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
    if (state.phase !== "reviewing") {
      return NextResponse.json(
        { error: "You can't end your turn until everyone has answered." },
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
