// Landing page: lists all registered games and lets a visitor create or
// join a room. Reads from /lib/games-registry.ts so it automatically picks
// up new games — no game-specific code should ever be added directly to
// this file (SPEC.md §3, §7).

import { games, toGameSummary } from "@/lib/games-registry";
import { CreateRoomForm } from "@/app/components/CreateRoomForm";
import { JoinRoomForm } from "@/app/components/JoinRoomForm";

export default function HomePage() {
  return (
    <main className="page">
      <h1>Party Together</h1>
      <p className="lede">Create a room, share the link, and play browser-based party games with friends.</p>

      <div className="two-up">
        <CreateRoomForm games={games.map(toGameSummary)} />
        <JoinRoomForm />
      </div>

      {games.length === 0 && <p className="muted">No games are registered yet — nothing to play just yet.</p>}
    </main>
  );
}
