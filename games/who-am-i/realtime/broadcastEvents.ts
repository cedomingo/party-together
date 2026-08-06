"use client";

// Per-room Broadcast channel for "Who Am I?" (SPEC.md §9): low-latency,
// ephemeral events layered on top of the Postgres-changes subscription
// that already lives in games/who-am-i/components/RoomView.tsx. Postgres
// remains the source of truth for turn state and the question log (see
// that file's header, and SPEC.md §9's closing line: "Realtime broadcast
// is for UX responsiveness, not the source of truth") — this channel
// exists purely to shave the replication round-trip off of what
// postgres_changes would otherwise deliver a moment later, plus carry one
// thing that is *never* persisted anywhere at all: "player is typing a
// question."
//
// Three broadcast events, scoped to `who-am-i-broadcast:<sessionId>` so
// they never cross sessions (a fresh game within the same room gets a
// fresh channel, same as the postgres_changes subscription already keyed
// on sessionId):
//
//   - "typing"     Ephemeral only, never touches Postgres. The sender
//                   debounces locally (see RoomView.tsx's question-draft
//                   handler); receivers additionally auto-clear a stuck
//                   "is typing" flag after TYPING_TIMEOUT_MS in case a
//                   "stopped typing" broadcast is dropped or the sender's
//                   tab closes mid-keystroke.
//   - "turn-sync"  Mirrors the exact `WhoAmITurnState` a turn-loop route
//                   (question/answer/done/guess) just persisted (SPEC.md
//                   §9's "active turn indicator" + "sequential answer
//                   prompts"). Sent by whichever client's action produced
//                   that state, right after the API call that wrote it
//                   succeeds. Applying it on other clients is just pulling
//                   forward a state update they'd receive a moment later
//                   via postgres_changes anyway — `onTurnSync` here and the
//                   postgres_changes handler both ultimately call the same
//                   `setTurnState`, so a slightly-late postgres_changes
//                   delivery of identical state is a harmless no-op, not a
//                   second source of truth.
//   - "turn-event" Small ephemeral toasts ("X asked a question", "Y is
//                   done — turn passed") for SPEC.md §9's "I'm Done
//                   events". Display-only; carries no state a reconnecting
//                   client would need. A refresh rehydrates entirely from
//                   Postgres (RoomView.tsx's initial-load effect) and
//                   simply never sees this toast history — that's fine, it
//                   was never meant to persist.
//
// `self: false` on the channel config means the sending client never
// receives its own broadcasts back — it already applied the same update
// locally from the API response, so echoing it would just be redundant
// work, not a correctness issue either way.

import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { WhoAmITurnState } from "@/games/who-am-i/logic/turnState";

const TYPING_EVENT = "typing";
const TURN_SYNC_EVENT = "turn-sync";
const TURN_EVENT_EVENT = "turn-event";

/** How long a "started typing" signal is trusted before it's assumed
 *  stale — see file header. */
const TYPING_TIMEOUT_MS = 4000;

/** Toasts kept around at once — this is a live feed, not a log (that's
 *  questions_log/Postgres's job); old ones just fall off. */
const MAX_LIVE_EVENTS = 5;

export type WhoAmITurnEventKind =
  | "question-asked"
  | "answer-submitted"
  | "turn-done"
  | "guess-correct"
  | "guess-incorrect"
  | "game-ended";

export interface WhoAmITurnEvent {
  /** Not a DB id — only needs to be a stable React key for this toast. */
  id: string;
  kind: WhoAmITurnEventKind;
  playerId: string;
}

interface TypingBroadcastPayload {
  playerId: string;
  isTyping: boolean;
}

interface TurnSyncBroadcastPayload {
  state: WhoAmITurnState;
}

interface TurnEventBroadcastPayload {
  kind: WhoAmITurnEventKind;
  playerId: string;
}

function channelNameForSession(sessionId: string): string {
  return `who-am-i-broadcast:${sessionId}`;
}

export function useWhoAmIBroadcast({
  supabase,
  sessionId,
  currentPlayerId,
  onTurnSync,
}: {
  supabase: SupabaseClient;
  /** No channel is opened until a session exists (mirrors the
   *  postgres_changes effect in RoomView.tsx, which is likewise gated on
   *  `sessionId`). */
  sessionId: string | null;
  currentPlayerId: string;
  /** Applied to whatever local state a postgres_changes handler would
   *  otherwise (a little later) set from the same underlying write. */
  onTurnSync: (state: WhoAmITurnState) => void;
}) {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [typingPlayerIds, setTypingPlayerIds] = useState<Set<string>>(new Set());
  const [liveEvents, setLiveEvents] = useState<WhoAmITurnEvent[]>([]);
  const typingTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const onTurnSyncRef = useRef(onTurnSync);
  onTurnSyncRef.current = onTurnSync;

  useEffect(() => {
    if (!sessionId) {
      channelRef.current = null;
      return;
    }

    const channel = supabase
      .channel(channelNameForSession(sessionId), { config: { broadcast: { self: false } } })
      .on("broadcast", { event: TYPING_EVENT }, ({ payload }) => {
        const { playerId, isTyping } = payload as TypingBroadcastPayload;
        const timeouts = typingTimeoutsRef.current;
        const existing = timeouts.get(playerId);
        if (existing) clearTimeout(existing);

        setTypingPlayerIds((prev) => {
          const next = new Set(prev);
          if (isTyping) next.add(playerId);
          else next.delete(playerId);
          return next;
        });

        if (isTyping) {
          timeouts.set(
            playerId,
            setTimeout(() => {
              setTypingPlayerIds((prev) => {
                const next = new Set(prev);
                next.delete(playerId);
                return next;
              });
              timeouts.delete(playerId);
            }, TYPING_TIMEOUT_MS)
          );
        } else {
          timeouts.delete(playerId);
        }
      })
      .on("broadcast", { event: TURN_SYNC_EVENT }, ({ payload }) => {
        const { state } = payload as TurnSyncBroadcastPayload;
        onTurnSyncRef.current(state);
      })
      .on("broadcast", { event: TURN_EVENT_EVENT }, ({ payload }) => {
        const { kind, playerId } = payload as TurnEventBroadcastPayload;
        setLiveEvents((prev) =>
          [
            ...prev,
            { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, kind, playerId },
          ].slice(-MAX_LIVE_EVENTS)
        );
      })
      .subscribe();

    channelRef.current = channel;

    return () => {
      for (const timeout of typingTimeoutsRef.current.values()) clearTimeout(timeout);
      typingTimeoutsRef.current.clear();
      setTypingPlayerIds(new Set());
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
    // sessionId alone drives the subscription lifecycle — same rationale
    // as the postgres_changes effect in RoomView.tsx (keyed on ids, not
    // objects, to avoid tearing the channel down on every update it
    // receives).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, sessionId]);

  const notifyTyping = useCallback(
    (isTyping: boolean) => {
      channelRef.current?.send({
        type: "broadcast",
        event: TYPING_EVENT,
        payload: { playerId: currentPlayerId, isTyping } satisfies TypingBroadcastPayload,
      });
    },
    [currentPlayerId]
  );

  const broadcastTurnSync = useCallback((state: WhoAmITurnState) => {
    channelRef.current?.send({
      type: "broadcast",
      event: TURN_SYNC_EVENT,
      payload: { state } satisfies TurnSyncBroadcastPayload,
    });
  }, []);

  const broadcastTurnEvent = useCallback(
    (kind: WhoAmITurnEventKind) => {
      channelRef.current?.send({
        type: "broadcast",
        event: TURN_EVENT_EVENT,
        payload: { kind, playerId: currentPlayerId } satisfies TurnEventBroadcastPayload,
      });
    },
    [currentPlayerId]
  );

  return { typingPlayerIds, liveEvents, notifyTyping, broadcastTurnSync, broadcastTurnEvent };
}
