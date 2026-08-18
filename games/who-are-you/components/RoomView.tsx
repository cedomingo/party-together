"use client";

// "Who Are You?" in-room view — Setup (WHO-ARE-YOU-SPEC.md §3) plus Step 2
// gameplay: per-opponent boards (§4), guessing (§5), turn loop (§6), and
// recap (§9). Reuses Who Am I's messaging-app layout (one conversation per
// other player), but swaps in the viewer's board for the selected opponent
// instead of a single shared deck.

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { AvatarIcon } from "@/app/components/AvatarIcon";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { cardSoundHandlers, playCharacterSound } from "@/lib/animalSounds";
import type { GameRoomViewProps } from "@/lib/games-registry";
import {
  isWhoAreYouSetupState,
  type WhoAreYouSetupState,
} from "@/games/who-are-you/logic/sessionState";
import {
  currentAskerId,
  currentAskTargetId,
  currentResponderId,
  getGameOutcome,
  isPairingSolved,
  isWhoAreYouTurnsState,
  rivalOf,
  type WhoAreYouTurnsState,
} from "@/games/who-are-you/logic/turnState";
import { WhoAreYouRecap, type WhoAreYouRecapPlayer } from "@/games/who-are-you/components/Recap";

interface CharacterRow {
  id: string;
  name: string;
  image_url: string;
}

interface OwnSelectionRow {
  session_id: string;
  player_id: string;
  character_id: string;
}

interface BoardRow {
  session_id: string;
  viewer_player_id: string;
  target_player_id: string;
  crossed_off_character_ids: string[] | null;
  is_solved: boolean;
  guessed_character_id: string | null;
  solved_turn_number: number | null;
}

type AnswerValue = "yes" | "no" | string;

interface QuestionLogRow {
  id: string;
  session_id: string;
  asking_player_id: string;
  target_player_id: string | null;
  question_text: string;
  created_at: string;
  answers: Record<string, AnswerValue>;
  resolved: boolean;
  is_guess: boolean;
  guessed_character_id: string | null;
}

function formatAnswer(value: AnswerValue): string {
  if (value === "yes") return "Yes";
  if (value === "no") return "No";
  return `"${value}"`;
}

/** Shared "How to Play" modal — rendered by both the setup and turns phases
 *  so the pick-a-character screen carries the same topbar chrome as the
 *  playing board. */
function WhoAreYouHowToPlayModal({
  open,
  onClose,
  description,
}: {
  open: boolean;
  onClose: () => void;
  description?: string;
}) {
  if (!open) return null;
  return (
    <div className="who-am-i-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="who-am-i-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="who-are-you-howtoplay-heading"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="who-are-you-howtoplay-heading">How to Play</h2>
        <p>{description}</p>
        <ul>
          <li>Each opponent has their own board — cross-offs don&rsquo;t carry over.</li>
          <li>On your turn, ask (or guess) each unsolved opponent once.</li>
          <li>A correct guess solves that opponent only; a wrong guess wastes their slot this turn.</li>
        </ul>
        <button type="button" onClick={onClose}>
          Got it
        </button>
      </div>
    </div>
  );
}

type LoadState = "loading" | "ready" | "not-started" | "error";

const MAX_QUESTION_LENGTH = 280;

export function WhoAreYouRoomView({
  gameConfig,
  room,
  players,
  currentPlayer,
  onlineIds,
}: GameRoomViewProps) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const router = useRouter();

  const [howToPlayOpen, setHowToPlayOpen] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
  } | null>(null);
  const requestConfirm = useCallback(
    (message: string, onConfirm: () => void, confirmLabel = "Confirm") => {
      setConfirmDialog({ message, confirmLabel, onConfirm });
    },
    []
  );

  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [characters, setCharacters] = useState<CharacterRow[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [setupState, setSetupState] = useState<WhoAreYouSetupState | null>(null);
  const [turnState, setTurnState] = useState<WhoAreYouTurnsState | null>(null);
  const [ownSelection, setOwnSelection] = useState<OwnSelectionRow | null>(null);
  const [readyPlayerIds, setReadyPlayerIds] = useState<Set<string>>(new Set());
  const [boardsByTarget, setBoardsByTarget] = useState<Map<string, BoardRow>>(new Map());
  // Local-first cross-off state per target board — mirrors Who Am I's
  // `crossedOff` exactly. Seeded from the DB only on initial load (and the
  // begin-turns board reload), then updated optimistically on tap and
  // persisted best-effort. The realtime and resync handlers deliberately do
  // NOT touch this: a board-row echo / refetch can carry a
  // crossed_off_character_ids snapshot taken before a tap's UPDATE committed,
  // and re-applying it would make a card flicker back for a beat.
  const [crossedOffByTarget, setCrossedOffByTarget] = useState<
    Map<string, Set<string>>
  >(new Map());
  const [questions, setQuestions] = useState<QuestionLogRow[]>([]);
  const [endedAt, setEndedAt] = useState<string | null>(null);

  // ---- character picker draft --------------------------------------------
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [beginTurnsBusy, setBeginTurnsBusy] = useState(false);

  // ---- turn loop drafts --------------------------------------------------
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [guessMode, setGuessMode] = useState(false);
  const [questionDraft, setQuestionDraft] = useState("");
  const [askError, setAskError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [answerMode, setAnswerMode] = useState<"choose" | "other">("choose");
  const [otherAnswerDraft, setOtherAnswerDraft] = useState("");
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [answering, setAnswering] = useState(false);
  const [doneError, setDoneError] = useState<string | null>(null);
  const [endingTurn, setEndingTurn] = useState(false);
  // "I've asked/guessed this opponent (player id) and their answer is in —
  // waiting for the player to press "I'm Done" before the UI moves to the
  // next chat." The game state itself advances server-side; this only
  // paces the UI (no auto-jumping between chats mid-turn), and tracks the
  // exact opponent so the "X answered" message is always accurate.
  const [pendingAdvanceId, setPendingAdvanceId] = useState<string | null>(null);
  const [guessSubmitting, setGuessSubmitting] = useState(false);
  const [guessError, setGuessError] = useState<string | null>(null);
  const [endGameSubmitting, setEndGameSubmitting] = useState(false);
  const [endGameError, setEndGameError] = useState<string | null>(null);
  const [playAgainSubmitting, setPlayAgainSubmitting] = useState(false);
  const [playAgainError, setPlayAgainError] = useState<string | null>(null);

  // ---- recap -------------------------------------------------------------
  const [recapPlayers, setRecapPlayers] = useState<WhoAreYouRecapPlayer[]>([]);
  const [recapLoading, setRecapLoading] = useState(false);
  const [recapError, setRecapError] = useState<string | null>(null);

  const nicknameFor = useCallback(
    (playerId: string) => players.find((p) => p.id === playerId)?.nickname ?? "Someone",
    [players]
  );

  // ---- initial load ------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const { data: charRows, error: charError } = await supabase
          .from("characters")
          .select("id, name, image_url")
          .eq("active", true)
          .order("name", { ascending: true });
        if (charError) throw new Error(charError.message);
        if (cancelled) return;
        setCharacters((charRows ?? []) as CharacterRow[]);

        const { data: sessionRow, error: sessionError } = await supabase
          .from("game_sessions")
          .select("id, state, ended_at")
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
        setEndedAt((sessionRow.ended_at as string | null) ?? null);

        if (isWhoAreYouTurnsState(sessionRow.state)) {
          setTurnState(sessionRow.state);
          setSetupState(null);
        } else if (isWhoAreYouSetupState(sessionRow.state)) {
          setSetupState(sessionRow.state);
          setTurnState(null);
        }

        const { data: selectionRow, error: selectionError } = await supabase
          .from("who_are_you_selections")
          .select("session_id, player_id, character_id")
          .eq("session_id", sessionRow.id)
          .eq("player_id", currentPlayer.id)
          .maybeSingle();
        if (selectionError) throw new Error(selectionError.message);
        if (cancelled) return;
        setOwnSelection((selectionRow as OwnSelectionRow | null) ?? null);

        const { data: readyRows, error: readyError } = await supabase
          .from("who_are_you_ready")
          .select("player_id")
          .eq("session_id", sessionRow.id);
        if (readyError) throw new Error(readyError.message);
        if (cancelled) return;
        setReadyPlayerIds(new Set((readyRows ?? []).map((r) => r.player_id as string)));

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

        // Viewer's boards only (RLS). Empty during setup before begin-turns.
        const { data: boardRows, error: boardsError } = await supabase
          .from("who_are_you_boards")
          .select(
            "session_id, viewer_player_id, target_player_id, crossed_off_character_ids, is_solved, guessed_character_id, solved_turn_number"
          )
          .eq("session_id", sessionRow.id)
          .eq("viewer_player_id", currentPlayer.id);
        if (boardsError) throw new Error(boardsError.message);
        if (cancelled) return;
        setBoardsByTarget(
          new Map(
            ((boardRows ?? []) as BoardRow[]).map((row) => [row.target_player_id, row])
          )
        );
        setCrossedOffByTarget(
          new Map(
            ((boardRows ?? []) as BoardRow[]).map((row) => [
              row.target_player_id,
              new Set(row.crossed_off_character_ids ?? []),
            ])
          )
        );

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

  // ---- realtime ----------------------------------------------------------
  useEffect(() => {
    if (!sessionId) return;

    const channel = supabase
      .channel(`who-are-you:${sessionId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "who_are_you_ready", filter: `session_id=eq.${sessionId}` },
        (payload) => {
          const row = payload.new as { player_id: string };
          setReadyPlayerIds((prev) => new Set(prev).add(row.player_id));
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "game_sessions", filter: `id=eq.${sessionId}` },
        (payload) => {
          const row = payload.new as { state?: unknown; ended_at?: string | null };
          if (isWhoAreYouTurnsState(row.state)) {
            setTurnState(row.state);
            setSetupState(null);
          } else if (isWhoAreYouSetupState(row.state)) {
            setSetupState(row.state);
          }
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
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "who_are_you_boards",
          filter: `session_id=eq.${sessionId}`,
        },
        (payload) => {
          const row = (payload.new ?? payload.old) as BoardRow | undefined;
          if (!row || row.viewer_player_id !== currentPlayer.id) return;
          if (payload.eventType === "DELETE") {
            setBoardsByTarget((prev) => {
              const next = new Map(prev);
              next.delete(row.target_player_id);
              return next;
            });
            return;
          }
          setBoardsByTarget((prev) => new Map(prev).set(row.target_player_id, row));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, sessionId, currentPlayer.id]);

  // ---- reconnect resync --------------------------------------------------
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

        const { data: sessionRow } = await supabase
          .from("game_sessions")
          .select("state, ended_at")
          .eq("id", sessionId)
          .maybeSingle();
        if (sessionRow) {
          if (isWhoAreYouTurnsState(sessionRow.state)) {
            setTurnState(sessionRow.state);
            setSetupState(null);
          } else if (isWhoAreYouSetupState(sessionRow.state)) {
            setSetupState(sessionRow.state);
          }
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

        const { data: boardRows } = await supabase
          .from("who_are_you_boards")
          .select(
            "session_id, viewer_player_id, target_player_id, crossed_off_character_ids, is_solved, guessed_character_id, solved_turn_number"
          )
          .eq("session_id", sessionId)
          .eq("viewer_player_id", currentPlayer.id);
        if (boardRows) {
          setBoardsByTarget(
            new Map((boardRows as BoardRow[]).map((row) => [row.target_player_id, row]))
          );
        }
      } catch {
        // best-effort
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
  }, [supabase, sessionId, currentPlayer.id]);

  // ---- begin turns once everyone has picked ------------------------------
  const allPicked = players.length > 0 && players.every((p) => readyPlayerIds.has(p.id));

  useEffect(() => {
    if (!sessionId || !allPicked || turnState || endedAt || beginTurnsBusy) return;
    if (!setupState) return;

    let cancelled = false;
    async function begin() {
      setBeginTurnsBusy(true);
      try {
        const response = await fetch("/api/games/who-are-you/begin-turns", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        });
        const payload = await response.json().catch(() => ({}) as { error?: string; state?: unknown });
        if (!response.ok) throw new Error(payload.error ?? "Failed to begin turns.");
        if (!cancelled && isWhoAreYouTurnsState(payload.state)) {
          setTurnState(payload.state);
          setSetupState(null);
        }
        // Reload boards after creation
        if (!cancelled && sessionId) {
          const { data: boardRows } = await supabase
            .from("who_are_you_boards")
            .select(
              "session_id, viewer_player_id, target_player_id, crossed_off_character_ids, is_solved, guessed_character_id, solved_turn_number"
            )
            .eq("session_id", sessionId)
            .eq("viewer_player_id", currentPlayer.id);
          if (boardRows) {
            setBoardsByTarget(
              new Map((boardRows as BoardRow[]).map((row) => [row.target_player_id, row]))
            );
            setCrossedOffByTarget(
              new Map(
                (boardRows as BoardRow[]).map((row) => [
                  row.target_player_id,
                  new Set(row.crossed_off_character_ids ?? []),
                ])
              )
            );
          }
        }
      } catch (err) {
        console.error("begin-turns failed:", err);
      } finally {
        if (!cancelled) setBeginTurnsBusy(false);
      }
    }
    void begin();
    return () => {
      cancelled = true;
    };
  }, [sessionId, allPicked, turnState, endedAt, beginTurnsBusy, setupState, supabase, currentPlayer.id]);

  // ---- recap load once ended ---------------------------------------------
  useEffect(() => {
    if (!sessionId || !endedAt) return;
    let cancelled = false;

    async function loadRecap() {
      setRecapLoading(true);
      setRecapError(null);
      try {
        const { data, error } = await supabase
          .from("who_are_you_recap")
          .select("session_id, player_id, character_id")
          .eq("session_id", sessionId);
        if (error) throw new Error(error.message);
        if (cancelled) return;
        const characterById = new Map(characters.map((c) => [c.id, c]));
        const rows = (data ?? []) as Array<{ player_id: string; character_id: string }>;
        const byPlayer = new Map(rows.map((r) => [r.player_id, r.character_id]));
        setRecapPlayers(
          players.map((p) => {
            const characterId = byPlayer.get(p.id);
            const character = characterId ? characterById.get(characterId) : undefined;
            return {
              playerId: p.id,
              nickname: p.nickname,
              isYou: p.id === currentPlayer.id,
              characterName: character?.name ?? null,
              characterImageUrl: character?.image_url ?? null,
            };
          })
        );
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
  }, [supabase, sessionId, endedAt, characters, players, currentPlayer.id]);

  // ---- picker actions ----------------------------------------------------
  const pickForMe = useCallback(() => {
    if (characters.length === 0) return;
    const index = Math.floor(Math.random() * characters.length);
    setSelectedCharacterId(characters[index]!.id);
  }, [characters]);

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
      if (selectionError && selectionError.code !== "23505") {
        throw new Error(selectionError.message);
      }

      const { error: readyError } = await supabase.from("who_are_you_ready").insert({
        session_id: sessionId,
        player_id: currentPlayer.id,
      });
      if (readyError && readyError.code !== "23505") throw new Error(readyError.message);

      setOwnSelection({
        session_id: sessionId,
        player_id: currentPlayer.id,
        character_id: selectedCharacterId,
      });
      setReadyPlayerIds((prev) => new Set(prev).add(currentPlayer.id));
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : "Failed to lock in your pick.");
    } finally {
      setConfirming(false);
    }
  }, [supabase, sessionId, selectedCharacterId, currentPlayer.id]);

  // ---- board cross-offs (per selected opponent) --------------------------
  const selectedBoard = selectedPlayerId ? boardsByTarget.get(selectedPlayerId) : undefined;
  // Local-first (see crossedOffByTarget above) — realtime/resync never
  // overwrite it, so a tap is never stomped by a stale board echo.
  const crossedOff = useMemo(
    () => crossedOffByTarget.get(selectedPlayerId ?? "") ?? new Set<string>(),
    [crossedOffByTarget, selectedPlayerId]
  );

  const persistCrossedOff = useCallback(
    async (targetId: string, next: Set<string>) => {
      if (!sessionId) return;
      const { error } = await supabase
        .from("who_are_you_boards")
        .update({ crossed_off_character_ids: Array.from(next) })
        .eq("session_id", sessionId)
        .eq("viewer_player_id", currentPlayer.id)
        .eq("target_player_id", targetId);
      if (error) {
        // Non-fatal: local state already reflects the tap, and the next
        // toggle re-sends the full set anyway (same as Who Am I).
        console.error("Failed to save crossed-off state:", error.message);
      }
    },
    [supabase, sessionId, currentPlayer.id]
  );

  function toggleCharacter(characterId: string) {
    if (!selectedPlayerId) return;
    setCrossedOffByTarget((prev) => {
      const nextSet = new Set(prev.get(selectedPlayerId) ?? []);
      if (nextSet.has(characterId)) nextSet.delete(characterId);
      else nextSet.add(characterId);
      void persistCrossedOff(selectedPlayerId, nextSet);
      const next = new Map(prev);
      next.set(selectedPlayerId, nextSet);
      return next;
    });
  }

  // ---- turn helpers ------------------------------------------------------
  const askerId = turnState ? currentAskerId(turnState) : null;
  const responderId = turnState ? currentResponderId(turnState) : null;
  const askTargetId = turnState ? currentAskTargetId(turnState) : null;
  const isMyTurnToAsk =
    turnState?.turnPhase === "asking" && askerId === currentPlayer.id;
  const isMyTurnToAnswer =
    turnState?.turnPhase === "answering" && responderId === currentPlayer.id;
  const isReviewingMyTurn =
    turnState?.turnPhase === "reviewing" && askerId === currentPlayer.id;
  const activeQuestion =
    turnState?.activeQuestionId != null
      ? (questions.find((q) => q.id === turnState.activeQuestionId) ?? null)
      : null;
  const hasFinishedAsking =
    turnState?.finishedAskerIds.includes(currentPlayer.id) ?? false;
  const canGuess =
    !endedAt &&
    !hasFinishedAsking &&
    isMyTurnToAsk &&
    askTargetId === selectedPlayerId &&
    !!selectedPlayerId &&
    !isPairingSolved(turnState?.solvedPairings ?? [], currentPlayer.id, selectedPlayerId);

  const otherPlayers = useMemo(
    () => players.filter((p) => p.id !== currentPlayer.id),
    [players, currentPlayer.id]
  );

  const conversationsByPlayer = useMemo(() => {
    const map = new Map<string, QuestionLogRow[]>();
    for (const player of otherPlayers) {
      map.set(
        player.id,
        questions.filter(
          (q) =>
            (q.asking_player_id === currentPlayer.id && q.target_player_id === player.id) ||
            (q.asking_player_id === player.id && q.target_player_id === currentPlayer.id)
        )
      );
    }
    return map;
  }, [otherPlayers, questions, currentPlayer.id]);

  useEffect(() => {
    if (selectedPlayerId) return;
    if (otherPlayers.length > 0) setSelectedPlayerId(otherPlayers[0]!.id);
  }, [otherPlayers, selectedPlayerId]);

  useEffect(() => {
    // Auto-select only when the game is directing *us* somewhere we haven't
    // already engaged with: answering someone's question, or a fresh ask
    // target. Never yank the selection off the chat we just asked once the
    // answer is in — that's the manual "I'm Done → next chat" pacing.
    if (isMyTurnToAnswer && askerId) {
      setSelectedPlayerId(askerId);
      setGuessMode(false);
    } else if (isMyTurnToAsk && askTargetId && !pendingAdvanceId) {
      setSelectedPlayerId(askTargetId);
      setGuessMode(false);
    }
  }, [isMyTurnToAsk, askTargetId, isMyTurnToAnswer, askerId, pendingAdvanceId]);

  // A new asker (new turn) starts fresh — no pending advance carries over.
  useEffect(() => {
    if (askerId !== currentPlayer.id) setPendingAdvanceId(null);
  }, [askerId, currentPlayer.id]);

  type ConversationStatus = "asking" | "your-turn" | "waiting" | "solved";
  function conversationStatus(playerId: string): { label: string; tone: ConversationStatus } {
    if (
      turnState &&
      isPairingSolved(turnState.solvedPairings, currentPlayer.id, playerId)
    ) {
      return { label: "Solved", tone: "solved" };
    }
    if (!turnState) return { label: "Waiting", tone: "waiting" };
    if (turnState.turnPhase === "asking") {
      if (isMyTurnToAsk && askTargetId === playerId) return { label: "Asking", tone: "asking" };
      if (askerId === playerId && askTargetId === currentPlayer.id) {
        return { label: "Your turn", tone: "your-turn" };
      }
    }
    if (turnState.turnPhase === "answering") {
      if (askerId === currentPlayer.id && responderId === playerId) {
        return { label: "Answering", tone: "asking" };
      }
      if (askerId === playerId && responderId === currentPlayer.id) {
        return { label: "Your turn", tone: "your-turn" };
      }
    }
    if (turnState.turnPhase === "reviewing" && askerId === currentPlayer.id) {
      return { label: "Reviewing", tone: "waiting" };
    }
    return { label: "Waiting", tone: "waiting" };
  }

  const selectedPlayer = selectedPlayerId
    ? players.find((p) => p.id === selectedPlayerId)
    : undefined;
  const selectedConversation = selectedPlayerId
    ? (conversationsByPlayer.get(selectedPlayerId) ?? [])
    : [];
  const canAskInSelectedChat = isMyTurnToAsk && askTargetId === selectedPlayerId;
  // After asking (or guessing) an opponent and getting their answer back, the
  // game state has already moved on to the next target — but we hold the UI
  // on the finished chat and show "I'm Done" so the player paces the move
  // themselves instead of the header jumping chats under them.
  const advanceAfterAsk =
    isMyTurnToAsk && !!pendingAdvanceId && !!askTargetId && askTargetId !== pendingAdvanceId;
  const canAnswerInSelectedChat =
    isMyTurnToAnswer && askerId === selectedPlayerId && !!activeQuestion;
  const selectedSolved =
    !!selectedPlayerId &&
    !!turnState &&
    isPairingSolved(turnState.solvedPairings, currentPlayer.id, selectedPlayerId);

  async function submitQuestion(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sessionId || !askTargetId) return;
    const trimmedText = questionDraft.trim();
    if (trimmedText.length === 0) return;
    setAsking(true);
    setAskError(null);
    try {
      const response = await fetch("/api/games/who-are-you/question", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, questionText: trimmedText }),
      });
      const payload = await response.json().catch(() => ({}) as { error?: string; state?: unknown });
      if (!response.ok) throw new Error(payload.error ?? "Failed to ask.");
      if (isWhoAreYouTurnsState(payload.state)) setTurnState(payload.state);
      setQuestionDraft("");
      setGuessMode(false);
      setPendingAdvanceId(askTargetId);
    } catch (err) {
      setAskError(err instanceof Error ? err.message : "Failed to ask.");
    } finally {
      setAsking(false);
    }
  }

  async function submitAnswer(answer: string) {
    if (!sessionId) return;
    setAnswering(true);
    setAnswerError(null);
    try {
      const response = await fetch("/api/games/who-are-you/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, answer }),
      });
      const payload = await response.json().catch(() => ({}) as { error?: string; state?: unknown });
      if (!response.ok) throw new Error(payload.error ?? "Failed to answer.");
      if (isWhoAreYouTurnsState(payload.state)) setTurnState(payload.state);
      setAnswerMode("choose");
      setOtherAnswerDraft("");
    } catch (err) {
      setAnswerError(err instanceof Error ? err.message : "Failed to answer.");
    } finally {
      setAnswering(false);
    }
  }

  async function submitOtherAnswer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = otherAnswerDraft.trim();
    if (!trimmed) return;
    await submitAnswer(trimmed);
  }

  async function submitDone() {
    if (!sessionId) return;
    setEndingTurn(true);
    setDoneError(null);
    try {
      const response = await fetch("/api/games/who-are-you/done", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const payload = await response.json().catch(() => ({}) as { error?: string; state?: unknown });
      if (!response.ok) throw new Error(payload.error ?? "Failed to end turn.");
      if (isWhoAreYouTurnsState(payload.state)) setTurnState(payload.state);
    } catch (err) {
      setDoneError(err instanceof Error ? err.message : "Failed to end turn.");
    } finally {
      setEndingTurn(false);
    }
  }

  function requestGuessForCharacter(characterId: string) {
    if (!selectedPlayerId) return;
    const character = characters.find((c) => c.id === characterId);
    requestConfirm(
      character
        ? `Guess "${character.name}" for ${nicknameFor(selectedPlayerId)}? A wrong guess wastes this opponent's slot this turn.`
        : "Submit this guess? A wrong guess wastes this opponent's slot this turn.",
      () => void submitGuessForCharacter(characterId),
      "Guess"
    );
  }

  async function submitGuessForCharacter(characterId: string) {
    if (!sessionId || !selectedPlayerId) return;
    setGuessSubmitting(true);
    setGuessError(null);
    try {
      const response = await fetch("/api/games/who-are-you/guess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          characterId,
          targetPlayerId: selectedPlayerId,
        }),
      });
      const payload = await response.json().catch(
        () => ({}) as { error?: string; state?: unknown; correct?: boolean; gameEnded?: boolean }
      );
      if (!response.ok) throw new Error(payload.error ?? "Failed to submit guess.");
      if (isWhoAreYouTurnsState(payload.state)) setTurnState(payload.state);
      setGuessMode(false);
      setPendingAdvanceId(selectedPlayerId);
      if (payload.gameEnded) setEndedAt(new Date().toISOString());
    } catch (err) {
      setGuessError(err instanceof Error ? err.message : "Failed to submit guess.");
    } finally {
      setGuessSubmitting(false);
    }
  }

  async function endGame() {
    if (!sessionId) return;
    setEndGameSubmitting(true);
    setEndGameError(null);
    try {
      const response = await fetch("/api/games/who-are-you/end", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const payload = await response.json().catch(() => ({}) as { error?: string });
      if (!response.ok) throw new Error(payload.error ?? "Failed to end the game.");
      setEndedAt(new Date().toISOString());
    } catch (err) {
      setEndGameError(err instanceof Error ? err.message : "Failed to end the game.");
    } finally {
      setEndGameSubmitting(false);
    }
  }

  // ---- top bar: "Leave Game" — non-host players only (the host sees "End
  // Game" in this same slot instead, wired to endGame above). Purely
  // client-side — just navigates the player back home; the disconnect
  // itself is already handled by the same pagehide/visibility effects the
  // platform core uses for any tab-close. --------------------------------
  function handleLeaveGame() {
    requestConfirm("Leave this game and go back home?", () => router.push("/"), "Leave Game");
  }

  async function handlePlayAgain() {
    setPlayAgainSubmitting(true);
    setPlayAgainError(null);
    try {
      const response = await fetch("/api/games/who-are-you/play-again", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId: room.id }),
      });
      const payload = await response.json().catch(() => ({}) as { error?: string });
      if (!response.ok) throw new Error(payload.error ?? "Failed to return to lobby.");
    } catch (err) {
      setPlayAgainError(err instanceof Error ? err.message : "Failed to return to lobby.");
    } finally {
      setPlayAgainSubmitting(false);
    }
  }

  // ---- early returns -----------------------------------------------------
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

  // ---- recap -------------------------------------------------------------
  if (endedAt && turnState) {
    const outcome = getGameOutcome(turnState);
    const characterById = new Map(characters.map((c) => [c.id, c]));
    return (
      <div className="who-are-you-shell who-am-i-shell">
        <WhoAreYouRecap
          players={recapPlayers}
          turnOrder={turnState.turnOrder}
          solvedPairings={turnState.solvedPairings}
          questions={questions.map((q) => ({
            id: q.id,
            asking_player_id: q.asking_player_id,
            target_player_id: q.target_player_id,
            question_text: q.question_text,
            answers: q.answers as Record<string, string>,
            is_guess: q.is_guess,
            guessedCharacterName: q.guessed_character_id
              ? (characterById.get(q.guessed_character_id)?.name ?? null)
              : null,
          }))}
          nicknameFor={nicknameFor}
          baseMode={turnState.baseMode}
          firstWinEnds={turnState.firstWinEnds}
          winnerPlayerIds={outcome.winnerPlayerIds}
          loserPlayerIds={outcome.loserPlayerIds}
          loading={recapLoading}
          error={recapError}
          isHost={currentPlayer.is_host}
          onPlayAgain={handlePlayAgain}
          playAgainSubmitting={playAgainSubmitting}
          playAgainError={playAgainError}
          onPlayMoreGames={() => router.push(`/games?room=${room.code}`)}
        />
      </div>
    );
  }

  // ---- setup phase -------------------------------------------------------
  if (!turnState) {
    const setupStatus = ownSelection
      ? allPicked
        ? beginTurnsBusy
          ? "Everyone's picked — starting…"
          : "Everyone's picked! Starting…"
        : "Waiting for players to pick…"
      : "Pick your character";

    return (
      <div className="who-are-you-shell who-am-i-shell">
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
          <div className="who-am-i-topbar-center">
            <span className="who-am-i-status-badge who-am-i-status-badge-waiting">
              {setupStatus}
            </span>
          </div>
          <div className="who-am-i-topbar-right">
            <button
              type="button"
              className="who-am-i-btn-outline"
              onClick={() => setHowToPlayOpen(true)}
            >
              How to Play
            </button>
          </div>
        </header>

        <WhoAreYouHowToPlayModal
          open={howToPlayOpen}
          onClose={() => setHowToPlayOpen(false)}
          description={gameConfig?.description}
        />

        {ownSelection ? (
          <section className="who-are-you-waiting" aria-labelledby="who-are-you-waiting-heading">
            <h2 id="who-are-you-waiting-heading">
              You picked {pickedCharacter?.name ?? "your character"}
            </h2>
            {pickedCharacter && (
              <div className="who-are-you-picked-card" {...cardSoundHandlers(pickedCharacter.name)}>
                <span className="who-am-i-card-image">
                  <Image src={pickedCharacter.image_url} alt="" fill sizes="96px" draggable={false} />
                </span>
                <span className="who-am-i-card-name">{pickedCharacter.name}</span>
              </div>
            )}
            <p className="muted">
              Your pick is locked in and secret from everyone else until they guess it.
            </p>

            {allPicked ? (
              <p className="who-are-you-all-ready" role="status">
                {beginTurnsBusy
                  ? "Everyone's picked — starting the turn loop…"
                  : "Everyone's picked! Starting the turn loop…"}
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
          <div className="who-am-i-layout who-am-i-layout-deck-only">
          <section className="who-am-i-deck" aria-labelledby="who-are-you-picker-heading">
            <div className="who-am-i-deck-header">
              <div>
                <h2 id="who-are-you-picker-heading">Pick your character</h2>
                <p className="muted">
                  Everyone else will try to guess who you picked. Choose wisely.
                </p>
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
                        className={`who-am-i-card${isSelected ? " selected" : ""}`}          onClick={() => {
            playCharacterSound(character.name);
            setSelectedCharacterId(character.id);
          }}
          aria-pressed={isSelected}
          aria-label={`${character.name}${isSelected ? ", selected" : ", tap to select"}`}
                        disabled={confirming}
                      >
                        <span className="who-am-i-card-image">
                          <Image src={character.image_url} alt="" fill sizes="96px" draggable={false} />
                        </span>
                        <span className="who-am-i-card-name">{character.name}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="who-am-i-done-cta">
              <button
                type="button"
                onClick={confirmPick}
                disabled={!selectedCharacterId || confirming}
              >
                {confirming ? "Locking in…" : "Done"}
              </button>
            </div>
          </section>
          </div>
        )}
      </div>
    );
  }

  // ---- turns phase -------------------------------------------------------
  const remaining = characters.length - crossedOff.size;
  const myRival = rivalOf(turnState.turnOrder, currentPlayer.id);
  const statusSubtext = !turnState
    ? ""
    : turnState.turnPhase === "asking"
      ? isMyTurnToAsk
        ? `Ask or guess for ${nicknameFor(askTargetId ?? "")}.`
        : `Waiting for ${nicknameFor(askerId ?? "")}…`
      : turnState.turnPhase === "answering"
        ? isMyTurnToAnswer
          ? "Your turn to answer."
          : `Waiting for ${nicknameFor(responderId ?? "")} to answer.`
        : isReviewingMyTurn
          ? "Review, then press I'm Done."
          : `Waiting for ${nicknameFor(askerId ?? "")} to finish.`;

  return (
    <div className="who-are-you-shell who-am-i-shell">
      <header className="who-am-i-topbar">
        <div className="who-am-i-topbar-left">
          {/* Hover (desktop) or tap-and-hold (mobile) your own avatar to
              peek at the character you picked — it cross-fades in over your
              mushroom avatar and fades back when you stop. (Who Are You? is
              the "you know your own character" game, so this is safe to
              show.) Driven by :hover/:active in CSS — the no-op touch
              handler below is invisible and just makes iOS Safari apply
              :active while touching; no click affordance. */}
          <div
            className="who-am-i-avatar-reveal"
            onTouchStart={() => {}}
            title={pickedCharacter ? `You are ${pickedCharacter.name}` : undefined}
          >
            <span className="who-am-i-avatar-reveal-own">
              <AvatarIcon
                mushroomIndex={currentPlayer.mushroom_index}
                accessoryIndex={currentPlayer.accessory_index}
                size={40}
              />
            </span>
            {pickedCharacter && (
              <span className="who-am-i-avatar-reveal-character">
                <Image
                  src={pickedCharacter.image_url}
                  alt=""
                  fill
                  sizes="40px"
                  draggable={false}
                />
              </span>
            )}
          </div>
          <div className="who-am-i-topbar-left-info">
            <strong>{currentPlayer.nickname}</strong>
            <span className="muted">
              Turn {turnState.turnNumber}
              {turnState.baseMode === "rival-match" && myRival
                ? ` · Rival: ${nicknameFor(myRival)}`
                : ""}
            </span>
          </div>
        </div>
        <div className="who-am-i-topbar-center">
          <span className="who-am-i-status-badge who-am-i-status-badge-waiting">{statusSubtext}</span>
        </div>
        <div className="who-am-i-topbar-right">
          <button type="button" className="who-am-i-btn-outline" onClick={() => setHowToPlayOpen(true)}>
            <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
              <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.6" />
              <path
                d="M7.6 7.8a2.4 2.4 0 1 1 3.5 2.14c-.66.36-1.1.86-1.1 1.56v.3"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="10" cy="14.3" r="0.9" fill="currentColor" />
            </svg>
            How to Play
          </button>
          {/* Host gets "End Game" here instead of "Leave Game" — same slot
              and design as Who Am I's header, so both games read identically. */}
          {currentPlayer.is_host ? (
            <button
              type="button"
              className="who-am-i-btn-leave"
              disabled={endGameSubmitting}
              onClick={() =>
                requestConfirm("End the game for everyone?", () => void endGame(), "End Game")
              }
            >
              <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
                <circle cx="10" cy="10" r="7.25" stroke="currentColor" strokeWidth="1.6" />
                <path
                  d="M7.4 7.4l5.2 5.2M12.6 7.4l-5.2 5.2"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
              {endGameSubmitting ? "Ending…" : "End Game"}
            </button>
          ) : (
            <button type="button" className="who-am-i-btn-leave" onClick={handleLeaveGame}>
              <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
                <path
                  d="M8 4H4.75A.75.75 0 0 0 4 4.75v10.5c0 .414.336.75.75.75H8"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M12.5 13.5 16 10l-3.5-3.5M16 10H8"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Leave Game
            </button>
          )}
        </div>
      </header>
      {endGameError && (
        <p className="field-error" role="alert">
          {endGameError}
        </p>
      )}

      <WhoAreYouHowToPlayModal
        open={howToPlayOpen}
        onClose={() => setHowToPlayOpen(false)}
        description={gameConfig?.description}
      />

      {confirmDialog && (
        <div
          className="who-am-i-modal-backdrop"
          role="presentation"
          onClick={() => setConfirmDialog(null)}
        >
          <div
            className="who-am-i-modal who-am-i-confirm-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="who-are-you-confirm-heading"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="who-are-you-confirm-heading">Are you sure?</h2>
            <p>{confirmDialog.message}</p>
            <div className="who-am-i-confirm-actions">
              <button
                type="button"
                className="who-am-i-btn-outline"
                onClick={() => setConfirmDialog(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="who-am-i-btn-leave"
                onClick={() => {
                  const { onConfirm } = confirmDialog;
                  setConfirmDialog(null);
                  onConfirm();
                }}
              >
                {confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="who-am-i-layout">
        <nav className="who-am-i-sidebar" aria-label="Conversations">
          <ul className="who-am-i-conversation-list" role="list">
            {otherPlayers.map((player) => {
              const status = conversationStatus(player.id);
              const isSelected = player.id === selectedPlayerId;
              return (
                <li key={player.id}>
                  <button
                    type="button"
                    className={`who-am-i-conversation-item${isSelected ? " selected" : ""}${
                      status.tone === "solved" ? " who-are-you-conversation-solved" : ""
                    }`}
                    onClick={() => {
                      setSelectedPlayerId(player.id);
                      setGuessMode(false);
                    }}
                    aria-current={isSelected}
                    aria-label={`${player.nickname} — ${status.label}`}
                    title={`${player.nickname} — ${status.label}`}
                  >
                    <AvatarIcon
                      mushroomIndex={player.mushroom_index}
                      accessoryIndex={player.accessory_index}
                      size={44}
                      wiggle={false}
                    />
                    <span
                      className={`who-am-i-conversation-status-dot who-am-i-status-${
                        status.tone === "solved" ? "reviewing" : status.tone
                      }`}
                      aria-hidden="true"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="who-am-i-chat-column">
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
                    <span className="muted">
                      {selectedSolved
                        ? "Solved"
                        : `${selectedConversation.filter((q) => !q.is_guess).length} question${
                            selectedConversation.filter((q) => !q.is_guess).length === 1 ? "" : "s"
                          }`}
                      {turnState.baseMode === "rival-match" && myRival === selectedPlayer.id
                        ? " · your rival"
                        : ""}
                    </span>
                  </div>
                </div>

                <div className="who-am-i-chat-messages">
                  {selectedConversation.length === 0 && (
                    <p className="muted who-am-i-chat-empty">
                      No questions yet — this conversation is empty.
                    </p>
                  )}
                  {selectedConversation.map((q) => {
                    if (q.is_guess) {
                      const iAsked = q.asking_player_id === currentPlayer.id;
                      const wasCorrect = q.answers[q.asking_player_id] === "correct";
                      const guessedName = q.guessed_character_id
                        ? (characters.find((c) => c.id === q.guessed_character_id)?.name ??
                          "a character")
                        : "a character";
                      return (
                        <div key={q.id} className="who-am-i-chat-exchange">
                          <div
                            className={`who-am-i-message ${
                              iAsked ? "who-am-i-message-you" : "who-am-i-message-them"
                            }`}
                          >
                            <span className="who-am-i-message-sender">
                              {iAsked ? "You" : selectedPlayer.nickname}
                            </span>
                            <p>
                              Guessed <strong>{guessedName}</strong> —{" "}
                              <span
                                className={
                                  wasCorrect
                                    ? "who-am-i-guess-result-correct"
                                    : "who-am-i-guess-result-incorrect"
                                }
                              >
                                {wasCorrect ? "Correct!" : "Incorrect"}
                              </span>
                            </p>
                          </div>
                        </div>
                      );
                    }
                    const iAsked = q.asking_player_id === currentPlayer.id;
                    const answer = q.target_player_id
                      ? q.answers[q.target_player_id]
                      : undefined;
                    return (
                      <div key={q.id} className="who-am-i-chat-exchange">
                        <div
                          className={`who-am-i-message ${
                            iAsked ? "who-am-i-message-you" : "who-am-i-message-them"
                          }`}
                        >
                          <span className="who-am-i-message-sender">
                            {iAsked ? "You" : selectedPlayer.nickname}
                          </span>
                          <p>{q.question_text}</p>
                        </div>
                        {answer !== undefined ? (
                          <div
                            className={`who-am-i-message ${
                              iAsked ? "who-am-i-message-them" : "who-am-i-message-you"
                            }${
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
                  {canAskInSelectedChat && !selectedSolved && (
                    <form className="who-am-i-ask-form" onSubmit={submitQuestion}>
                      <input
                        value={questionDraft}
                        onChange={(e) => setQuestionDraft(e.target.value)}
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
                        <strong>{selectedPlayer.nickname} asks you:</strong>{" "}
                        {activeQuestion.question_text}
                      </p>
                      {answerMode === "choose" ? (
                        <div className="who-am-i-answer-buttons">
                          <button
                            type="button"
                            onClick={() => void submitAnswer("yes")}
                            disabled={answering}
                            aria-label="Answer yes"
                          >
                            Yes
                          </button>
                          <button
                            type="button"
                            onClick={() => void submitAnswer("no")}
                            disabled={answering}
                            aria-label="Answer no"
                          >
                            No
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
                            <button
                              type="submit"
                              disabled={answering || otherAnswerDraft.trim().length === 0}
                            >
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
                      {selectedSolved
                        ? `You've solved ${selectedPlayer.nickname}.`
                        : advanceAfterAsk
                          ? `${pendingAdvanceId ? nicknameFor(pendingAdvanceId) : "They"} answered — press “I'm Done” to continue.`
                          : isReviewingMyTurn
                            ? "Review this turn's answers, then press “I'm Done.”"
                            : `Waiting for your turn to chat with ${selectedPlayer.nickname}.`}
                    </p>
                  )}
                </div>
              </>
            )}
          </section>
        </div>

        <section className="who-am-i-deck" aria-labelledby="who-are-you-deck-heading">
          <div className="who-am-i-deck-header">
            <div>
              <h2 id="who-are-you-deck-heading">
                {selectedPlayer
                  ? `Board for ${selectedPlayer.nickname}`
                  : "Opponent board"}
              </h2>
              <p className="muted">
                {selectedSolved
                  ? "Solved — this board is locked."
                  : "Tap a character to cross it off as you rule it out."}
              </p>
            </div>
            <div className="who-am-i-deck-header-actions">
              <span className="who-am-i-deck-counter">{remaining} remaining</span>
              {canGuess && (
                <button
                  type="button"
                  className={`who-am-i-guess-toggle${guessMode ? " active" : ""}`}
                  onClick={() => setGuessMode((v) => !v)}
                  disabled={guessSubmitting}
                >
                  {guessMode ? "Cancel guess" : "Guess their character"}
                </button>
              )}
            </div>
          </div>

          {guessMode && (
            <p className="who-am-i-guess-hint" role="status">
              Tap a card below to guess — a wrong guess wastes this opponent's slot this turn.
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
                if (guessMode && !selectedSolved) {
                  return (
                    <li key={character.id}>
                      <button
                        type="button"
                        className={`who-am-i-card${isCrossedOff ? " crossed-off" : ""}`}          onClick={() => {
            if (!isCrossedOff) {
              playCharacterSound(character.name);
              requestGuessForCharacter(character.id);
            }
          }}
          disabled={isCrossedOff || guessSubmitting}
          aria-label={`Guess ${character.name}`}
                      >
                        <span className="who-am-i-card-image">
                          <Image src={character.image_url} alt="" fill sizes="96px" draggable={false} />
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
          onClick={() => {
            if (!selectedSolved) {
              playCharacterSound(character.name);
              toggleCharacter(character.id);
            }
          }}
          aria-pressed={isCrossedOff}
          aria-label={`${character.name}${isCrossedOff ? ", crossed off" : ", tap to cross off"}`}
                      disabled={selectedSolved}
                    >
                      <span className="who-am-i-card-image">
                        <Image src={character.image_url} alt="" fill sizes="96px" draggable={false} />
                      </span>
                      <span className="who-am-i-card-name">{character.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {(isReviewingMyTurn || advanceAfterAsk) && (
            <div className="who-am-i-done-cta">
              {doneError && (
                <p className="field-error" role="alert">
                  {doneError}
                </p>
              )}
              {advanceAfterAsk && (
                <p className="muted">
                  {pendingAdvanceId
                    ? `${nicknameFor(pendingAdvanceId)} answered — press “I'm Done” to move on.`
                    : "Answered — press “I'm Done” to move on."}
                </p>
              )}
              <button
                type="button"
                onClick={() => {
                  if (advanceAfterAsk) {
                    // Pacing only: the game state already advanced. Move the
                    // UI to the next ask target (the turn's real end still
                    // goes through the reviewing-phase button below).
                    if (askTargetId) setSelectedPlayerId(askTargetId);
                    setGuessMode(false);
                    setPendingAdvanceId(null);
                  } else {
                    void submitDone();
                  }
                }}
                disabled={endingTurn}
              >
                {endingTurn ? "Ending turn…" : "I'm Done"}
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
