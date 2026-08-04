// Landing page: lists all registered games and lets a visitor create a room.
// Reads from /lib/games-registry.ts so it automatically picks up new games —
// no game-specific code should ever be added directly to this file.
//
// Scaffolding only in Phase 0. Room creation flow, game picker UI, and the
// "Create Room" action land in the platform-core phase.

import { games } from "@/lib/games-registry";

export default function HomePage() {
  return (
    <main>
      <h1>Party Together</h1>
      <p>Play browser-based party games with friends. (Scaffolding — Phase 0)</p>
      {/* TODO(platform-core): game picker + "Create Room" CTA, per SPEC.md §7 */}
      <p>Registered games: {games.length}</p>
    </main>
  );
}
