// Live room UI: lobby + in-progress game view for a specific room code.
// Ephemeral/dynamic — always noindex,nofollow (see `metadata` export below),
// unlike the crawlable landing page at app/games/[game]/page.tsx.
//
// Scaffolding only in Phase 0. Once the platform core exists, this page
// will:
//   - resolve the room by `code`, redirect/404 on room-not-found
//   - render the game-agnostic lobby (player list, host controls, chat)
//     from /lib/rooms while the room is in "lobby" status
//   - once status is "in_progress", hand off rendering to the registered
//     game module's room-view component (never hardcoded here — resolved
//     via /lib/games-registry.ts so this file stays game-agnostic)

import type { Metadata } from "next";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function RoomPage({
  params,
}: {
  params: Promise<{ game: string; code: string }>;
}) {
  const { game, code } = await params;

  // TODO(platform-core): resolve room by `code`, lobby/in-progress views.
  return (
    <main>
      <h1>Room {code}</h1>
      <p>Game: {game}</p>
      <p>Live room placeholder — Phase 0 scaffolding.</p>
    </main>
  );
}
