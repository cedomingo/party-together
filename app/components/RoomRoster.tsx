"use client";

// Shared lobby roster — the "Players (N)" section with avatar, online/
// offline status dot, host badge, "(you)" marker, and disconnected note.
// Used by RoomClient (the game room's lobby) and GamesListing (the
// /games?room=CODE waiting room) so both render the exact same markup and
// CSS (.player-list / .player-row / .status-dot / .badge — see globals.css)
// instead of two divergent copies of the same concept.

import { AvatarIcon } from "@/app/components/AvatarIcon";
import type { Player } from "@/lib/rooms";

export function RoomRoster({
  players,
  onlineIds,
  currentPlayerId,
}: {
  players: Player[];
  /** Player ids currently tracked online by the room-presence channel. */
  onlineIds: Set<string>;
  /** This session's own player row id, if a member — drives the "(you)" marker. */
  currentPlayerId: string | null;
}) {
  return (
    <section aria-labelledby="players-heading">
      <h2 id="players-heading">Players ({players.length})</h2>
      <ul className="player-list">
        {players.map((p) => (
          <li key={p.id} className="player-row">
            <AvatarIcon
              mushroomIndex={p.mushroom_index}
              accessoryIndex={p.accessory_index}
              size={36}
              wiggle={false}
            />
            <span
              className={`status-dot ${onlineIds.has(p.id) || p.connected ? "online" : "offline"}`}
              aria-hidden="true"
            />
            <span>{p.nickname}</span>
            {p.is_host && <span className="badge">Host</span>}
            {p.id === currentPlayerId && <span className="muted">(you)</span>}
            {!p.connected && !onlineIds.has(p.id) && <span className="muted">disconnected</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
