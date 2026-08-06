// Host manually ends the game (SPEC.md §8 "Turn Loop" point 7: "Game ends
// when all players have guessed correctly, OR host manually ends it.").
// This is the second half of that condition — the first half (auto-end
// once every player is solved) lives in guess/route.ts.
//
// Only the room's host may call this. Unlike guess/route.ts's own
// end-of-game write, this one doesn't need the admin client at all: the
// caller genuinely is the host here, so their own cookie-authenticated
// client already satisfies both `rooms_update_host_only` and
// `game_sessions_update_room_members` (see supabase/migrations/
// 20260806120400_rls_core.sql) — see the doc comment on `endGameSession`
// in _lib/turnSession.ts for the full reasoning on why each end-path uses
// the client it does.

import { NextResponse } from "next/server";
import {
  TurnRequestError,
  endGameSession,
  loadSessionForTurn,
} from "@/app/api/games/who-am-i/_lib/turnSession";

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
    const { supabase, roomId, callerIsHost } = await loadSessionForTurn(sessionId);

    if (!callerIsHost) {
      return NextResponse.json({ error: "Only the host can end the game." }, { status: 403 });
    }

    await endGameSession(supabase, roomId, sessionId);

    return NextResponse.json({ gameEnded: true });
  } catch (err) {
    if (err instanceof TurnRequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "Failed to end the game." }, { status: 500 });
  }
}
