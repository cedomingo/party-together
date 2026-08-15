// /games — the game listing (app/components/GamePicker.tsx + GamesListing.tsx).
// Reads the games registry so it automatically picks up new games — no
// game-specific code should ever be added directly to this file
// (SPEC.md §3, §7).
//
// Two modes, driven by the ?room=CODE query param:
//   - browse (no param): each game's cover card links to that game's
//     landing page (/games/[game]), where a room can be created for it.
//   - room swap (?room=CODE): clicking a card switches the EXISTING room
//     to that game (app/api/rooms/switch-game/route.ts — same room code,
//     same players, room back in the lobby) and redirects into its
//     waiting room.
//
// Only the bare /games listing is indexable (see app/sitemap.ts); the
// ?room= variant and the /room/[code] room pages are deliberately not —
// room pages are noindex (app/games/[game]/room/[code]/page.tsx).

import type { Metadata } from "next";
import { games, toGameSummary } from "@/lib/games-registry";
import { GamesListing } from "@/app/components/GamesListing";

export const metadata: Metadata = {
  title: "Games",
  description: "Browse browser-based party games and create a room to play with friends.",
};

export default async function GamesPage({
  searchParams,
}: {
  searchParams: Promise<{ room?: string }>;
}) {
  const { room } = await searchParams;
  // Room codes are stored/presented uppercase (lib/rooms normalizeRoomCode)
  // — normalize the query param so the header, API call, and redirect all
  // agree, whether the host's link said ?room=ABCD or ?room=abcd.
  const roomCode = room?.trim().toUpperCase() || null;

  return (
    <main className="page" id="main-content">
      {/* The page's <h1> lives inside GamesListing (app/components/
          GamesListing.tsx) so the copy-invite-link button can sit on the
          same row as the title, pinned to the far right. */}
      <GamesListing games={games.map(toGameSummary)} roomCode={roomCode} />

      {games.length === 0 && <p className="muted">No games are registered yet — nothing to play just yet.</p>}
    </main>
  );
}
