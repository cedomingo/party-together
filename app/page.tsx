// Landing page: lists all registered games and lets a visitor create or
// join a room. Reads from /lib/games-registry.ts so it automatically picks
// up new games — no game-specific code should ever be added directly to
// this file (SPEC.md §3, §7).

import { games, toGameSummary } from "@/lib/games-registry";
import { RoomForms } from "@/app/components/RoomForms";

export default function HomePage() {
  return (
    <main className="page" id="main-content">
      <h1>Party Together</h1>
      <p className="lede">Create a room, share the link, and play browser-based party games with friends.</p>

      <RoomForms games={games.map(toGameSummary)} />

      {games.length === 0 && <p className="muted">No games are registered yet — nothing to play just yet.</p>}
    </main>
  );
}
