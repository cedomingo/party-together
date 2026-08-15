// GameConfig for "Who Are You?" — see /lib/games-registry.ts for the shape
// and how this gets wired into the platform.
//
// Step 2 adds LobbyOptions for the host-configurable game modes
// (WHO-ARE-YOU-SPEC.md §8): base-mode radio (Guess Everyone / Rival Match)
// plus the independent "First Win Ends Game" checkbox.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { GameConfig, GameLobbyOptionsProps } from "@/lib/games-registry";
import type { Room } from "@/lib/rooms";
import {
  DEFAULT_BASE_MODE,
  DEFAULT_FIRST_WIN_ENDS,
  type WhoAreYouBaseMode,
} from "@/games/who-are-you/logic/sessionState";

/** Shape of this game's opaque `LobbyOptions`/`onStart` options value. */
export interface WhoAreYouLobbyOptions {
  baseMode: WhoAreYouBaseMode;
  firstWinEnds: boolean;
}

const DEFAULT_LOBBY_OPTIONS: WhoAreYouLobbyOptions = {
  baseMode: DEFAULT_BASE_MODE,
  firstWinEnds: DEFAULT_FIRST_WIN_ENDS,
};

export const whoAreYouConfig: GameConfig = {
  id: "who-are-you",
  displayName: "Who Are You?",
  description:
    "Everyone secretly picks a character. Ask yes/no questions to figure out who everyone else picked — before they figure out you.",
  minPlayers: 2,
  maxPlayers: 12,
  thumbnailPath: "/characters/who-am-i/thumbnail.png",
  onStart: startWhoAreYouGame,
  LobbyOptions: WhoAreYouLobbyOptions,
  defaultLobbyOptions: DEFAULT_LOBBY_OPTIONS,
};

/**
 * Host-only lobby controls (WHO-ARE-YOU-SPEC.md §8):
 *   - Base mode radio: Guess Everyone (default) vs Rival Match
 *   - Independent "First Win Ends Game" checkbox layered on either
 */
function WhoAreYouLobbyOptions({ value, onChange }: GameLobbyOptionsProps) {
  const options = (value as WhoAreYouLobbyOptions | undefined) ?? DEFAULT_LOBBY_OPTIONS;

  return (
    <div className="who-are-you-lobby-options">
      <fieldset className="field">
        <legend>Win condition</legend>
        <label className="field field-checkbox">
          <input
            type="radio"
            name="who-are-you-base-mode"
            checked={options.baseMode === "guess-everyone"}
            onChange={() =>
              onChange({ ...options, baseMode: "guess-everyone" } satisfies WhoAreYouLobbyOptions)
            }
          />
          <span>Guess Everyone</span>
          <span className="muted"> — correctly guess every other player</span>
        </label>
        <label className="field field-checkbox">
          <input
            type="radio"
            name="who-are-you-base-mode"
            checked={options.baseMode === "rival-match"}
            onChange={() =>
              onChange({ ...options, baseMode: "rival-match" } satisfies WhoAreYouLobbyOptions)
            }
          />
          <span>Rival Match</span>
          <span className="muted"> — only your assigned rival counts toward a win</span>
        </label>
      </fieldset>
      <label className="field field-checkbox">
        <input
          type="checkbox"
          checked={options.firstWinEnds}
          onChange={(e) =>
            onChange({
              ...options,
              firstWinEnds: e.target.checked,
            } satisfies WhoAreYouLobbyOptions)
          }
        />
        <span>First Win Ends Game</span>
        <span className="muted"> — off: play out the base mode&rsquo;s natural end</span>
      </label>
    </div>
  );
}

async function startWhoAreYouGame(_supabase: SupabaseClient, room: Room, options: unknown): Promise<void> {
  const lobby = (options as WhoAreYouLobbyOptions | undefined) ?? DEFAULT_LOBBY_OPTIONS;
  const response = await fetch("/api/games/who-are-you/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      roomId: room.id,
      baseMode: lobby.baseMode,
      firstWinEnds: lobby.firstWinEnds,
    }),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}) as { error?: string });
    throw new Error(payload.error ?? "Failed to start the game.");
  }
}
