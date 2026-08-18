"use client";

// The /games listing page's interactive half (server page: app/games/page.tsx).
//
// browse mode (no `roomCode`): renders the shared <GamePicker>; clicking a
// card creates a room for that game on the spot - using the saved
// avatar/name (lib/avatar.ts localStorage) - and goes straight to the
// room. The per-game landing page (/games/[game], with its avatar creator
// and Create form) still exists for direct/SEO visits but is skipped here.
//
// room mode (?room=CODE): this page IS the room's pre-game waiting room -
// the room may be a game-less shell (just created on the home page) or a
// finished room being swapped to a new game. It shows the room code +
// copy-invite-link button, a LIVE player roster (the same <RoomRoster>
// markup/CSS RoomClient's lobby uses, driven by the same realtime/presence
// channels), and the game picker. Clicking a game card switches the room to
// that game (app/api/rooms/switch-game/route.ts - host-only) and redirects
// into its waiting room. Phase D gates this behind an avatar-first join
// flow for non-members; Phase E auto-redirects members when the host picks.
//
// Either way, clicking a game swaps the whole listing for the shared
// loading screen (embedded <StatusScreen>) BEFORE the create/switch
// request goes out - the user gets instant "something is happening"
// feedback instead of a dead wait on the grid. On failure the state
// clears and the game list (with the error) comes right back.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  ensureAnonSession,
  getRoomByCode,
  listPlayers,
  setPlayerConnected,
  touchPlayerSeen,
  LOBBY_SWEEP_INTERVAL_MS,
  PLAYER_HEARTBEAT_MS,
  RoomError,
  type Player,
  type Room,
} from "@/lib/rooms";
import { createRoomViaApi, joinRoomByCodeViaApi } from "@/lib/rooms/client";
import { GamePicker } from "@/app/components/GamePicker";
import { RoomRoster } from "@/app/components/RoomRoster";
import { StatusScreen } from "@/app/components/StatusScreen";
import { AvatarCreator } from "@/app/components/AvatarCreator";
import {
  loadStoredAvatar,
  preloadAvatarAssets,
  saveStoredAvatar,
  type AvatarSelection,
} from "@/lib/avatar";
import type { GameSummary } from "@/lib/games-registry";

type LoadState = "idle" | "loading" | "ready" | "not-found" | "error";

export function GamesListing({
  games,
  roomCode,
}: {
  games: GameSummary[];
  /** Set when the page was opened as /games?room=CODE (waiting-room mode). */
  roomCode?: string | null;
}) {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  // ---- waiting-room state (room mode only) ------------------------------
  const [loadState, setLoadState] = useState<LoadState>(roomCode ? "loading" : "idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());

  // ---- game-selection / invite state (shared) ---------------------------
  // Which game's card was clicked and is now mid-launch (create in browse
  // mode, switch in room mode). Non-null swaps the whole listing for the
  // loading screen below and blocks double-clicks; it stays set until the
  // redirect succeeds (navigation unmounts this component) or the request
  // fails (cleared in the catch below).
  const [launchingGameId, setLaunchingGameId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Same copy-invite-link pattern as RoomClient.tsx's handleCopyLink/
  // copyLabel (label flips to confirm for a couple of seconds) - mirrored
  // here rather than extracted because the URL differs (/games?room=CODE
  // now, the room URL there) and the two are deliberately kept in sync.
  const [copyLabel, setCopyLabel] = useState("Copy invite link");

  // ---- avatar-first join gate (non-members only) ------------------------
  // Mirrors RoomClient.tsx's non-member join flow exactly: AvatarCreator
  // first (name + look, localStorage-backed via lib/avatar.ts), then a
  // "Join Room" action. The host (already a member) and any other member
  // never see this - only unknown visitors to /games?room=CODE.
  const [joinAvatar, setJoinAvatar] = useState<AvatarSelection>(() => loadStoredAvatar());
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  // False until every mushroom/accessory image is preloaded (lib/avatar.ts)
  // - see the same gating in RoomClient.tsx.
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

  const currentPlayer = useMemo(
    () => (userId ? players.find((p) => p.auth_id === userId) ?? null : null),
    [players, userId]
  );

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

  // ---- initial load: ensure session, fetch room + players ---------------
  useEffect(() => {
    const code = roomCode;
    if (!code) return;
    let cancelled = false;

    async function load(code: string) {
      try {
        const uid = await ensureAnonSession(supabase);
        if (cancelled) return;
        setUserId(uid);

        const foundRoom = await getRoomByCode(supabase, code);
        if (!foundRoom) {
          if (!cancelled) setLoadState("not-found");
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

        if (!cancelled) setLoadState("ready");
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Something went wrong.");
          setLoadState("error");
        }
      }
    }

    load(code);
    return () => {
      cancelled = true;
    };
  }, [supabase, roomCode]);

  // ---- realtime: postgres changes for room/players ----------------------
  // Same channel RoomClient uses: players for the live roster, rooms for
  // game_id/status changes (Phase E watches the rooms side for the
  // auto-redirect once the host picks a game).
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
        (payload) => {
          const next = payload.new as Room;
          const prevGameId = gameIdRef.current;
          setRoom(next);
          // Phase E: when the host picks a game (game_id null → value) or
          // switches to a different one (Play More Games), follow along -
          // every member on this page lands in the new game's waiting room
          // without a refresh.
          if (next.game_id && next.game_id !== prevGameId) {
            router.push(`/games/${next.game_id}/room/${room.code}`);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // Intentionally keyed on room?.id, not `room` itself - `room` changes on
    // every realtime update this effect receives, which would tear down and
    // resubscribe the channel in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, room?.id, refreshPlayers]);

  // ---- presence: who's actually online right now ------------------------
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
    // Same rationale as the effect above - keyed on ids, not the objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, room?.id, currentPlayer?.id]);

  // ---- heartbeat: keep last_seen_at fresh -------------------------------
  // The stale-player sweep (lib/rooms sweepStalePlayers) removes seats that
  // have been offline past the grace window so a dead tab can't block the
  // room from starting a game (this page is the lobby for game-less rooms).
  // `connected` alone can't carry that signal (pagehide flips it false the
  // instant a tab is backgrounded), so the room pages heartbeat
  // `last_seen_at` here instead. Best-effort: a missed ping just makes the
  // sweep see an older timestamp.
  useEffect(() => {
    const playerId = currentPlayer?.id;
    if (!playerId) return;
    const ping = () => {
      touchPlayerSeen(supabase, playerId).catch(() => undefined);
    };
    ping();
    const timer = setInterval(ping, PLAYER_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [supabase, currentPlayer?.id]);

  // ---- lobby sweep: drop seats offline past the grace window ------------
  // Runs while the room is still in the lobby so the roster (and any
  // player-count gates) reflects who's actually here without waiting for
  // the game-start routes' authoritative sweep. Any member can trigger it -
  // it's idempotent and cheap. Stops once the room leaves the lobby.
  useEffect(() => {
    if (!room || room.status !== "lobby") return;
    const sweep = () => {
      fetch("/api/rooms/sweep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId: room.id }),
      }).catch(() => undefined);
    };
    sweep();
    const timer = setInterval(sweep, LOBBY_SWEEP_INTERVAL_MS);
    return () => clearInterval(timer);
    // Keyed on ids/status, not `room` itself - same rationale as the
    // realtime effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, room?.id, room?.status]);

  // ---- mark disconnected on actual page-leave (best effort) --------------
  const currentPlayerIdRef = useRef<string | null>(null);
  currentPlayerIdRef.current = currentPlayer?.id ?? null;

  // Tracks the room's game_id across renders so the realtime handler below
  // can tell when the host picks/switches a game (Phase E auto-redirect).
  const gameIdRef = useRef<string | null>(null);
  gameIdRef.current = room?.game_id ?? null;

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

  async function handleSelect(gameId: string) {
    if (launchingGameId) return;
    // Set before any await: the render below swaps to the loading screen
    // immediately, so the player never stares at a dead grid while the
    // create/switch request is in flight.
    setLaunchingGameId(gameId);
    setError(null);
    try {
      if (!roomCode) {
        // Browse mode: create a room for this game right away with the
        // saved avatar (name/look from localStorage - there's no avatar
        // creator on this page) and go straight to the room. If no name
        // was ever saved, fall back to a plain "Player" so creation never
        // fails on a missing nickname (sanitizeNickname requires 1-32
        // chars).
        const avatar = loadStoredAvatar();
        const { code } = await createRoomViaApi({
          gameId,
          nickname: avatar.name.trim() || "Player",
          mushroomIndex: avatar.mushroomIndex,
          accessoryIndex: avatar.accessoryIndex,
        });
        router.push(`/games/${gameId}/room/${code}`);
        return;
      }

      const response = await fetch("/api/rooms/switch-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: roomCode, gameId }),
      });
      const payload = await response.json().catch(() => ({}) as { error?: string });
      if (!response.ok) throw new Error(payload.error ?? "Couldn't switch games.");
      // Same room code, same players - just a new game (and a room that's
      // back in the lobby waiting for the host to start it).
      router.push(`/games/${gameId}/room/${roomCode}`);
    } catch (err) {
      // Back to the game list, with the failure visible on it.
      setError(err instanceof Error ? err.message : "Couldn't start the game.");
      setLaunchingGameId(null);
    }
  }

  async function handleCopyInviteLink() {
    if (!roomCode) return;
    const url = `${window.location.origin}/games?room=${roomCode}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopyLabel("Copied!");
      setTimeout(() => setCopyLabel("Copy invite link"), 2000);
    } catch {
      setCopyLabel("Copy failed - copy manually");
    }
  }

  async function handleJoinSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!roomCode) return;
    setJoining(true);
    setJoinError(null);
    try {
      const result = await joinRoomByCodeViaApi(
        roomCode,
        joinAvatar.name,
        joinAvatar.mushroomIndex,
        joinAvatar.accessoryIndex
      );
      const freshRoom = await getRoomByCode(supabase, roomCode);
      if (freshRoom) setRoom(freshRoom);
      await refreshPlayers(result.roomId);
    } catch (err) {
      setJoinError(err instanceof RoomError ? err.message : "Something went wrong joining the room.");
    } finally {
      setJoining(false);
    }
  }

  // A game click replaces the whole listing with the shared loading screen
  // (same visual language as RoomClient's "Loading room…") until the room
  // redirect lands or the request fails. `embedded` because this page
  // already renders its own <main id="main-content">.
  if (launchingGameId) {
    const game = games.find((g) => g.id === launchingGameId);
    return <StatusScreen kind="loading" title={`Starting ${game?.displayName ?? launchingGameId}…`} embedded />;
  }

  return (
    <>
      {/* Page header: title left, copy-invite-link pinned to the far right
          (in room mode, once the room has loaded) - never inline after the
          room-info text below. */}
      <div className="games-heading">
        <h1>Browse Party Games</h1>
        {roomCode && loadState === "ready" && room && (
          <button
            type="button"
            className="games-heading-copy"
            onClick={handleCopyInviteLink}
            aria-live="polite"
          >
            {copyLabel}
          </button>
        )}
      </div>

      {!roomCode ? (
        <>
          <GamePicker games={games} selectedGameId={null} onSelect={(id) => void handleSelect(id)} />
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </>
      ) : (
        <>
          {loadState === "loading" && <p className="muted">Loading room…</p>}

          {loadState === "not-found" && (
            <p className="field-error" role="alert">
              No room exists for code &ldquo;{roomCode}&rdquo;. It may have expired or never existed.
            </p>
          )}

          {loadState === "error" && (
            <p className="field-error" role="alert">
              {loadError ?? "Something went wrong."}
            </p>
          )}

          {loadState === "ready" && room && (
            <>
              <p className="muted">
                Room <strong>{room.code}</strong> - share this invite link with friends!
              </p>

              {currentPlayer ? (
                // Member: the room's actual pre-game screen - live roster + the
                // game picker (host picks, everyone follows once a game lands;
                // non-host clicks get a host-only error from the switch route).
                <>
                  <RoomRoster
                    players={players}
                    onlineIds={onlineIds}
                    currentPlayerId={currentPlayer?.id ?? null}
                  />

                  <GamePicker games={games} selectedGameId={null} onSelect={(id) => void handleSelect(id)} />

                  {error && (
                    <p className="field-error" role="alert">
                      {error}
                    </p>
                  )}
                </>
              ) : room.status !== "lobby" ? (
                <p className="field-error" role="alert">
                  This room has already started, and you weren&rsquo;t part of it - new players can&rsquo;t
                  join mid-game.
                </p>
              ) : (
                // Unknown visitor: avatar-first join gate before any roster or
                // game list - mirror of RoomClient's non-member flow. Room-full
                // and similar are surfaced by the join route on submit (a
                // non-member can't read the player list, so a local pre-check
                // would be wrong here).
                <>
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
                    {/* Not gated on avatar preload - the indices are known
                        already; the ~29 MB image preload only feeds the
                        preview skeleton. See RoomForms.tsx. */}
                    <button type="submit" disabled={joining || !joinAvatar.name.trim()}>
                      {joining ? "Joining…" : "Join room"}
                    </button>
                  </form>
                </>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
