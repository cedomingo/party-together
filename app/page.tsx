// Landing page: lets a visitor create or join a room. Reads from
// /lib/games-registry.ts so it automatically picks up new games — no
// game-specific code should ever be added directly to this file
// (SPEC.md §3, §7).
//
// The create flow is shell-first: "Create a room" makes a game-less room
// (just a code) and sends the host to /games?room=CODE, where they can
// share the code and pick a game (app/components/CreateRoomShellForm.tsx +
// app/games/page.tsx). Game selection deliberately does NOT happen here —
// the games are listed on the dedicated /games page.

import Link from "next/link";
import { games } from "@/lib/games-registry";
import { RoomForms } from "@/app/components/RoomForms";

export default function HomePage() {
  return (
    <main className="page" id="main-content">
      <h1>Party Together</h1>
      <p className="lede">
        Create a room, share the code, pick a game on the <Link href="/games">games page</Link>, and
        play browser-based party games with friends.
      </p>

      <RoomForms shellCreate />

      {games.length === 0 && <p className="muted">No games are registered yet — nothing to play just yet.</p>}
    </main>
  );
}
