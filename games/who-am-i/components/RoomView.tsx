"use client";

// "Who Am I?" in-room view — Setup & Board phase only (SPEC.md §8 "Setup").
// This is what the platform core (RoomClient) hands rendering off to once a
// room's status is "in_progress" and its game_id resolves to "who-am-i" —
// see /lib/games-registry.ts's `getGameRoomView`. Character assignment
// itself already happened before the room ever reached this status (see
// GameConfig.onStart in ../config.ts + app/api/games/who-am-i/start), so
// this component's only job is: load the 25-character roster, load the
// caller's own board state, and render a tappable grid with local
// cross-off state.
//
// Deliberately NOT implemented here (that's SPEC.md §8 "Turn Loop", the
// next game-module phase): question submission, sequential answering,
// "I'm Done", guessing, turn order, the public question log.
//
// The "can never see my own character" rule isn't re-implemented here —
// it's already enforced upstream, at the RLS/query level, by the
// `who_am_i_board` view (supabase/migrations/
// ..._who_am_i_identity_protection.sql): that view always nulls out
// character_id for the caller's own row, and there is no SELECT grant on
// the underlying who_am_i_assignments table at all, so there is no query
// this component could run — buggy or not — that would ever return the
// caller's own character_id. This component just never asks for it: the
// board only needs `crossed_off_character_ids` from that row, never
// `character_id`.

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { GameRoomViewProps } from "@/lib/games-registry";

interface CharacterRow {
  id: string;
  name: string;
  image_url: string;
}

interface OwnBoardRow {
  session_id: string;
  player_id: string;
  crossed_off_character_ids: string[] | null;
}

type LoadState = "loading" | "ready" | "not-started" | "no-assignment" | "error";

export function WhoAmIRoomView({ room, currentPlayer }: GameRoomViewProps) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [characters, setCharacters] = useState<CharacterRow[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [crossedOff, setCrossedOff] = useState<Set<string>>(new Set());

  // ---- initial load: roster + this session's own (masked) board row -----
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        // Global roster (characters_select_active RLS policy — readable by
        // anyone). Alphabetical so the board layout is stable/predictable
        // across reloads rather than shuffling on every fetch.
        const { data: charRows, error: charError } = await supabase
          .from("characters")
          .select("id, name, image_url")
          .eq("active", true)
          .order("name", { ascending: true });
        if (charError) throw new Error(charError.message);
        if (cancelled) return;
        setCharacters((charRows ?? []) as CharacterRow[]);

        // Most recent "who-am-i" session for this room (game_sessions_
        // select_room_members RLS policy — readable by any room member).
        const { data: sessionRow, error: sessionError } = await supabase
          .from("game_sessions")
          .select("id")
          .eq("room_id", room.id)
          .eq("game_id", "who-am-i")
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (sessionError) throw new Error(sessionError.message);

        if (!sessionRow) {
          if (!cancelled) setState("not-started");
          return;
        }
        if (cancelled) return;
        setSessionId(sessionRow.id as string);

        // The masking view — see file header. Selects only the columns we
        // actually need; character_id is never requested, so there's no
        // path (buggy or not) where this component could surface it.
        const { data: boardRow, error: boardError } = await supabase
          .from("who_am_i_board")
          .select("session_id, player_id, crossed_off_character_ids")
          .eq("session_id", sessionRow.id)
          .eq("player_id", currentPlayer.id)
          .maybeSingle();
        if (boardError) throw new Error(boardError.message);

        if (cancelled) return;
        if (!boardRow) {
          // Joined after this session's assignment ran (e.g. connected
          // after the host started the game) — no character was assigned
          // to them this round.
          setState("no-assignment");
          return;
        }

        setCrossedOff(new Set((boardRow as OwnBoardRow).crossed_off_character_ids ?? []));
        setState("ready");
      } catch (err) {
        if (!cancelled) {
          setErrorMessage(err instanceof Error ? err.message : "Failed to load the board.");
          setState("error");
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [supabase, room.id, currentPlayer.id]);

  // ---- persist cross-off state on our own row, best-effort --------------
  const persistCrossedOff = useCallback(
    async (next: Set<string>) => {
      if (!sessionId) return;
      // Column-level UPDATE grant + who_am_i_assignments_update_own_row RLS
      // policy — a player can write their own crossed_off_character_ids,
      // nothing else, on their own row only. No `.select()` chained, so
      // this never needs (and never gets) SELECT on the base table.
      const { error } = await supabase
        .from("who_am_i_assignments")
        .update({ crossed_off_character_ids: Array.from(next) })
        .eq("session_id", sessionId)
        .eq("player_id", currentPlayer.id);
      if (error) {
        // Non-fatal: local state already reflects the tap, and the next
        // toggle re-sends the full set anyway. Reconnect-safety (SPEC.md
        // §11) is best-effort here, not blocking.
        console.error("Failed to save crossed-off state:", error.message);
      }
    },
    [supabase, sessionId, currentPlayer.id]
  );

  function toggleCharacter(characterId: string) {
    setCrossedOff((prev) => {
      const next = new Set(prev);
      if (next.has(characterId)) {
        next.delete(characterId);
      } else {
        next.add(characterId);
      }
      void persistCrossedOff(next);
      return next;
    });
  }

  // ------------------------------------------------------------- render --

  if (state === "loading") {
    return <p className="muted">Loading your board…</p>;
  }

  if (state === "not-started") {
    return <p className="muted">Setting up the game…</p>;
  }

  if (state === "error") {
    return (
      <p className="field-error" role="alert">
        {errorMessage ?? "Something went wrong loading the board."}
      </p>
    );
  }

  const remaining = characters.length - crossedOff.size;

  return (
    <section aria-labelledby="who-am-i-board-heading" className="who-am-i-board">
      <h2 id="who-am-i-board-heading">Who Am I?</h2>
      {state === "no-assignment" ? (
        <p className="muted">
          You joined after this round started, so you weren&rsquo;t assigned a character — you can
          still use the board to help others narrow things down.
        </p>
      ) : (
        <p className="muted">
          Everyone else can see your secret character — you can&rsquo;t. Tap a character to cross
          it off as you rule it out. {remaining} of {characters.length} left.
        </p>
      )}

      <ul className="who-am-i-grid" role="list">
        {characters.map((character) => {
          const isCrossedOff = crossedOff.has(character.id);
          return (
            <li key={character.id}>
              <button
                type="button"
                className={`who-am-i-card${isCrossedOff ? " crossed-off" : ""}`}
                onClick={() => toggleCharacter(character.id)}
                aria-pressed={isCrossedOff}
                aria-label={`${character.name}${isCrossedOff ? ", crossed off" : ", tap to cross off"}`}
              >
                <span className="who-am-i-card-image">
                  <Image src={character.image_url} alt="" fill sizes="96px" />
                </span>
                <span className="who-am-i-card-name">{character.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
