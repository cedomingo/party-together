// Temporary diagnostic — confirms the actual browser session's identity
// chain (auth.uid() -> players.auth_id -> players.id ->
// current_player_id_in_room()) via the caller's own cookie-authenticated
// client, the same client every real game route uses. Calls the
// SECURITY INVOKER RPC from
// supabase/migrations/20260808010000_debug_room_identity_check_temp.sql.
//
// IMPORTANT: this file must NOT live under a path segment starting with
// `_` (e.g. `_debug/`) — Next.js treats any `_`-prefixed folder as a
// private folder and excludes it from routing entirely, which is exactly
// why app/api/games/who-am-i/_debug/guess-attempt/route.ts (an earlier,
// now-orphaned debug route in this same repo) 404s if you ever try to hit
// it. `app/api/debug/room-identity` has no `_`-prefixed segment, so it
// routes normally.
//
// Usage: from the SAME browser tab where you're signed into the room (so
// the request carries the real session cookies), either navigate to
//   /api/debug/room-identity?room_id=<uuid>
// directly, or run in devtools console:
//   fetch('/api/debug/room-identity?room_id=<uuid>').then(r => r.json()).then(console.log)
//
// Delete this route and its migration once the root cause is confirmed —
// see supabase/WHO_AM_I_GUESS_ASSIGNMENT_BUG_NOTES.md.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const roomId = searchParams.get("room_id");

  if (!roomId || !UUID_PATTERN.test(roomId)) {
    return NextResponse.json(
      { error: "room_id (uuid query param) is required." },
      { status: 400 }
    );
  }

  const supabase = await createSupabaseServerClient();

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    return NextResponse.json({ error: "Not signed in.", userError: userError?.message ?? null }, { status: 401 });
  }

  const { data, error } = await supabase.rpc("debug_room_identity_check_temp", {
    target_room_id: roomId,
  });

  if (error) {
    return NextResponse.json(
      { error: error.message, calledAsAuthUserId: userData.user.id },
      { status: 500 }
    );
  }

  // The RPC returns a table (array of rows) — this call always has at most
  // one row (the LEFT JOIN either matches the caller's own player row or
  // returns nulls for it).
  const row = Array.isArray(data) ? data[0] : data;

  return NextResponse.json({
    // What supabase.auth.getUser() (validated against the auth server)
    // says the caller's user id is.
    getUserResult: userData.user.id,
    // What auth.uid() resolves to *inside Postgres*, for this same
    // request's JWT, plus the rest of the identity chain.
    ...row,
    matchesGetUser: row?.auth_uid === userData.user.id,
  });
}
