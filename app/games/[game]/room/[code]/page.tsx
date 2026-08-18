// Live room UI: lobby + in-progress game view for a specific room code.
// Ephemeral/dynamic - always noindex,nofollow (see `metadata` export below),
// unlike the crawlable landing page at app/games/[game]/page.tsx.
//
// Scaffolding only in Phase 0. Once the platform core exists, this page
// will:
//   - resolve the room by `code`, redirect/404 on room-not-found
//   - render the game-agnostic lobby (player list, host controls, chat)
//     from /lib/rooms while the room is in "lobby" status
//   - once status is "in_progress", hand off rendering to the registered
//     game module's room-view component (never hardcoded here - resolved
//     via /lib/games-registry.ts so this file stays game-agnostic)

import type { Metadata } from "next";
import { RoomClient } from "./RoomClient";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function RoomPage({
  params,
}: {
  params: Promise<{ game: string; code: string }>;
}) {
  const { game, code } = await params;

  // Room resolution, join-if-needed, and the live lobby all happen
  // client-side (see RoomClient) - reading `rooms`/`players` requires an
  // authenticated (anonymous) Supabase session, which can only be
  // established/persisted from a Client Component, Server Action, or Route
  // Handler, not a plain Server Component render.
  //
  // `game` (the URL slug) is passed down as a plain string, not a resolved
  // GameConfig - GameConfig can carry a game-specific `onStart` function
  // (see lib/games-registry.ts), and functions can't cross the Server
  // Component -> Client Component boundary. RoomClient resolves the full
  // config itself, client-side, via the registry - the same pattern
  // already used there for `getGameRoomView`.
  return <RoomClient code={code} game={game} />;
}
