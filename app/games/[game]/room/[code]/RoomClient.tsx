"use client";

// Game-agnostic live room view (SPEC.md §7, §9). This is platform core —
// it renders the lobby, player list, host badge, and "Start Game" stub for
// ANY registered game. It never imports from /games/** directly — only
// from /lib/games-registry.ts, both for the GameConfig shape (display copy)
// and, once a game starts, to resolve whichever component that game
// registered for its in-room view (see `getGameRoomView` below).
//
// That resolved component is also what renders for a "finished" room, not
// just "in_progress" — the registry doesn't have (and doesn't need) a
// separate "recap view" slot per game. A game module's own room view is
// trusted to look at `room.status` / its own session state and decide what
// "in progress" vs. "finished" looks like internally (SPEC.md §8 point 7's
// recap screen, for "who-am-i"). This file stays exactly as game-agnostic
// either way — it still only ever calls into the registry.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  ensureAnonSession,
  getRoomByCode,
  listPlayers,
  setPlayerConnected,
  startGame,
  RoomError,
  type Player,
  type Room,
} from "@/lib/rooms";
import { joinRoomByCodeViaApi } from "@/lib/rooms/client";
import { getGameConfig, getGameRoomView } from "@/lib/games-registry";
import { StatusScreen } from "@/app/components/StatusScreen";
import { AvatarCreator } from "@/app/components/AvatarCreator";
import { AvatarIcon } from "@/app/components/AvatarIcon";
import { loadStoredAvatar, preloadAvatarAssets, saveStoredAvatar, type AvatarSelection } from "@/lib/avatar";

type LoadState = "loading" | "ready" | "not-found" | "error";

export function RoomClient({ code, game }: { code: string; game: string }) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  // Resolved client-side, not passed down from the Server Component page —
  // GameConfig can carry a game-specific `onStart` function (see
  // lib/games-registry.ts), and functions can't cross the Server Component
  // -> Client Component boundary. Same reasoning as `getGameRoomView` below.
  const gameConfig = useMemo(() => getGameConfig(game), [game]);

  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());

  // Lazy-initialized straight from localStorage (see lib/avatar.ts) rather
  // than the two-phase load RoomForms.tsx needs: this branch never
  // server-renders (the component starts in the "loading" state and only
  // reaches the join form after client-side data fetching), so there's no
  // SSR/first-paint markup to keep in sync with.
  const [joinAvatar, setJoinAvatar] = useState<AvatarSelection>(() => loadStoredAvatar());
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  // False until every mushroom/accessory image is preloaded (lib/avatar.ts)
  // — see the same gating in RoomForms.tsx. Kicked off unconditionally on
  // mount (not only once the join form is actually reached) so the assets
  // have as much of a head start as possible against the room lookup this
  // component is also doing.
  const [avatarAssetsReady, setAvatarAssetsReady] = useState(false);

  useEffect(() => {
    saveStoredAvatar(joinAvatar);
  }, [joinAvatar]);

  useEffect(() => {
    let cancelled = false;
    preloadAvatarAssets().then(() => {
      if (!cancelled) setAvatarAssetsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const [starting, setStarting] = useState(false);
  const [copyLabel, setCopyLabel] = useState("Copy invite link");

  // Opaque host-set lobby config for whichever game is active (e.g. "Who Am
  // I?"'s win-condition checkbox) — see GameConfig.LobbyOptions/
  // defaultLobbyOptions/onStart in lib/games-registry.ts. RoomClient never
  // looks inside this value, just seeds/threads it through.
  const [lobbyOptions, setLobbyOptions] = useState<unknown>(gameConfig?.defaultLobbyOptions);
  useEffect(() => {
    setLobbyOptions(gameConfig?.defaultLobbyOptions);
  }, [gameConfig?.defaultLobbyOptions]);

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

  // ---- reconnect-safety net: re-sync when the tab comes back (SPEC.md
  // §11 "reconnect-safe: refreshing the page mid-game should not lose a
  // player's state") -------------------------------------------------
  // A full page refresh already rehydrates everything correctly (see the
  // initial-load effect above — it reads room/players straight from
  // Postgres on every mount). This effect covers the *other* half of
  // "reconnect-safe": a phone locked/backgrounded for a while, or a laptop
  // waking from sleep, doesn't unmount this component at all — React state
  // and the existing Realtime channels just sit there, and mobile OSes in
  // particular are known to silently drop idle WebSocket connections
  // without the app ever seeing a clean close event. Rather than trust
  // that Realtime always reconnects (supabase-js does retry, but "does
  // retry" isn't the same guarantee as "definitely already has"), treat
  // becoming visible/online again as a cheap cue to reconcile straight
  // from Postgres: re-fetch room + players and, if this session's own row
  // had fallen out of `connected`, flip it back — the same
  // source-of-truth read the initial load already trusts, just re-run
  // without a full reload.
  const userIdRef = useRef<string | null>(null);
  userIdRef.current = userId;

  useEffect(() => {
    if (!room) return;
    let inFlight = false;

    async function resync() {
      if (inFlight) return;
      inFlight = true;
      try {
        const [freshRoom, playerRows] = await Promise.all([
          getRoomByCode(supabase, code),
          listPlayers(supabase, room!.id),
        ]);
        if (freshRoom) setRoom(freshRoom);
        setPlayers(playerRows);

        const mine = playerRows.find((p) => p.auth_id === userIdRef.current);
        if (mine && !mine.connected) {
          await setPlayerConnected(supabase, mine.id, true).catch(() => undefined);
          setPlayers((prev) => prev.map((p) => (p.id === mine.id ? { ...p, connected: true } : p)));
        }
      } catch {
        // Best-effort — the Realtime subscriptions and the next natural
        // resync attempt are the backstop; don't surface a transient
        // background-refresh failure as a user-facing error.
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
    // Keyed on room?.id, not `room` — same rationale as the postgres-changes
    // effect above: `room` changes on every resync, which would otherwise
    // tear down and re-add these listeners in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, code, room?.id]);

  async function handleJoinSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setJoining(true);
    setJoinError(null);
    try {
      const result = await joinRoomByCodeViaApi(code, joinAvatar.name, joinAvatar.mushroomIndex, joinAvatar.accessoryIndex);
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
    setErrorMessage(null);
    try {
      // Games can register their own start behavior (see GameConfig.onStart
      // in lib/games-registry.ts) — e.g. "Who Am I?" needs to assign
      // characters as part of starting. This file never needs to know that;
      // it just calls whatever the registry handed back, or falls back to
      // the generic core stub for games that don't need anything special.
      if (gameConfig?.onStart) {
        await gameConfig.onStart(supabase, room, lobbyOptions);
      } else {
        await startGame(supabase, room.id);
      }
      const fresh = await getRoomByCode(supabase, code);
      if (fresh) setRoom(fresh);
    } catch (err) {
      setErrorMessage(
        err instanceof RoomError || err instanceof Error ? err.message : "Couldn't start the game."
      );
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
  // Every non-happy-path below (loading, room-not-found, room-full,
  // room-already-started, generic error) renders through the shared
  // <StatusScreen> so they're visually and semantically consistent
  // (SPEC.md §11).

  if (state === "loading") {
    return <StatusScreen kind="loading" title="Loading room…" showHomeLink={false} />;
  }

  if (state === "not-found") {
    return (
      <StatusScreen kind="info" title="Room not found">
        <p>
          No room exists for code &ldquo;{code.toUpperCase()}&rdquo;. It may have expired or never
          existed.
        </p>
      </StatusScreen>
    );
  }

  if (state === "error" || !room) {
    return (
      <StatusScreen kind="error" title="Something went wrong">
        <p>{errorMessage ?? "Please try again."}</p>
      </StatusScreen>
    );
  }

  // Known member: show the lobby / in-progress view.
  if (currentPlayer) {
    // Once a game is in progress (or finished), that game's own room-view
    // component owns the full page presentation — including its own header
    // and player roster (e.g. WhoAmIRoomView's top bar with the round/turn
    // status and the player-avatar row) — so platform core's generic
    // "Who Am I?" title + room-code/copy-link header and the flat
    // Players (N) list only render during the lobby, before a GameRoomView
    // exists to take over.
    const isLobby = room.status === "lobby";

    return (
      <main className="page" id="main-content">
        {isLobby && (
          <>
            <header className="room-header">
              <div>
                <h1>{gameConfig?.displayName ?? room.game_id}</h1>
                <p className="room-code">
                  Room code: <strong>{room.code}</strong>
                </p>
              </div>
              <button type="button" onClick={handleCopyLink} aria-live="polite">
                {copyLabel}
              </button>
            </header>

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
                    {p.id === currentPlayer.id && <span className="muted">(you)</span>}
                    {!p.connected && !onlineIds.has(p.id) && <span className="muted">disconnected</span>}
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}

        {room.status === "lobby" && (
          <section>
            {currentPlayer.is_host ? (
              <>
                {gameConfig?.LobbyOptions && (
                  <gameConfig.LobbyOptions
                    players={players}
                    value={lobbyOptions}
                    onChange={setLobbyOptions}
                  />
                )}
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

        {(room.status === "in_progress" || room.status === "finished") && (
          <section>
            {/* Platform core stops here: rendering for an in-progress OR
                finished game is always resolved through the registry, never
                hardcoded to a specific game. A game's own room-view
                component decides internally what to show for each status —
                for "who-am-i" that means the turn loop / board while
                `room.status` is "in_progress", and the recap once its
                session has ended (which is also when `room.status` flips to
                "finished" — see app/api/games/who-am-i/_lib/turnSession.ts's
                `endGameSession`). If a game hasn't registered a room view
                (or the room's game_id is unrecognized), fall back to a plain
                status line instead of assuming any particular game exists. */}
            {gameConfig && GameRoomView ? (
              <GameRoomView
                gameConfig={gameConfig}
                room={room}
                players={players}
                currentPlayer={currentPlayer}
                onlineIds={onlineIds}
              />
            ) : (
              <p>
                <strong>{room.status === "finished" ? "Game finished." : "Game started."}</strong> No
                room view is registered for &ldquo;{room.game_id}&rdquo;.
              </p>
            )}
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
      <StatusScreen kind="info" title={gameConfig?.displayName ?? room.game_id}>
        <p>
          This room has already started, and you weren&rsquo;t part of it — new players can&rsquo;t
          join mid-game.
        </p>
      </StatusScreen>
    );
  }

  // Room-full (SPEC.md §7 host-set max_players cap; §11 room-full error
  // state). Checked here — before rendering the join form at all — for
  // anyone landing on the room link who isn't already a member; an
  // existing member is always handled by the branch above instead (a room
  // filling up after you joined never locks you out of your own slot).
  // This is a friendly pre-check only: the actual submit still goes
  // through `joinRoomByCode` (see lib/rooms/index.ts), which re-checks
  // server-side and surfaces the same message if this got stale between
  // page-load and submit (e.g. two people opening the link at once).
  const isRoomFull = room.max_players != null && players.length >= room.max_players;
  if (isRoomFull) {
    return (
      <StatusScreen kind="info" title="Room is full">
        <p>
          {gameConfig?.displayName ?? room.game_id} — room <strong>{room.code}</strong> already has its
          maximum of {room.max_players} player{room.max_players === 1 ? "" : "s"}. Ask the host to open a
          new room, or check back if someone might drop.
        </p>
      </StatusScreen>
    );
  }

  return (
    <main className="page" id="main-content">
      <h1>Join room {room.code}</h1>
      <p className="lede">{gameConfig?.displayName ?? room.game_id}</p>

      <AvatarCreator
        name={joinAvatar.name}
        onNameChange={(name) => setJoinAvatar((a) => ({ ...a, name }))}
        mushroomIndex={joinAvatar.mushroomIndex}
        onMushroomIndexChange={(mushroomIndex) => setJoinAvatar((a) => ({ ...a, mushroomIndex }))}
        accessoryIndex={joinAvatar.accessoryIndex}
        onAccessoryIndexChange={(accessoryIndex) => setJoinAvatar((a) => ({ ...a, accessoryIndex }))}
        assetsReady={avatarAssetsReady}
      />

      <form className="panel-form" onSubmit={handleJoinSubmit}>
        {joinError && (
          <p className="field-error" role="alert">
            {joinError}
          </p>
        )}
        <button type="submit" disabled={joining || !joinAvatar.name.trim() || !avatarAssetsReady}>
          {joining ? "Joining…" : avatarAssetsReady ? "Join room" : "Loading avatar…"}
        </button>
      </form>
    </main>
  );
}
