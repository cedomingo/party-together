"use client";

// Game-selection card grid (cover photo + client-side search), rendered by
// the /games listing page (app/components/GamesListing.tsx). Game-agnostic:
// it just renders whatever `games` it's handed - each game as a card
// (cover from thumbnailPath, displayName, description) - and leaves the
// click behavior to the caller via `onSelect(gameId)`. The `selectedGameId`
// prop drives the selection highlight (unused today - the /games page
// navigates or switches on click - but kept so a select-in-place caller
// can highlight its pick).
//
// The search field filters cards client-side by displayName/description
// (case-insensitive substring, no server round-trip). Cards are real
// <button type="button">s so a click is keyboard- and screen-reader
// accessible, and so this component can sit inside a <form> without a
// card click accidentally submitting it.

import { useMemo, useState } from "react";
import type { GameSummary } from "@/lib/games-registry";

export function GamePicker({
  games,
  selectedGameId,
  onSelect,
}: {
  games: GameSummary[];
  /** Currently selected card id (highlight). Optional - browse mode
   * (where a click navigates away immediately) passes nothing. */
  selectedGameId?: string | null;
  onSelect: (gameId: string) => void;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return games;
    return games.filter(
      (game) =>
        game.displayName.toLowerCase().includes(q) ||
        game.description.toLowerCase().includes(q)
    );
  }, [games, query]);

  if (games.length === 0) {
    return <p className="muted">No games are registered yet - nothing to play just yet.</p>;
  }

  return (
    <div className="game-picker">
      <label className="field">
        <span>Search games</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by name or description"
          autoComplete="off"
        />
      </label>

      {filtered.length === 0 ? (
        <p className="muted">No games match &ldquo;{query.trim()}&rdquo;.</p>
      ) : (
        <ul className="game-picker-grid" role="list">
          {filtered.map((game) => {
            const selected = game.id === selectedGameId;
            return (
              <li key={game.id}>
                <button
                  type="button"
                  className={`game-picker-card${selected ? " selected" : ""}`}
                  onClick={() => onSelect(game.id)}
                  aria-pressed={selected}
                  aria-label={`${game.displayName} - ${game.description}`}
                >
                  <span className="game-picker-cover">
                    {/* Plain <img> rather than next/image on purpose: the
                        picker renders client-side from a dynamic list and
                        needs no layout shift guarantees, and the project
                        already uses plain <img> for client-rendered art
                        (AvatarIcon). */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={game.thumbnailPath} alt="" draggable={false} />
                  </span>
                  <span className="game-picker-info">
                    <span className="game-picker-name">{game.displayName}</span>
                    <span className="game-picker-desc">{game.description}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
