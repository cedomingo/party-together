// Best-effort presence endpoint (SPEC.md §7: "on disconnect, mark player
// connected: false"). `navigator.sendBeacon` can't call a Server Action, so
// the client posts here on `pagehide` instead. This runs through the normal
// cookie-authenticated Supabase server client — RLS (`players_update_self`)
// still enforces that a session can only ever update its own player row,
// this endpoint has no elevated privileges.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { setPlayerConnected, RoomError } from "@/lib/rooms";

export async function POST(request: Request) {
  let body: { playerId?: unknown; connected?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { playerId, connected } = body;
  if (typeof playerId !== "string" || typeof connected !== "boolean") {
    return NextResponse.json({ error: "playerId (string) and connected (boolean) are required." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  try {
    await setPlayerConnected(supabase, playerId, connected);
  } catch (err) {
    // RLS rejects updates to a row that isn't the caller's own.
    return NextResponse.json(
      { error: err instanceof RoomError ? err.message : "Failed to update presence." },
      { status: 403 }
    );
  }

  return NextResponse.json({ ok: true });
}
