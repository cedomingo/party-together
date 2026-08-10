"use client";

// "Who Are You?" in-room view — Setup phase only (WHO-ARE-YOU-SPEC.md §3).
// This is what the platform core (RoomClient) hands rendering off to once a
// room's status is "in_progress" and its game_id resolves to "who-are-you"
// — see /lib/games-registry.ts's `getGameRoomView`. The session itself
// (turnOrder fixed, state "setup") already exists by the time this ever
// renders — see games/who-are-you/config.tsx's `onStart` +
// app/api/games/who-are-you/start/route.ts.
//
// This component's whole job, for Step 1: load the roster, find out
// whether the caller has already picked (their own `who_are_you_selections`
// row — owner-readable only, see that table's RLS), and either render the
// character-picker grid (not yet picked) or a "you picked <X>, here's who
// else is still picking" waiting screen (already picked). There is no turn
// loop, no boards, no guessing yet — WHO-ARE-YOU-SPEC.md's Step 1 build
// prompt stops "right where gameplay would begin." Step 2 will extend
// `game_sessions.state.phase` past "setup" (see
// games/who-are-you/logic/sessionState.ts) and this component will need to
// branch on that the same way WhoAmIRoomView branches on `endedAt` — not
// implemented yet.
//
// "Who's picked / still picking" (SPEC.md §3 point 4) is driven by
// `who_are_you_ready` — a narrow side table with no character_id column at
// all (see supabase/migrations/20260811000000_who_are_you_setup.sql for
// why this couldn't just be a read against who_are_you_selections itself).
// It's kept live via a plain Postgres-changes subscription, same pattern
// games/who-am-i/components/RoomView.tsx already uses for game_sessions/
// questions_log, plus the same visibilitychange/online/pageshow resync
// safety net for a backgrounded tab silently dropping its socket.
//
// Online/offline status (the "the rest of the room already does" part of
// SPEC.md §3 point 4's Presence reference) is passed down as `onlineIds`
// from RoomClient's single shared Presence channel — this component never
// opens its own.

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { AvatarIcon } from "@/app/components/AvatarIcon";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { GameRoomViewProps } from "@/lib/games-registry";
import { isWhoAreYouSessionState, type WhoAreYouSessionState } from "@/games/who-are-you/logic/sessionState";

interface CharacterRow {
  id: string;
  name: string;
  image_url: string;
}

/** The caller's own row — the only row who_are_you_selections' RLS ever lets this client read. */
interface OwnSelectionRow {
  session_id: string;
  player_id: string;
  character_id: string;
}

type LoadState = "loading" | "ready" | "not-started" | "error";

export function WhoAreYouRoomView({ room, players, currentPlayer, onlineIds }: GameRoomViewProps) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [characters, setCharacters] = useState<CharacterRow[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  // Not read yet in Step 1 (there's no "turns" phase to branch on until
  // Step 2 extends the state machine) — kept so the initial-load effect
  // already has the write-side of this in place for when that lands.
  const [, setSessionState] = useState<WhoAreYouSessionState | null>(null);
  const [ownSelection, setOwnSelection] = useState<OwnSelectionRow | null>(null);
  const [readyPlayerIds, setReadyPlayerIds] = useState<Set<string>>(new Set());

  // ---- character picker draft (not locked in yet) ------------------------
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // ---- initial load: roster + this session + caller's own pick (if any),
  // plus the room-wide ready list ------------------------------------------
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        // Global roster (characters_select_active RLS policy — readable by
        // anyone). Alphabetical, same as who-am-i's board, so layout is
        // stable across reloads instead of shuffling on every fetch.
        const { data: charRows, error: charError } = await supabase
          .from("characters")
          .select("id, name, image_url")
          .eq("active", true)
          .order("name", { ascending: true });
        if (charError) throw new Error(charError.message);
        if (cancelled) return;
        setCharacters((charRows ?? []) as CharacterRow[]);

        // Most recent "who-are-you" session for this room
        // (game_sessions_select_room_members RLS policy — readable by any
        // room member).
        const { data: sessionRow, error: sessionError } = await supabase
          .from("game_sessions")
          .select("id, state")
          .eq("room_id", room.id)
          .eq("game_id", "who-are-you")
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
        setSessionState(isWhoAreYouSessionState(sessionRow.state) ? sessionRow.state : null);

        // Owner-only read (who_are_you_selections_select_own_row RLS
        // policy) — this can only ever come back with the CALLER's own
        // row, or nothing if they haven't picked yet. There's no query
        // this component could run, buggy or not, that would return
        // another player's character_id — see that table's migration.
        const { data: selectionRow, error: selectionError } = await supabase
          .from("who_are_you_selections")
          .select("session_id, player_id, character_id")
          .eq("session_id", sessionRow.id)
          .eq("player_id", currentPlayer.id)
          .maybeSingle();
        if (selectionError) throw new Error(selectionError.message);
        if (cancelled) return;
        setOwnSelection((selectionRow as OwnSelectionRow | null) ?? null);

        // Room-wide "who's picked" list — no character_id in this table at
        // all (who_are_you_ready_select_room_members RLS policy).
        const { data: readyRows, error: readyError } = await supabase
          .from("who_are_you_ready")
          .select("player_id")
          .eq("session_id", sessionRow.id);
        if (readyError) throw new Error(readyError.message);
        if (cancelled) return;
        setReadyPlayerIds(new Set((readyRows ?? []).map((r) => r.player_id as string)));

        setState("ready");
      } catch (err) {
        if (!cancelled) {
          setErrorMessage(err instanceof Error ? err.message : "Failed to load the game.");
          setState("error");
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [supabase, room.id, currentPlayer.id]);

  // ---- realtime: who's picked (WHO-ARE-YOU-SPEC.md §3 point 4) -----------
  useEffect(() => {
    if (!sessionId) return;

    const channel = supabase
      .channel(`who-are-you-ready:${sessionId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "who_are_you_ready", filter: `session_id=eq.${sessionId}` },
        (payload) => {
          const row = payload.new as { player_id: string };
          setReadyPlayerIds((prev) => new Set(prev).add(row.player_id));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, sessionId]);

  // ---- reconnect-safety net (SPEC.md §11) --------------------------------
  // Same rationale as WhoAmIRoomView's identically-shaped effect: a
  // backgrounded phone can silently drop the postgres_changes socket
  // without this component ever unmounting to trigger a fresh load. Just
  // re-read the ready list straight from Postgres when the tab becomes
  // visible/online again.
  useEffect(() => {
    if (!sessionId) return;
    let inFlight = false;

    async function resync() {
      if (inFlight) return;
      inFlight = true;
      try {
        const { data: readyRows } = await supabase
          .from("who_are_you_ready")
          .select("player_id")
          .eq("session_id", sessionId);
        if (readyRows) setReadyPlayerIds(new Set(readyRows.map((r) => r.player_id as string)));
      } catch {
        // Best-effort — same reasoning as WhoAmIRoomView's resync: the
        // realtime subscription is the primary path, this is just a
        // backstop.
      } finally {
        inFlight = false;
      }
    }

    function handleVisibility() {
      if (document.visibilityState === "visible") resync();
    }
    window.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("online", resync);
    window.addEventListener("pageshow", resync);
    return () => {
      window.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("online", resync);
      window.removeEventListener("pageshow", resync);
    };
  }, [supabase, sessionId]);

  // ---- "Pick for me" (WHO-ARE-YOU-SPEC.md §3 point 2) ---------------------
  // Draws from the full roster — duplicates across players are allowed
  // (§2), so this never needs to check what anyone else picked.
  const pickForMe = useCallback(() => {
    if (characters.length === 0) return;
    const index = Math.floor(Math.random() * characters.length);
    setSelectedCharacterId(characters[index]!.id);
  }, [characters]);

  // ---- "Done" — locks the pick in (WHO-ARE-YOU-SPEC.md §3 point 3) -------
  const confirmPick = useCallback(async () => {
    if (!sessionId || !selectedCharacterId) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      const { error: selectionError } = await supabase.from("who_are_you_selections").insert({
        session_id: sessionId,
        player_id: currentPlayer.id,
        character_id: selectedCharacterId,
      });
      if (selectionError) {
        // Duplicate-key (23505) means a previous attempt already went
        // through (e.g. the ready-row insert below failed and the player
        // retried) — that's fine, keep going rather than surfacing an
        // error for an already-successful pick.
        if (selectionError.code !== "23505") throw new Error(selectionError.message);
      }

      const { error: readyError } = await supabase.from("who_are_you_ready").insert({
        session_id: sessionId,
        player_id: currentPlayer.id,
      });
      if (readyError && readyError.code !== "23505") throw new Error(readyError.message);

      setOwnSelection({ session_id: sessionId, player_id: currentPlayer.id, character_id: selectedCharacterId });
      setReadyPlayerIds((prev) => new Set(prev).add(currentPlayer.id));
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : "Failed to lock in your pick.");
    } finally {
      setConfirming(false);
    }
  }, [supabase, sessionId, selectedCharacterId, currentPlayer.id]);

  if (state === "loading") {
    return <p className="muted">Loading your character…</p>;
  }
  if (state === "not-started") {
    return <p className="muted">Setting up the game…</p>;
  }
  if (state === "error") {
    return (
      <p className="field-error" role="alert">
        {errorMessage ?? "Something went wrong loading the game."}
      </p>
    );
  }

  const pickedCharacter = ownSelection
    ? (characters.find((c) => c.id === ownSelection.character_id) ?? null)
    : null;
  const allPicked = players.length > 0 && players.every((p) => readyPlayerIds.has(p.id));

  return (
    <div className="who-are-you-shell">
      <header className="who-am-i-topbar">
        <div className="who-am-i-topbar-left">
          <AvatarIcon
            mushroomIndex={currentPlayer.mushroom_index}
            accessoryIndex={currentPlayer.accessory_index}
            size={40}
          />
          <div className="who-am-i-topbar-left-info">
            <strong>{currentPlayer.nickname}</strong>
            <span className="muted">Who Are You?</span>
          </div>
        </div>
      </header>

      {ownSelection ? (
        <section className="who-are-you-waiting" aria-labelledby="who-are-you-waiting-heading">
          <h2 id="who-are-you-waiting-heading">You picked {pickedCharacter?.name ?? "your character"}</h2>
          {pickedCharacter && (
            <div className="who-are-you-picked-card">
              <span className="who-am-i-card-image">
                <Image src={pickedCharacter.image_url} alt="" fill sizes="96px" />
              </span>
              <span className="who-am-i-card-name">{pickedCharacter.name}</span>
            </div>
          )}
          <p className="muted">Your pick is locked in and secret from everyone else until they guess it.</p>

          {allPicked ? (
            <p className="who-are-you-all-ready" role="status">
              Everyone&rsquo;s picked! The turn loop isn&rsquo;t built yet — hang tight.
            </p>
          ) : (
            <>
              <h3>Still picking</h3>
              <ul className="player-list">
                {players.map((p) => {
                  const isReady = readyPlayerIds.has(p.id);
                  return (
                    <li key={p.id} className="player-row">
                      <AvatarIcon
                        mushroomIndex={p.mushroom_index}
                        accessoryIndex={p.accessory_index}
                        size={32}
                        wiggle={false}
                      />
                      <span
                        className={`who-are-you-ready-dot${isReady ? " ready" : ""}`}
                        aria-hidden="true"
                      />
                      <span>{p.nickname}</span>
                      {p.id === currentPlayer.id && <span className="muted">(you)</span>}
                      {!isReady && (
                        <span className="muted">
                          {onlineIds.has(p.id) || p.connected ? "picking…" : "offline"}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      ) : (
        <section className="who-are-you-picker" aria-labelledby="who-are-you-picker-heading">
          <div className="who-am-i-deck-header">
            <div>
              <h2 id="who-are-you-picker-heading">Pick your character</h2>
              <p className="muted">Everyone else will try to guess who you picked. Choose wisely.</p>
            </div>
            <div className="who-am-i-deck-header-actions">
              <button type="button" onClick={pickForMe} disabled={confirming}>
                Pick for me
              </button>
            </div>
          </div>

          {confirmError && (
            <p className="field-error" role="alert">
              {confirmError}
            </p>
          )}

          <div className="who-am-i-deck-board">
            <ul className="who-am-i-grid" role="list">
              {characters.map((character) => {
                const isSelected = selectedCharacterId === character.id;
                return (
                  <li key={character.id}>
                    <button
                      type="button"
                      className={`who-am-i-card${isSelected ? " selected" : ""}`}
                      onClick={() => setSelectedCharacterId(character.id)}
                      aria-pressed={isSelected}
                      aria-label={`${character.name}${isSelected ? ", selected" : ", tap to select"}`}
                      disabled={confirming}
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
          </div>

          <div className="who-am-i-done-cta">
            <button type="button" onClick={confirmPick} disabled={!selectedCharacterId || confirming}>
              {confirming ? "Locking in…" : "Done"}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
