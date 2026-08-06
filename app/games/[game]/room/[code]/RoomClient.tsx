"use client";

// Game-agnostic live room view (SPEC.md §7, §9). This is platform core —
// it renders the lobby, player list, host badge, and "Start Game" stub for
// ANY registered game. It never imports from /games/** directly — only
// from /lib/games-registry.ts, both for the GameConfig shape (display copy)
// and, once a game starts, to resolve whichever component that game
// registered for its in-room view (see `getGameRoomView` below).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  ensureAnonSession,
  getRoomByCode,
  joinRoomByCode,
  listPlayers,
  setPlayerConnected,
  startGame,
  RoomError,
  type Player,
  type Room,
} from "@/lib/rooms";
import { getGameRoomView, type GameConfig } from "@/lib/games-registry";

type LoadState = "loading" | "ready" | "not-found" | "error";

export function RoomClient({ code, gameConfig }: { code: string; gameConfig: GameConfig | undefined }) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());

  const [joinNickname, setJoinNickname] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  const [starting, setStarting] = useState(false);
  const [copyLabel, setCopyLabel] = useState("Copy invite link");

  const currentPlayer = useMemo(
    () => players.find((p) => p.auth_id === userId) ?? null,
    [players, userId]
  );
  // Resolved via the registry, not imported from /games/** directly — see
  // /lib/games-registry.ts. This is the whole point of Phase 3: this file
  // never needs to know "Who Am I?" (or any future game) exists.
  const GameRoomView = useMemo(
    () => getGameRoomView(gameConfig?.id ?? room?.game_id ?? ""),
    [gameConfig?.id, room?.game_id]
  );
  const currentPlayerIdRef = useRef<string | null>(null);
  currentPlayerIdRef.current = currentPlayer?.id ?? null;

  const refreshPlayers = useCallback(
    async (roomId: string) => {
      try {
        setPlayers(await listPlayers(supabase, roomId));
      } catch {
        // Best-effort refresh; realtime will retry on the next event.
      }
    },
    [supabase]
  );

  // ---- initial load: ensure session, fetch room + players -------------
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const uid = await ensureAnonSession(supabase);
        if (cancelled) return;
        setUserId(uid);

        const foundRoom = await getRoomByCode(supabase, code);
        if (!foundRoom) {
          if (!cancelled) setState("not-found");
          return;
        }
        if (cancelled) return;
        setRoom(foundRoom);

        const playerRows = await listPlayers(supabase, foundRoom.id);
        if (cancelled) return;
        setPlayers(playerRows);

        const mine = playerRows.find((p) => p.auth_id === uid);
        if (mine && !mine.connected) {
          await setPlayerConnected(supabase, mine.id, true).catch(() => undefined);
          if (!cancelled) {
            setPlayers((prev) => prev.map((p) => (p.id === mine.id ? { ...p, connected: true } : p)));
          }
        }

        if (!cancelled) setState("ready");
      } catch (err) {
        if (!cancelled) {
          setErrorMessage(err instanceof Error ? err.message : "Something went wrong.");
          setState("error");
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [supabase, code]);

  // ---- realtime: postgres changes for room/players ---------------------
  useEffect(() => {
    if (!room) return;

    const channel = supabase
      .channel(`room-db:${room.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "players", filter: `room_id=eq.${room.id}` },
        () => refreshPlayers(room.id)
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "rooms", filter: `id=eq.${room.id}` },
        (payload) => setRoom(payload.new as Room)
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // Intentionally keyed on room?.id, not `room` itself — `room` changes on
    // every realtime update this effect receives, which would tear down and
    // resubscribe the channel in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, room?.id, refreshPlayers]);

  // ---- presence: who's actually online right now -----------------------
  useEffect(() => {
    if (!room || !currentPlayer) return;

    const channel = supabase.channel(`room-presence:${room.id}`, {
      config: { presence: { key: currentPlayer.id } },
    });

    channel
      .on("presence", { event: "sync" }, () => {
        setOnlineIds(new Set(Object.keys(channel.presenceState())));
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({ online_at: new Date().toISOString() });
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
    // Same rationale as the effect above — keyed on ids, not the objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, room?.id, currentPlayer?.id]);

  // ---- mark disconnected on actual page-leave (best effort) ------------
  useEffect(() => {
    function handlePageHide() {
      const playerId = currentPlayerIdRef.current;
      if (!playerId) return;
      const blob = new Blob([JSON.stringify({ playerId, connected: false })], {
        type: "application/json",
      });
      navigator.sendBeacon?.("/api/presence", blob);
    }
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, []);

  async function handleJoinSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setJoining(true);
    setJoinError(null);
    try {
      const result = await joinRoomByCode(supabase, code, joinNickname);
      const freshRoom = await getRoomByCode(supabase, code);
      if (freshRoom) setRoom(freshRoom);
      await refreshPlayers(result.roomId);
    } catch (err) {
      setJoinError(err instanceof RoomError ? err.message : "Something went wrong joining the room.");
    } finally {
      setJoining(false);
    }
  }

  async function handleStartGame() {
    if (!room) return;
    setStarting(true);
    try {
      await startGame(supabase, room.id);
      const fresh = await getRoomByCode(supabase, code);
      if (fresh) setRoom(fresh);
    } catch (err) {
      setErrorMessage(err instanceof RoomError ? err.message : "Couldn't start the game.");
    } finally {
      setStarting(false);
    }
  }

  async function handleCopyLink() {
    const url = `${window.location.origin}/games/${gameConfig?.id ?? room?.game_id}/room/${code}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopyLabel("Copied!");
      setTimeout(() => setCopyLabel("Copy invite link"), 2000);
    } catch {
      setCopyLabel("Copy failed — copy manually");
    }
  }

  // ------------------------------------------------------------- render --

  if (state === "loading") {
    return (
      <main className="page">
        <p>Loading room…</p>
      </main>
    );
  }

  if (state === "not-found") {
    return (
      <main className="page">
        <h1>Room not found</h1>
        <p>No room exists for code &ldquo;{code.toUpperCase()}&rdquo;. It may have expired or never existed.</p>
        <Link href="/">Back to home</Link>
      </main>
    );
  }

  if (state === "error" || !room) {
    return (
      <main className="page">
        <h1>Something went wrong</h1>
        <p>{errorMessage ?? "Please try again."}</p>
        <Link href="/">Back to home</Link>
      </main>
    );
  }

  // Known member: show the lobby / in-progress view.
  if (currentPlayer) {
    return (
      <main className="page">
        <header className="room-header">
          <div>
            <h1>{gameConfig?.displayName ?? room.game_id}</h1>
            <p className="room-code">
              Room code: <strong>{room.code}</strong>
            </p>
          </div>
          <button type="button" onClick={handleCopyLink}>
            {copyLabel}
          </button>
        </header>

        <section aria-labelledby="players-heading">
          <h2 id="players-heading">Players ({players.length})</h2>
          <ul className="player-list">
            {players.map((p) => (
              <li key={p.id} className="player-row">
                <span
                  className={`status-dot ${onlineIds.has(p.id) || p.connected ? "online" : "offline"}`}
                  aria-hidden="true"
                />
                <span>{p.nickname}</span>
                {p.is_host && <span className="badge">Host</span>}
                {p.id === currentPlayer.id && <span className="muted">(you)</span>}
                {!p.connected && !onlineIds.has(p.id) && <span className="muted">disconnected</span>}
              </li>
            ))}
          </ul>
        </section>

        {room.status === "lobby" && (
          <section>
            {currentPlayer.is_host ? (
              <>
                <button type="button" onClick={handleStartGame} disabled={starting}>
                  {starting ? "Starting…" : "Start Game"}
                </button>
                {gameConfig && players.length < gameConfig.minPlayers && (
                  <p className="muted">
                    {gameConfig.displayName} usually wants at least {gameConfig.minPlayers} players — you
                    can still start early.
                  </p>
                )}
              </>
            ) : (
              <p className="muted">Waiting for the host to start the game…</p>
            )}
          </section>
        )}

        {room.status === "in_progress" && (
          <section>
            {/* Platform core stops here: rendering for an in-progress game is
                always resolved through the registry, never hardcoded to a
                specific game. If a game hasn't registered a room view (or
                the room's game_id is unrecognized), fall back to a plain
                status line instead of assuming any particular game exists. */}
            {gameConfig && GameRoomView ? (
              <GameRoomView
                gameConfig={gameConfig}
                room={room}
                players={players}
                currentPlayer={currentPlayer}
              />
            ) : (
              <p>
                <strong>Game started.</strong> No room view is registered for &ldquo;{room.game_id}&rdquo;.
              </p>
            )}
          </section>
        )}

        {room.status === "finished" && (
          <section>
            <p>This game has finished.</p>
          </section>
        )}

        {errorMessage && (
          <p className="field-error" role="alert">
            {errorMessage}
          </p>
        )}
      </main>
    );
  }

  // Not a member yet.
  if (room.status !== "lobby") {
    return (
      <main className="page">
        <h1>{gameConfig?.displayName ?? room.game_id}</h1>
        <p>This room has already started, and you weren&rsquo;t part of it — new players can&rsquo;t join mid-game.</p>
        <Link href="/">Back to home</Link>
      </main>
    );
  }

  return (
    <main className="page">
      <h1>Join room {room.code}</h1>
      <p className="lede">{gameConfig?.displayName ?? room.game_id}</p>
      <form className="panel-form" onSubmit={handleJoinSubmit}>
        <label className="field">
          <span>Your nickname</span>
          <input
            value={joinNickname}
            onChange={(e) => setJoinNickname(e.target.value)}
            maxLength={32}
            required
            placeholder="e.g. Riley"
            autoComplete="off"
          />
        </label>
        {joinError && (
          <p className="field-error" role="alert">
            {joinError}
          </p>
        )}
        <button type="submit" disabled={joining}>
          {joining ? "Joining…" : "Join room"}
        </button>
      </form>
    </main>
  );
}
