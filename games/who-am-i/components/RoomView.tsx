"use client";

// "Who Am I?" in-room view — Setup & Board (SPEC.md §8 "Setup") plus the
// Turn Loop & Question Log (SPEC.md §8 "Turn Loop", §5 questions_log).
// This is what the platform core (RoomClient) hands rendering off to once a
// room's status is "in_progress" and its game_id resolves to "who-am-i" —
// see /lib/games-registry.ts's `getGameRoomView`. Character assignment
// (and turn order — see games/who-am-i/logic/turnState.ts) already happened
// before the room ever reached this status (see GameConfig.onStart in
// ../config.ts + app/api/games/who-am-i/start), so this component's job is:
// load the roster + caller's own board, load the session's turn state and
// question log, and render both the tappable grid and the turn loop UI
// (public question form, sequential answer prompts, "I'm Done", scrollable
// Q&A log).
//
// Phase 6a shipped the ask/answer/done loop only (guessing, "solved"
// state, the game-end condition, and the recap screen were deliberately
// left out — see that phase's comment, now superseded). Phase 6b adds the
// rest of SPEC.md §8 points 6-7 on the frontend: a guess-your-identity
// control (backed by app/api/games/who-am-i/guess/route.ts), a host-only
// "End Game" control (app/api/games/who-am-i/end/route.ts), and — once
// `game_sessions.ended_at` is set, by either path — handing rendering off
// entirely to <WhoAmIRecap> instead of the turn loop / board. See
// ../logic/turnState.ts for the `solvedPlayerIds` / phase rules those
// controls are constrained by.
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
//
// Realtime here is a Postgres-changes subscription on `game_sessions` and
// `questions_log` (same pattern RoomClient already uses for rooms/players)
// PLUS a per-session Broadcast channel (games/who-am-i/realtime/
// broadcastEvents.ts) for the low-latency, ephemeral events SPEC.md §9
// calls out: the active-turn indicator, "player is typing a question,"
// sequential answer prompts, and "I'm Done" events. Postgres remains the
// source of truth either way — the Broadcast channel only ever pushes
// forward a state update the postgres_changes subscription would also
// deliver a moment later (or, for typing, something that was never meant
// to be persisted at all). A page refresh mid-game never touches
// Broadcast or Presence — the initial-load effect below reads `state`,
// `questions_log`, and this player's own board row straight from
// Postgres, so rehydration is correct with or without either channel.
//
// Presence (SPEC.md §9's "which players are currently connected") is
// tracked once, centrally, by RoomClient's `room-presence:<room.id>`
// channel and passed down as the `onlineIds` prop — this component reads
// it to flag when whoever's up next appears to be offline, but never
// opens its own Presence subscription.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { AvatarIcon } from "@/app/components/AvatarIcon";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { GameRoomViewProps } from "@/lib/games-registry";
import {
  currentAskerId,
  currentAskTargetId,
  currentResponderId,
  getGameOutcome,
  isWhoAmITurnState,
  type WhoAmITurnState,
} from "@/games/who-am-i/logic/turnState";
import { WhoAmIRecap, type WhoAmIRecapEntry } from "@/games/who-am-i/components/Recap";
import {
  useWhoAmIBroadcast,
  type WhoAmITurnEvent,
  type WhoAmITurnEventKind,
} from "@/games/who-am-i/realtime/broadcastEvents";

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

/**
 * Shape of a `who_am_i_board` row fetched for the WHOLE session (every
 * player, not just the caller's own row) during an in-progress game. The
 * view (supabase/migrations/..._who_am_i_identity_protection.sql) only
 * ever nulls out `character_id` for the row belonging to the CALLER —
 * every other player's row already comes back with their real
 * character_id, live, for the whole session. This is exactly SPEC.md §7's
 * "each player is secretly assigned a character identity that only
 * *other* players can see" — this component just wasn't reading it before.
 */
interface OpponentBoardRow {
  session_id: string;
  player_id: string;
  character_id: string | null;
}

type AnswerValue = "yes" | "no" | string;

interface QuestionLogRow {
  id: string;
  session_id: string;
  asking_player_id: string;
  /** Who this question is 1:1 directed at. Null only for is_guess rows. */
  target_player_id: string | null;
  question_text: string;
  created_at: string;
  answers: Record<string, AnswerValue>;
  resolved: boolean;
  /** True when this entry records a guess rather than an asked question
   * (SPEC.md §8 point 6 — guessing counts as a turn action, logged the
   * same way a question is). See supabase/migrations/
   * ..._who_am_i_guess_log_and_free_text_answers.sql. */
  is_guess: boolean;
  /** Only set when is_guess is true — the character the guesser picked. */
  guessed_character_id: string | null;
}

function formatAnswer(value: AnswerValue): string {
  if (value === "yes") return "Yes";
  if (value === "no") return "No";
  return `"${value}"`;
}

/**
 * Shape of a `who_am_i_board` row once `game_sessions.ended_at` is set —
 * that's the only condition under which the view's `character_id` case
 * (supabase/migrations/..._who_am_i_recap_reveal.sql) stops nulling out
 * the caller's own row, so this is only ever fetched for the recap, never
 * during an in-progress session.
 */
interface RevealedBoardRow {
  session_id: string;
  player_id: string;
  character_id: string | null;
  guessed_character_id: string | null;
  is_guessed: boolean;
}

type LoadState = "loading" | "ready" | "not-started" | "no-assignment" | "error";

const MAX_QUESTION_LENGTH = 280;

export function WhoAmIRoomView({ room, players, currentPlayer, onlineIds }: GameRoomViewProps) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [characters, setCharacters] = useState<CharacterRow[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [crossedOff, setCrossedOff] = useState<Set<string>>(new Set());
  // Every OTHER player's live character assignment (SPEC.md §7 — see
  // OpponentBoardRow above). Keyed by player_id; the caller's own id will
  // simply be absent/null since who_am_i_board nulls that row out.
  const [opponentCharacterByPlayer, setOpponentCharacterByPlayer] = useState<
    Map<string, string | null>
  >(new Map());
  // ---- yes/no/other answer draft --------------------------------------
  const [answerMode, setAnswerMode] = useState<"choose" | "other">("choose");
  const [otherAnswerDraft, setOtherAnswerDraft] = useState("");

  // ---- turn loop state (SPEC.md §8 "Turn Loop") --------------------------
  const [turnState, setTurnState] = useState<WhoAmITurnState | null>(null);
  const [questions, setQuestions] = useState<QuestionLogRow[]>([]);
  const [questionDraft, setQuestionDraft] = useState("");
  const [askError, setAskError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [answering, setAnswering] = useState(false);
  const [doneError, setDoneError] = useState<string | null>(null);
  const [endingTurn, setEndingTurn] = useState(false);

  // ---- guess / game-end (SPEC.md §8 points 6-7) --------------------------
  const [guessSubmitting, setGuessSubmitting] = useState(false);
  const [guessError, setGuessError] = useState<string | null>(null);
  const [guessResult, setGuessResult] = useState<"correct" | "incorrect" | null>(null);
  const [endGameSubmitting, setEndGameSubmitting] = useState(false);
  const [endGameError, setEndGameError] = useState<string | null>(null);

  // ---- messaging-app-style UI: which conversation is open, and whether
  // the deck is currently in "tap a card to guess" mode (replaces the old
  // guess <select> — SPEC.md restructure request) --------------------------
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [guessMode, setGuessMode] = useState(false);

  // ---- recap (SPEC.md §8 point 7) ----------------------------------------
  // Set from `game_sessions.ended_at`, either on initial load or via the
  // realtime subscription below — whichever end path fired
  // (system-detected "all solved" in guess/route.ts, or a host manually
  // ending it in end/route.ts), this is the single signal this component
  // uses to hand rendering off to <WhoAmIRecap>.
  const [endedAt, setEndedAt] = useState<string | null>(null);
  const [recapRows, setRecapRows] = useState<RevealedBoardRow[]>([]);
  const [recapLoading, setRecapLoading] = useState(false);
  const [recapError, setRecapError] = useState<string | null>(null);

  const nicknameFor = useCallback(
    (playerId: string) => players.find((p) => p.id === playerId)?.nickname ?? "Someone",
    [players]
  );

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
        // `state` here is the turn loop state (SPEC.md §8 "Turn Loop") —
        // see games/who-am-i/logic/turnState.ts for its shape.
        const { data: sessionRow, error: sessionError } = await supabase
          .from("game_sessions")
          .select("id, state, ended_at")
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
        setTurnState(isWhoAmITurnState(sessionRow.state) ? sessionRow.state : null);
        setEndedAt((sessionRow.ended_at as string | null) ?? null);

        // Full public question log for this session (questions_log_select_
        // room_members RLS policy), oldest first so it reads top-to-bottom
        // as a scrollable history (SPEC.md §8 "Chat/Log"). Includes
        // is_guess/guessed_character_id so a guess renders as its own kind
        // of log entry (SPEC.md §8 point 6 — guessing counts as a turn
        // action, same as asking).
        const { data: questionRows, error: questionsError } = await supabase
          .from("questions_log")
          .select(
            "id, session_id, asking_player_id, target_player_id, question_text, created_at, answers, resolved, is_guess, guessed_character_id"
          )
          .eq("session_id", sessionRow.id)
          .order("created_at", { ascending: true });
        if (questionsError) throw new Error(questionsError.message);
        if (cancelled) return;
        setQuestions((questionRows ?? []) as QuestionLogRow[]);

        // The masking view — see file header. Selects only the columns we
        // actually need; character_id is never requested for OUR OWN row,
        // so there's no path (buggy or not) where this component could
        // surface it for ourselves.
        const { data: boardRow, error: boardError } = await supabase
          .from("who_am_i_board")
          .select("session_id, player_id, crossed_off_character_ids")
          .eq("session_id", sessionRow.id)
          .eq("player_id", currentPlayer.id)
          .maybeSingle();
        if (boardError) throw new Error(boardError.message);
        if (cancelled) return;

        // Every OTHER player's live character (SPEC.md §7). Fetched for
        // the whole session, not filtered to a single player_id — the
        // view nulls out only the CALLER's own row, so this always comes
        // back with everyone else's real character_id already attached.
        // Fetched even if WE joined without an assignment of our own (no
        // `boardRow` below) — a late joiner should still get to see
        // everyone else's cards to help narrow things down.
        const { data: opponentRows, error: opponentError } = await supabase
          .from("who_am_i_board")
          .select("session_id, player_id, character_id")
          .eq("session_id", sessionRow.id);
        if (opponentError) throw new Error(opponentError.message);
        if (cancelled) return;
        setOpponentCharacterByPlayer(
          new Map(
            ((opponentRows ?? []) as OpponentBoardRow[]).map((row) => [row.player_id, row.character_id])
          )
        );

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

  // ---- realtime: turn state + question log (SPEC.md §8 "Turn Loop") -----
  // Plain Postgres-changes subscriptions, same pattern RoomClient already
  // uses for rooms/players (see file header for why this is enough for
  // now — the richer Broadcast channel is Phase 7). Postgres remains the
  // source of truth; this is purely for UX responsiveness.
  useEffect(() => {
    if (!sessionId) return;

    const channel = supabase
      .channel(`who-am-i-turn:${sessionId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "game_sessions", filter: `id=eq.${sessionId}` },
        (payload) => {
          const row = payload.new as { state?: unknown; ended_at?: string | null };
          if (isWhoAmITurnState(row.state)) setTurnState(row.state);
          if (row.ended_at) setEndedAt(row.ended_at);
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "questions_log", filter: `session_id=eq.${sessionId}` },
        (payload) => {
          const row = payload.new as QuestionLogRow;
          setQuestions((prev) => (prev.some((q) => q.id === row.id) ? prev : [...prev, row]));
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "questions_log", filter: `session_id=eq.${sessionId}` },
        (payload) => {
          const row = payload.new as QuestionLogRow;
          setQuestions((prev) => prev.map((q) => (q.id === row.id ? row : q)));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, sessionId]);

  // ---- reconnect-safety net (SPEC.md §11) --------------------------------
  // Same rationale as RoomClient.tsx's identically-shaped effect: the
  // postgres_changes subscription above is the normal path for staying in
  // sync, but a backgrounded phone can silently drop that WebSocket
  // without this component ever unmounting to trigger a fresh load. When
  // the tab becomes visible/online again, just re-read `state` and
  // `questions_log` straight from Postgres — the same source of truth the
  // initial-load effect already trusts — so a stale/dropped channel can't
  // leave the turn indicator or question log frozen on an old value.
  // Doesn't touch `crossedOff` (that's local-first, and re-fetching it
  // could stomp a tap made in the same instant this fires) or the recap
  // fetch (its own effect already re-runs whenever `endedAt` changes).
  useEffect(() => {
    if (!sessionId) return;
    let inFlight = false;

    async function resync() {
      if (inFlight) return;
      inFlight = true;
      try {
        const { data: sessionRow } = await supabase
          .from("game_sessions")
          .select("state, ended_at")
          .eq("id", sessionId)
          .maybeSingle();
        if (sessionRow) {
          if (isWhoAmITurnState(sessionRow.state)) setTurnState(sessionRow.state);
          if (sessionRow.ended_at) setEndedAt(sessionRow.ended_at as string);
        }

        const { data: questionRows } = await supabase
          .from("questions_log")
          .select(
            "id, session_id, asking_player_id, target_player_id, question_text, created_at, answers, resolved, is_guess, guessed_character_id"
          )
          .eq("session_id", sessionId)
          .order("created_at", { ascending: true });
        if (questionRows) setQuestions(questionRows as QuestionLogRow[]);
      } catch {
        // Best-effort — same reasoning as RoomClient's resync: the realtime
        // subscription is the primary path, this is just a backstop.
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

  // ---- realtime: Broadcast channel (SPEC.md §9) --------------------------
  // Layered on top of the postgres_changes subscription above — see this
  // file's header and games/who-am-i/realtime/broadcastEvents.ts for why
  // this is additive UX responsiveness, never a second source of truth.
  const handleTurnSync = useCallback((state: WhoAmITurnState) => setTurnState(state), []);
  const { typingPlayerIds, liveEvents, notifyTyping, broadcastTurnSync, broadcastTurnEvent } =
    useWhoAmIBroadcast({
      supabase,
      sessionId,
      currentPlayerId: currentPlayer.id,
      onTurnSync: handleTurnSync,
    });

  // Debounced "I'm typing a question" signal — only ever sent while it's
  // actually this player's turn to ask (see the input's onChange below).
  // Auto-clears after a pause in typing, on submit, and on unmount, so a
  // dropped final "stopped typing" broadcast doesn't matter: receivers
  // also time it out independently (broadcastEvents.ts).
  const typingStopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopTypingSignal = useCallback(() => {
    if (typingStopTimeoutRef.current) {
      clearTimeout(typingStopTimeoutRef.current);
      typingStopTimeoutRef.current = null;
    }
    notifyTyping(false);
  }, [notifyTyping]);
  const handleQuestionDraftChange = useCallback(
    (value: string) => {
      setQuestionDraft(value);
      if (!sessionId) return;
      if (typingStopTimeoutRef.current) clearTimeout(typingStopTimeoutRef.current);
      if (value.trim().length > 0) {
        notifyTyping(true);
        typingStopTimeoutRef.current = setTimeout(() => {
          typingStopTimeoutRef.current = null;
          notifyTyping(false);
        }, 2000);
      } else {
        notifyTyping(false);
      }
    },
    [sessionId, notifyTyping]
  );
  useEffect(() => {
    return () => {
      if (typingStopTimeoutRef.current) clearTimeout(typingStopTimeoutRef.current);
    };
  }, []);

  // ---- recap data: unmasked board, once the game has ended --------------
  // Only fires once `endedAt` is set (initial load or realtime, see
  // above) — before that, `who_am_i_board` still masks every player's own
  // row, so there'd be nothing new to read here anyway (see
  // supabase/migrations/..._who_am_i_recap_reveal.sql).
  useEffect(() => {
    if (!sessionId || !endedAt) return;
    let cancelled = false;

    async function loadRecap() {
      setRecapLoading(true);
      setRecapError(null);
      try {
        const { data, error } = await supabase
          .from("who_am_i_board")
          .select("session_id, player_id, character_id, guessed_character_id, is_guessed")
          .eq("session_id", sessionId);
        if (error) throw new Error(error.message);
        if (!cancelled) setRecapRows((data ?? []) as RevealedBoardRow[]);
      } catch (err) {
        if (!cancelled) {
          setRecapError(err instanceof Error ? err.message : "Failed to load the recap.");
        }
      } finally {
        if (!cancelled) setRecapLoading(false);
      }
    }

    loadRecap();
    return () => {
      cancelled = true;
    };
  }, [supabase, sessionId, endedAt]);

  // ---- turn loop actions: ask / answer / done ----------------------------
  // Each of these hits a trusted API route (app/api/games/who-am-i/{question,
  // answer,done}/route.ts) that re-checks turn order server-side before
  // writing anything — see those routes for why that check can't live in
  // RLS alone yet. The response's `state` is applied immediately so the
  // caller doesn't have to wait on the realtime round-trip for their own
  // action; the postgres_changes subscription above just keeps everyone
  // else (and a refreshed page) in sync.
  async function submitQuestion(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sessionId) return;
    setAsking(true);
    setAskError(null);
    try {
      const response = await fetch("/api/games/who-am-i/question", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, questionText: questionDraft }),
      });
      const payload = await response.json().catch(() => ({}) as { error?: string; state?: unknown });
      if (!response.ok) throw new Error(payload.error ?? "Failed to submit question.");
      if (isWhoAmITurnState(payload.state)) {
        setTurnState(payload.state);
        broadcastTurnSync(payload.state);
      }
      broadcastTurnEvent("question-asked");
      setQuestionDraft("");
      stopTypingSignal();
    } catch (err) {
      setAskError(err instanceof Error ? err.message : "Failed to submit question.");
    } finally {
      setAsking(false);
    }
  }

  async function submitAnswer(answer: AnswerValue) {
    if (!sessionId) return;
    if (typeof answer === "string" && answer.trim().length === 0) return;
    setAnswering(true);
    setAnswerError(null);
    try {
      const response = await fetch("/api/games/who-am-i/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, answer }),
      });
      const payload = await response.json().catch(() => ({}) as { error?: string; state?: unknown });
      if (!response.ok) throw new Error(payload.error ?? "Failed to submit answer.");
      if (isWhoAmITurnState(payload.state)) {
        setTurnState(payload.state);
        broadcastTurnSync(payload.state);
      }
      broadcastTurnEvent("answer-submitted");
      setAnswerMode("choose");
      setOtherAnswerDraft("");
    } catch (err) {
      setAnswerError(err instanceof Error ? err.message : "Failed to submit answer.");
    } finally {
      setAnswering(false);
    }
  }

  function submitOtherAnswer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = otherAnswerDraft.trim();
    if (trimmed.length === 0) return;
    void submitAnswer(trimmed);
  }

  async function submitDone() {
    if (!sessionId) return;
    setEndingTurn(true);
    setDoneError(null);
    try {
      const response = await fetch("/api/games/who-am-i/done", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const payload = await response.json().catch(() => ({}) as { error?: string; state?: unknown });
      if (!response.ok) throw new Error(payload.error ?? "Failed to end turn.");
      if (isWhoAmITurnState(payload.state)) {
        setTurnState(payload.state);
        broadcastTurnSync(payload.state);
      }
      broadcastTurnEvent("turn-done");
    } catch (err) {
      setDoneError(err instanceof Error ? err.message : "Failed to end turn.");
    } finally {
      setEndingTurn(false);
    }
  }

  // ---- host: manually end the game (SPEC.md §8 point 7) ------------------
  // Hits end/route.ts, which enforces host-only server-side — this handler
  // doesn't re-check `currentPlayer.is_host` itself beyond gating whether
  // the control renders at all (see the render section below).
  async function handleEndGame() {
    if (!sessionId) return;
    if (!window.confirm("End the game now for everyone? This can't be undone.")) return;
    setEndGameSubmitting(true);
    setEndGameError(null);
    try {
      const response = await fetch("/api/games/who-am-i/end", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const payload = await response.json().catch(() => ({}) as { error?: string });
      if (!response.ok) throw new Error(payload.error ?? "Failed to end the game.");
      setEndedAt(new Date().toISOString());
      broadcastTurnEvent("game-ended");
    } catch (err) {
      setEndGameError(err instanceof Error ? err.message : "Failed to end the game.");
    } finally {
      setEndGameSubmitting(false);
    }
  }

  // ---- turn loop derived view state --------------------------------------
  const askerId = turnState ? currentAskerId(turnState) : null;
  const responderId = turnState ? currentResponderId(turnState) : null;
  // Who the asker is (about to be) composing a question FOR — only
  // meaningful during "asking" (see turnState.ts's `currentAskTargetId`).
  const askTargetId = turnState ? currentAskTargetId(turnState) : null;
  const isMyTurnToAsk = turnState?.phase === "asking" && askerId === currentPlayer.id;
  const isMyTurnToAnswer = turnState?.phase === "answering" && responderId === currentPlayer.id;
  const isReviewingMyTurn = turnState?.phase === "reviewing" && askerId === currentPlayer.id;
  const activeQuestion =
    turnState?.activeQuestionId != null
      ? (questions.find((q) => q.id === turnState.activeQuestionId) ?? null)
      : null;
  const hasSolved = turnState?.solvedPlayerIds.includes(currentPlayer.id) ?? false;
  const canGuess = !endedAt && !hasSolved && isMyTurnToAsk && (turnState?.turnQuestionIds.length ?? 0) === 0;

  // ---- messaging-app restructure: one conversation per other player ------
  // Every OTHER player, in roster order — this is the sidebar's list of
  // "conversations." (SPEC.md restructure request.)
  const otherPlayers = useMemo(
    () => players.filter((p) => p.id !== currentPlayer.id),
    [players, currentPlayer.id]
  );

  // This player's full back-and-forth with each other player: every
  // non-guess question asked by either of them, targeted at the other, in
  // chronological order. Guesses aren't part of any 1:1 conversation (no
  // target_player_id), so they're intentionally left out here — the live
  // activity feed above already surfaces them.
  const conversationsByPlayer = useMemo(() => {
    const map = new Map<string, QuestionLogRow[]>();
    for (const player of otherPlayers) {
      map.set(
        player.id,
        questions.filter(
          (q) =>
            !q.is_guess &&
            ((q.asking_player_id === currentPlayer.id && q.target_player_id === player.id) ||
              (q.asking_player_id === player.id && q.target_player_id === currentPlayer.id))
        )
      );
    }
    return map;
  }, [otherPlayers, questions, currentPlayer.id]);

  // Default to the first conversation once the roster is known.
  useEffect(() => {
    if (selectedPlayerId) return;
    if (otherPlayers.length > 0) setSelectedPlayerId(otherPlayers[0]!.id);
  }, [otherPlayers, selectedPlayerId]);

  // Auto-open/close the relevant conversation as the turn moves: while it's
  // my turn to ask, open the person I'm asking; while it's my turn to
  // answer, open whoever's asking me. The deck (main area) never gets
  // replaced by this — it's a separate column, always visible (SPEC.md
  // restructure request: "make sure their card is still being shown").
  useEffect(() => {
    if (isMyTurnToAsk && askTargetId) {
      setSelectedPlayerId(askTargetId);
    } else if (isMyTurnToAnswer && askerId) {
      setSelectedPlayerId(askerId);
    }
  }, [isMyTurnToAsk, askTargetId, isMyTurnToAnswer, askerId]);

  type ConversationStatus = "asking" | "your-turn" | "waiting";
  function conversationStatus(playerId: string): { label: string; tone: ConversationStatus } {
    if (!turnState) return { label: "Waiting", tone: "waiting" };
    if (turnState.phase === "asking") {
      if (isMyTurnToAsk && askTargetId === playerId) return { label: "Asking", tone: "asking" };
      if (askerId === playerId && askTargetId === currentPlayer.id) {
        return { label: "Your turn", tone: "your-turn" };
      }
    }
    if (turnState.phase === "answering") {
      if (askerId === currentPlayer.id && responderId === playerId) {
        return { label: "Answering", tone: "asking" };
      }
      if (askerId === playerId && responderId === currentPlayer.id) {
        return { label: "Your turn", tone: "your-turn" };
      }
    }
    if (turnState.phase === "reviewing" && askerId === currentPlayer.id) {
      return { label: "Reviewing", tone: "waiting" };
    }
    return { label: "Waiting", tone: "waiting" };
  }

  const selectedPlayer = selectedPlayerId ? players.find((p) => p.id === selectedPlayerId) : undefined;
  const selectedConversation = selectedPlayerId ? (conversationsByPlayer.get(selectedPlayerId) ?? []) : [];
  // True when the selected conversation is the one live question I can
  // currently ask (drives whether the chat composer shows a text input).
  const canAskInSelectedChat = isMyTurnToAsk && askTargetId === selectedPlayerId;
  // True when the selected conversation is the person currently asking ME
  // (drives whether the chat composer shows Yes/No/Other buttons instead).
  const canAnswerInSelectedChat = isMyTurnToAnswer && askerId === selectedPlayerId && !!activeQuestion;

  // Tapping a still-live card while `guessMode` is on submits a guess for
  // that character directly — replaces the old <select> dropdown, and only
  // ever offers characters that haven't already been crossed off (SPEC.md
  // restructure request).
  async function submitGuessForCharacter(characterId: string) {
    if (!sessionId) return;
    const character = characters.find((c) => c.id === characterId);
    if (
      character &&
      !window.confirm(`Guess "${character.name}"? A wrong guess ends your turn.`)
    ) {
      return;
    }
    setGuessSubmitting(true);
    setGuessError(null);
    setGuessResult(null);
    try {
      const response = await fetch("/api/games/who-am-i/guess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, characterId }),
      });
      const payload = await response.json().catch(
        () => ({}) as { error?: string; state?: unknown; correct?: boolean; gameEnded?: boolean }
      );
      if (!response.ok) throw new Error(payload.error ?? "Failed to submit guess.");
      if (isWhoAmITurnState(payload.state)) {
        setTurnState(payload.state);
        broadcastTurnSync(payload.state);
      }
      broadcastTurnEvent(payload.correct ? "guess-correct" : "guess-incorrect");
      setGuessResult(payload.correct ? "correct" : "incorrect");
      setGuessMode(false);
      if (payload.gameEnded) {
        setEndedAt(new Date().toISOString());
        broadcastTurnEvent("game-ended");
      }
    } catch (err) {
      setGuessError(err instanceof Error ? err.message : "Failed to submit guess.");
    } finally {
      setGuessSubmitting(false);
    }
  }

  // ---- presence-derived hint (SPEC.md §9 Presence) -----------------------
  // Whoever the turn indicator is currently waiting on — the asker while
  // "asking"/"reviewing", the current responder while "answering" — flagged
  // if `onlineIds` (tracked centrally by RoomClient's Presence channel, see
  // this file's header) says they're not currently connected. This is only
  // ever a UX hint layered on top of Postgres-derived turn state, never a
  // substitute for it: the turn itself doesn't change because of presence.
  const activeTurnPlayerId = turnState?.phase === "answering" ? responderId : askerId;
  const activeTurnPlayerOffline =
    !!activeTurnPlayerId && activeTurnPlayerId !== currentPlayer.id && !onlineIds.has(activeTurnPlayerId);

  // ---- Broadcast-derived live activity feed (SPEC.md §9) -----------------
  function describeTurnEvent(event: WhoAmITurnEvent): string {
    const name = nicknameFor(event.playerId);
    const byKind: Record<WhoAmITurnEventKind, string> = {
      "question-asked": `${name} asked a question.`,
      "answer-submitted": `${name} answered.`,
      "turn-done": `${name} ended their turn.`,
      "guess-correct": `${name} solved it! 🎉`,
      "guess-incorrect": `${name} guessed — not quite.`,
      "game-ended": `The game has ended.`,
    };
    return byKind[event.kind];
  }

  // ---- recap derived data (SPEC.md §8 point 7) ---------------------------
  // Ranked by `solvedPlayerIds` order (the order players actually solved
  // it in), unsolved players last. Only meaningful once `recapRows` has
  // loaded — see the effect above.
  const recapEntries: WhoAmIRecapEntry[] = useMemo(() => {
    if (!turnState || recapRows.length === 0) return [];
    const characterById = new Map(characters.map((c) => [c.id, c]));
    const rowByPlayer = new Map(recapRows.map((r) => [r.player_id, r]));
    const solvedOrder = turnState.solvedPlayerIds;

    return players
      .map((p) => {
        const row = rowByPlayer.get(p.id);
        const rank = solvedOrder.includes(p.id) ? solvedOrder.indexOf(p.id) + 1 : null;
        const character = row?.character_id ? characterById.get(row.character_id) : undefined;
        const guessedCharacter = row?.guessed_character_id
          ? characterById.get(row.guessed_character_id)
          : undefined;
        return {
          playerId: p.id,
          nickname: p.nickname,
          isYou: p.id === currentPlayer.id,
          rank,
          characterName: character?.name ?? null,
          characterImageUrl: character?.image_url ?? null,
          guessedCharacterName: guessedCharacter?.name ?? null,
          correct: row?.is_guessed === true,
        };
      })
      .sort((a, b) => {
        if (a.rank != null && b.rank != null) return a.rank - b.rank;
        if (a.rank != null) return -1;
        if (b.rank != null) return 1;
        return a.nickname.localeCompare(b.nickname);
      });
  }, [turnState, recapRows, characters, players, currentPlayer.id]);

  // ---- recap question log (SPEC.md §8 point 7) ---------------------------
  // Same `questions` the in-progress log already renders, reshaped for
  // <WhoAmIRecap>: guess entries get their guessed character's name
  // resolved here (from the already-public `characters` roster) rather
  // than making the recap component do its own character lookup.
  const recapQuestions = useMemo(
    () =>
      questions.map((q) => ({
        id: q.id,
        asking_player_id: q.asking_player_id,
        target_player_id: q.target_player_id,
        question_text: q.question_text,
        answers: q.answers,
        is_guess: q.is_guess,
        guessedCharacterName: q.guessed_character_id
          ? (characters.find((c) => c.id === q.guessed_character_id)?.name ?? null)
          : null,
      })),
    [questions, characters]
  );

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

  // Once the game has ended (either end path — see file header), rendering
  // is handed off entirely to the recap; the turn loop / board below is
  // for an in-progress session only.
  if (endedAt) {
    // Mode-aware win/loss framing (turnState.ts `getGameOutcome`) — a host
    // manually ending the round early (app/api/games/who-am-i/end/route.ts)
    // means `turnState` might not actually satisfy `isGameOver` yet, in
    // which case `getGameOutcome` returns empty winner/loser lists and
    // <WhoAmIRecap> just falls back to its plain "who solved it" listing.
    const outcome = turnState ? getGameOutcome(turnState) : null;
    return (
      <WhoAmIRecap
        entries={recapEntries}
        questions={recapQuestions}
        nicknameFor={nicknameFor}
        loading={recapLoading}
        error={recapError}
        gameMode={turnState?.gameMode ?? null}
        winnerPlayerIds={outcome?.winnerPlayerIds ?? []}
        loserPlayerIds={outcome?.loserPlayerIds ?? []}
      />
    );
  }

  const remaining = characters.length - crossedOff.size;
  const otherPlayersCount = otherPlayers.length;

  return (
    <div className="who-am-i-shell">
      <header className="who-am-i-appbar">
        <div className="who-am-i-appbar-title">
          <h2>Reverse Guess Who?</h2>
          <p className="muted">Ask yes or no questions to figure out which character you are.</p>
        </div>

        <div className="who-am-i-appbar-status">
          {!turnState ? (
            <p className="muted">Setting up the turn order…</p>
          ) : (
            <>
              {/* Turn indicator — aria-live so screen reader users hear whose
                  turn it is without needing to re-focus anything (SPEC.md
                  §11: "aria labels on ... turn indicators"). */}
              <p className="who-am-i-turn-indicator" role="status" aria-live="polite">
                {turnState.phase === "asking" &&
                  (isMyTurnToAsk
                    ? `Your turn — ask ${nicknameFor(askTargetId ?? "")} a yes/no question.`
                    : askTargetId === currentPlayer.id
                      ? `${nicknameFor(askerId ?? "")} is about to ask you a question.`
                      : `Waiting for ${nicknameFor(askerId ?? "")} to ask ${nicknameFor(askTargetId ?? "")} a question.`)}
                {turnState.phase === "answering" &&
                  (isMyTurnToAnswer
                    ? "Your turn to answer."
                    : `Waiting for ${nicknameFor(responderId ?? "")} to answer.`)}
                {turnState.phase === "reviewing" &&
                  (isReviewingMyTurn
                    ? "All answers are in — review them, then end your turn."
                    : `Waiting for ${nicknameFor(askerId ?? "")} to finish their turn.`)}
              </p>

              {/* Presence hint (SPEC.md §9) — layered on top of the turn
                  indicator above, never a replacement for it. */}
              {activeTurnPlayerOffline && (
                <p className="who-am-i-offline-hint muted" role="status">
                  {nicknameFor(activeTurnPlayerId ?? "")} appears to be offline — hang tight, they may
                  be reconnecting.
                </p>
              )}

              {/* Typing indicator (SPEC.md §9) — Broadcast-only, never
                  persisted; see games/who-am-i/realtime/broadcastEvents.ts. */}
              {turnState.phase === "asking" && !isMyTurnToAsk && askerId && typingPlayerIds.has(askerId) && (
                <p className="who-am-i-typing-indicator muted" aria-live="polite">
                  {nicknameFor(askerId)} is typing a question…
                </p>
              )}

              {/* Live activity feed (SPEC.md §9) — ephemeral Broadcast
                  toasts, never persisted. */}
              {liveEvents.length > 0 && (
                <ul className="who-am-i-live-feed" aria-live="polite" aria-label="Recent activity">
                  {liveEvents.map((event) => (
                    <li key={event.id}>{describeTurnEvent(event)}</li>
                  ))}
                </ul>
              )}

              {isReviewingMyTurn && (
                <div className="who-am-i-review-cta">
                  {doneError && (
                    <p className="field-error" role="alert">
                      {doneError}
                    </p>
                  )}
                  <button type="button" onClick={submitDone} disabled={endingTurn}>
                    {endingTurn ? "Ending turn…" : "I'm Done"}
                  </button>
                </div>
              )}

              {hasSolved && (
                <p className="who-am-i-solved-note">
                  You solved it! You can still answer everyone else&rsquo;s questions.
                </p>
              )}

              {guessResult && (
                <p
                  className={`who-am-i-guess-result who-am-i-guess-result-${guessResult}`}
                  role="status"
                  aria-live="polite"
                >
                  {guessResult === "correct"
                    ? "Correct! You solved it. 🎉"
                    : "Not quite — your turn ends."}
                </p>
              )}

              {currentPlayer.is_host && (
                <div className="who-am-i-host-controls">
                  {endGameError && (
                    <p className="field-error" role="alert">
                      {endGameError}
                    </p>
                  )}
                  <button type="button" onClick={handleEndGame} disabled={endGameSubmitting}>
                    {endGameSubmitting ? "Ending…" : "End game (host)"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </header>

      <div className="who-am-i-layout">
        {/* ---- Left sidebar: one conversation per player (SPEC.md restructure) ---- */}
        <nav className="who-am-i-sidebar" aria-label="Conversations">
          {otherPlayersCount === 0 ? (
            <p className="muted who-am-i-sidebar-empty">No one else here yet.</p>
          ) : (
            <ul className="who-am-i-conversation-list" role="list">
              {otherPlayers.map((player) => {
                const convo = conversationsByPlayer.get(player.id) ?? [];
                const status = conversationStatus(player.id);
                const isSelected = player.id === selectedPlayerId;
                return (
                  <li key={player.id}>
                    <button
                      type="button"
                      className={`who-am-i-conversation-item${isSelected ? " selected" : ""}`}
                      onClick={() => setSelectedPlayerId(player.id)}
                      aria-current={isSelected}
                    >
                      <AvatarIcon
                        mushroomIndex={player.mushroom_index}
                        accessoryIndex={player.accessory_index}
                        size={44}
                        wiggle={false}
                      />
                      <span className="who-am-i-conversation-item-body">
                        <span className="who-am-i-conversation-item-name">{player.nickname}</span>
                        <span className="who-am-i-conversation-item-meta muted">
                          {convo.length} question{convo.length === 1 ? "" : "s"}
                        </span>
                      </span>
                      <span className={`who-am-i-conversation-status who-am-i-status-${status.tone}`}>
                        {status.label}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>

        {/* ---- Chat panel: the full history with whoever's selected ---- */}
        <section className="who-am-i-chat-panel" aria-label="Conversation">
          {!selectedPlayer ? (
            <p className="muted who-am-i-chat-empty">Select a player to see your conversation.</p>
          ) : (
            <>
              <div className="who-am-i-chat-header">
                <AvatarIcon
                  mushroomIndex={selectedPlayer.mushroom_index}
                  accessoryIndex={selectedPlayer.accessory_index}
                  size={40}
                  wiggle={false}
                />
                <div className="who-am-i-chat-header-body">
                  <span className="who-am-i-chat-header-name">{selectedPlayer.nickname}</span>
                  <span className="muted">{selectedConversation.length} questions asked</span>
                </div>
                {(() => {
                  const characterId = opponentCharacterByPlayer.get(selectedPlayer.id) ?? null;
                  const character = characterId ? characters.find((c) => c.id === characterId) : undefined;
                  if (!character) return null;
                  return (
                    <span className="who-am-i-chat-header-character" title={`${selectedPlayer.nickname}'s character`}>
                      <span className="who-am-i-chat-header-character-image">
                        <Image src={character.image_url} alt="" fill sizes="40px" />
                      </span>
                      {character.name}
                    </span>
                  );
                })()}
              </div>

              <div className="who-am-i-chat-messages">
                {selectedConversation.length === 0 && (
                  <p className="muted who-am-i-chat-empty">No questions yet — this conversation is empty.</p>
                )}
                {selectedConversation.map((q) => {
                  const iAsked = q.asking_player_id === currentPlayer.id;
                  const answer = q.target_player_id ? q.answers[q.target_player_id] : undefined;
                  return (
                    <div key={q.id} className="who-am-i-chat-exchange">
                      <div className={`who-am-i-message ${iAsked ? "who-am-i-message-you" : "who-am-i-message-them"}`}>
                        <span className="who-am-i-message-sender">
                          {iAsked ? "You" : selectedPlayer.nickname}
                        </span>
                        <p>{q.question_text}</p>
                      </div>
                      {answer !== undefined ? (
                        <div
                          className={`who-am-i-message ${iAsked ? "who-am-i-message-them" : "who-am-i-message-you"}${
                            answer === "yes"
                              ? " who-am-i-message-yes"
                              : answer === "no"
                                ? " who-am-i-message-no"
                                : ""
                          }`}
                        >
                          <span className="who-am-i-message-sender">
                            {iAsked ? selectedPlayer.nickname : "You"}
                          </span>
                          <p>
                            {formatAnswer(answer)}
                            {answer === "yes" && " ✓"}
                            {answer === "no" && " ✕"}
                          </p>
                        </div>
                      ) : (
                        <p className="muted who-am-i-chat-pending">Still being answered…</p>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="who-am-i-chat-composer">
                {canAskInSelectedChat && (
                  <form className="who-am-i-ask-form" onSubmit={submitQuestion}>
                    <input
                      value={questionDraft}
                      onChange={(e) => handleQuestionDraftChange(e.target.value)}
                      maxLength={MAX_QUESTION_LENGTH}
                      required
                      placeholder={`Ask ${selectedPlayer.nickname} a yes/no question…`}
                      autoComplete="off"
                      aria-label={`Ask ${selectedPlayer.nickname} a yes/no question`}
                    />
                    <button type="submit" disabled={asking || questionDraft.trim().length === 0}>
                      {asking ? "Asking…" : "Ask"}
                    </button>
                    {askError && (
                      <p className="field-error who-am-i-chat-composer-error" role="alert">
                        {askError}
                      </p>
                    )}
                  </form>
                )}

                {canAnswerInSelectedChat && activeQuestion && (
                  <div className="who-am-i-answering-panel">
                    <p className="who-am-i-answering-prompt">
                      <strong>{selectedPlayer.nickname} asks you:</strong> {activeQuestion.question_text}
                    </p>
                    {answerMode === "choose" ? (
                      <div className="who-am-i-answer-buttons">
                        <button
                          type="button"
                          onClick={() => submitAnswer("yes")}
                          disabled={answering}
                          aria-label="Answer yes"
                        >
                          Yes ✓
                        </button>
                        <button
                          type="button"
                          onClick={() => submitAnswer("no")}
                          disabled={answering}
                          aria-label="Answer no"
                        >
                          No ✕
                        </button>
                        <button
                          type="button"
                          onClick={() => setAnswerMode("other")}
                          disabled={answering}
                          aria-label="Type a different answer"
                        >
                          Other…
                        </button>
                      </div>
                    ) : (
                      <form className="who-am-i-other-answer-form" onSubmit={submitOtherAnswer}>
                        <input
                          value={otherAnswerDraft}
                          onChange={(e) => setOtherAnswerDraft(e.target.value)}
                          maxLength={140}
                          required
                          placeholder="e.g. Kind of, depends…"
                          autoComplete="off"
                          autoFocus
                          aria-label="Type your answer"
                        />
                        <div className="who-am-i-other-answer-actions">
                          <button type="submit" disabled={answering || otherAnswerDraft.trim().length === 0}>
                            {answering ? "Sending…" : "Send"}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setAnswerMode("choose");
                              setOtherAnswerDraft("");
                            }}
                            disabled={answering}
                          >
                            Back
                          </button>
                        </div>
                      </form>
                    )}
                    {answerError && (
                      <p className="field-error" role="alert">
                        {answerError}
                      </p>
                    )}
                  </div>
                )}

                {!canAskInSelectedChat && !canAnswerInSelectedChat && (
                  <p className="muted who-am-i-chat-composer-disabled">
                    {turnState?.phase === "reviewing" && askerId === currentPlayer.id
                      ? "Review this turn's answers above, then press \u201cI'm Done.\u201d"
                      : `Waiting for your turn to chat with ${selectedPlayer.nickname}.`}
                  </p>
                )}
              </div>
            </>
          )}
        </section>

        {/* ---- Main content: My Deck — the primary visual focus ---- */}
        <section className="who-am-i-deck" aria-labelledby="who-am-i-deck-heading">
          <div className="who-am-i-deck-header">
            <div>
              <h2 id="who-am-i-deck-heading">My Deck</h2>
              {state === "no-assignment" ? (
                <p className="muted">You joined mid-round, so you weren&rsquo;t assigned a character.</p>
              ) : (
                <p className="muted">Tap a character to cross it off as you rule it out.</p>
              )}
            </div>
            <div className="who-am-i-deck-header-actions">
              <span className="who-am-i-deck-counter">
                {remaining} remaining
              </span>
              {canGuess && (
                <button
                  type="button"
                  className={`who-am-i-guess-toggle${guessMode ? " active" : ""}`}
                  onClick={() => setGuessMode((v) => !v)}
                  disabled={guessSubmitting}
                >
                  {guessMode ? "Cancel guess" : "I know who I am!"}
                </button>
              )}
            </div>
          </div>

          {guessMode && (
            <p className="who-am-i-guess-hint" role="status">
              Tap a card below to guess it — a wrong guess ends your turn.
            </p>
          )}
          {guessError && (
            <p className="field-error" role="alert">
              {guessError}
            </p>
          )}

          <div className="who-am-i-deck-board">
            <ul className="who-am-i-grid" role="list">
              {characters.map((character) => {
                const isCrossedOff = crossedOff.has(character.id);
                if (guessMode) {
                  return (
                    <li key={character.id}>
                      <button
                        type="button"
                        className={`who-am-i-card${isCrossedOff ? " crossed-off" : ""}`}
                        onClick={() => !isCrossedOff && submitGuessForCharacter(character.id)}
                        disabled={isCrossedOff || guessSubmitting}
                        aria-label={`Guess ${character.name}`}
                      >
                        <span className="who-am-i-card-image">
                          <Image src={character.image_url} alt="" fill sizes="96px" />
                        </span>
                        <span className="who-am-i-card-name">{character.name}</span>
                      </button>
                    </li>
                  );
                }
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
          </div>
        </section>
      </div>
    </div>
  );
}
