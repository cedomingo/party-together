// Host sends a finished room back to the lobby (recap's "Play Again"
// button — SPEC.md §8 point 7's recap screen didn't originally wire this
// up; this route is what makes it real). Once `rooms.status` flips back to
// "lobby" here, platform core (app/games/[game]/room/[code]/RoomClient.tsx)
// picks that up the same way it picks up every other room-status change —
// via its own `postgres_changes` subscription on `rooms` — and swaps every
// player in the room back to the lobby view, host included. That's also
// where re-inviting people happens (the lobby's "Copy invite link" +
// Players list), so this route itself has nothing else to do once the
// status flip lands.
//
// Deliberately does NOT touch `game_sessions` or `who_am_i_assignments` —
// the just-finished session is simply left in place as history. The next
// "Start Game" click (start/route.ts) creates a brand new session with
// fresh character assignments regardless of what the last one looked like,
// so there's nothing to clean up here first.
//
// Authorization mirrors start/route.ts's own shape (room lookup + explicit
// host check via the caller's own cookie-authenticated client) rather than
// end/route.ts's `loadSessionForTurn` helper — that helper is turn-loop
// specific and deliberately rejects any session whose `ended_at` is
// already set, which is exactly the state this route expects to find.
//
// The final write uses the caller's own client, not the admin one:
// `rooms_update_host_only` (see supabase/migrations/20260806120400_rls_
// core.sql) already lets a verified host flip their own room's status, so
// there's no RLS bypass needed here — same reasoning end/route.ts's doc
// comment gives for skipping the admin client on its own host-authorized
// write.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  let body: { roomId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { roomId } = body;
  if (typeof roomId !== "string" || roomId.length === 0) {
    return NextResponse.json({ error: "roomId (string) is required." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  // RLS-scoped read (rooms_select_any_authenticated) — same as
  // start/route.ts's equivalent lookup.
  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .select("id, status, game_id")
    .eq("id", roomId)
    .maybeSingle();

  if (roomError || !room) {
    return NextResponse.json({ error: "Room not found." }, { status: 404 });
  }
  if (room.game_id !== "who-am-i") {
    return NextResponse.json({ error: "This room isn't a Who Am I? room." }, { status: 400 });
  }
  if (room.status !== "finished") {
    return NextResponse.json({ error: "This game hasn't ended yet." }, { status: 409 });
  }

  // RLS-scoped read (players_select_room_members) — only succeeds if the
  // caller's own auth session actually has a player row in this room.
  const { data: callerPlayer, error: callerError } = await supabase
    .from("players")
    .select("id, is_host")
    .eq("room_id", roomId)
    .eq("auth_id", userData.user.id)
    .maybeSingle();

  if (callerError || !callerPlayer) {
    return NextResponse.json({ error: "You're not a member of this room." }, { status: 403 });
  }
  if (!callerPlayer.is_host) {
    return NextResponse.json({ error: "Only the host can start a new game." }, { status: 403 });
  }

  // Guarded on `status = 'finished'` so a double-submit (two "Play Again"
  // clicks) is a harmless no-op on the second call rather than a
  // conflicting write — same pattern as start/route.ts's own status-guarded
  // update.
  const { error: updateError, data: updatedRoom } = await supabase
    .from("rooms")
    .update({ status: "lobby" })
    .eq("id", roomId)
    .eq("status", "finished")
    .select("id")
    .maybeSingle();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }
  if (!updatedRoom) {
    return NextResponse.json({ error: "This game hasn't ended yet." }, { status: 409 });
  }

  return NextResponse.json({ ok: true });
}
