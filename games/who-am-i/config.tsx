// GameConfig for "Who Am I?" - see /lib/games-registry.ts for the shape
// and for how this gets wired into the platform.
//
// Metadata (id/name/description/player counts/thumbnail) plus, as of the
// Setup & Board phase (SPEC.md §8 "Setup"), `onStart`: the character
// assignment hook that runs instead of the platform core's generic
// `startGame` stub when the host presses "Start Game" in this room. Turn
// system / question log are still NOT implemented here - that's the next
// game-module phase (SPEC.md §8 "Turn Loop" / §9).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { GameConfig, GameLobbyOptionsProps } from "@/lib/games-registry";
import type { Room } from "@/lib/rooms";
import { DEFAULT_GAME_MODE, type WhoAmIGameMode } from "@/games/who-am-i/logic/turnState";

/** Shape of this game's opaque `LobbyOptions`/`onStart` options value. */
export interface WhoAmILobbyOptions {
  gameMode: WhoAmIGameMode;
}

const DEFAULT_LOBBY_OPTIONS: WhoAmILobbyOptions = { gameMode: DEFAULT_GAME_MODE };

export const whoAmIConfig: GameConfig = {
  id: "who-am-i",
  displayName: "Who Am I?",
  description:
    "Everyone can see your secret character except you. Ask yes/no questions to figure out who you are before anyone else does.",
  minPlayers: 2,
  maxPlayers: 12,
  thumbnailPath: "/ui/gamecovers/who-am-i.png",
  onStart: startWhoAmIGame,
  LobbyOptions: WhoAmILobbyOptions,
  defaultLobbyOptions: DEFAULT_LOBBY_OPTIONS,
};

/**
 * Host-only lobby control for the win-condition variant (turnState.ts
 * `WhoAmIGameMode`):
 *   - unchecked (default) = "Normal: last one standing loses" - play
 *     continues until only one player is left unsolved.
 *   - checked = "First One Out Wins?" - the first correct guess wins and
 *     ends the game immediately.
 *
 * Disabled (and forced back to the default) with 2 or fewer players in the
 * room, since the two modes collapse into the same outcome at that size -
 * see turnState.ts's `WhoAmIGameMode` doc comment. This is a UI convenience
 * only; `start/route.ts` re-derives the same clamp server-side rather than
 * trusting a client that could bypass the disabled checkbox.
 */
function WhoAmILobbyOptions({ players, value, onChange }: GameLobbyOptionsProps) {
  const options = (value as WhoAmILobbyOptions | undefined) ?? DEFAULT_LOBBY_OPTIONS;
  const tooFewPlayers = players.length <= 2;
  const checked = !tooFewPlayers && options.gameMode === "first-out-wins";

  return (
    <label className="field field-checkbox">
      <input
        type="checkbox"
        checked={checked}
        disabled={tooFewPlayers}
        onChange={(e) =>
          onChange({
            gameMode: e.target.checked ? "first-out-wins" : "last-standing-loses",
          } satisfies WhoAmILobbyOptions)
        }
      />
      <span>First One Out Wins?</span>
      {tooFewPlayers ? (
        <span className="muted"> - needs at least 3 players in the lobby</span>
      ) : (
        <span className="muted"> - off: last one standing loses</span>
      )}
    </label>
  );
}

/**
 * Randomly assigns each connected player a character (no repeats) and
 * flips the room to `in_progress`, all as one trusted server-side
 * operation - see app/api/games/who-am-i/start/route.ts for why this can't
 * go through the normal RLS-authenticated client directly
 * (who_am_i_assignments has no INSERT grant at all). Throws on any
 * failure, which RoomClient surfaces to the host and leaves the room in
 * `lobby` so they can retry.
 */
async function startWhoAmIGame(_supabase: SupabaseClient, room: Room, options: unknown): Promise<void> {
  const { gameMode } = (options as WhoAmILobbyOptions | undefined) ?? DEFAULT_LOBBY_OPTIONS;
  const response = await fetch("/api/games/who-am-i/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId: room.id, gameMode }),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}) as { error?: string });
    throw new Error(payload.error ?? "Failed to start the game.");
  }
}
