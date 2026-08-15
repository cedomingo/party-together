// Host sends a finished room back to the lobby (recap "Play Again").

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

  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .select("id, status, game_id")
    .eq("id", roomId)
    .maybeSingle();

  if (roomError || !room) {
    return NextResponse.json({ error: "Room not found." }, { status: 404 });
  }
  if (room.game_id !== "who-are-you") {
    return NextResponse.json({ error: "This room isn't a Who Are You? room." }, { status: 400 });
  }
  if (room.status !== "finished") {
    return NextResponse.json({ error: "This game hasn't ended yet." }, { status: 409 });
  }

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
