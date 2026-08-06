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
// Deliberately NOT implemented here (that's a separate follow-up phase):
// guessing your identity, "solved" state, the game-end condition, and the
// recap screen. Turn state never marks anyone "solved" in this phase —
// `advanceTurn` (games/who-am-i/logic/turnState.ts) always just walks to
// the next player in the fixed turnOrder ring.
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
// Realtime here is plain Postgres-changes subscriptions on `game_sessions`
// and `questions_log` (same pattern RoomClient already uses for
// rooms/players) — Postgres remains the source of truth either way. The
// richer Broadcast channel (typing indicators, etc. — SPEC.md §9) is
// still Phase 7; this is enough for the turn loop to feel live without it.

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { GameRoomViewProps } from "@/lib/games-registry";
import {
  currentAskerId,
  currentResponderId,
  isWhoAmITurnState,
  type WhoAmITurnState,
} from "@/games/who-am-i/logic/turnState";

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

interface QuestionLogRow {
  id: string;
  session_id: string;
  asking_player_id: string;
  question_text: string;
  created_at: string;
  answers: Record<string, "yes" | "no">;
  resolved: boolean;
}

type LoadState = "loading" | "ready" | "not-started" | "no-assignment" | "error";

const MAX_QUESTION_LENGTH = 280;

export function WhoAmIRoomView({ room, players, currentPlayer }: GameRoomViewProps) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [characters, setCharacters] = useState<CharacterRow[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [crossedOff, setCrossedOff] = useState<Set<string>>(new Set());

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
          .select("id, state")
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

        // Full public question log for this session (questions_log_select_
        // room_members RLS policy), oldest first so it reads top-to-bottom
        // as a scrollable history (SPEC.md §8 "Chat/Log").
        const { data: questionRows, error: questionsError } = await supabase
          .from("questions_log")
          .select("id, session_id, asking_player_id, question_text, created_at, answers, resolved")
          .eq("session_id", sessionRow.id)
          .order("created_at", { ascending: true });
        if (questionsError) throw new Error(questionsError.message);
        if (cancelled) return;
        setQuestions((questionRows ?? []) as QuestionLogRow[]);

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
          const nextState = (payload.new as { state?: unknown }).state;
          if (isWhoAmITurnState(nextState)) setTurnState(nextState);
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
      if (isWhoAmITurnState(payload.state)) setTurnState(payload.state);
      setQuestionDraft("");
    } catch (err) {
      setAskError(err instanceof Error ? err.message : "Failed to submit question.");
    } finally {
      setAsking(false);
    }
  }

  async function submitAnswer(answer: "yes" | "no") {
    if (!sessionId) return;
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
      if (isWhoAmITurnState(payload.state)) setTurnState(payload.state);
    } catch (err) {
      setAnswerError(err instanceof Error ? err.message : "Failed to submit answer.");
    } finally {
      setAnswering(false);
    }
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
      if (isWhoAmITurnState(payload.state)) setTurnState(payload.state);
    } catch (err) {
      setDoneError(err instanceof Error ? err.message : "Failed to end turn.");
    } finally {
      setEndingTurn(false);
    }
  }

  // ---- turn loop derived view state --------------------------------------
  const askerId = turnState ? currentAskerId(turnState) : null;
  const responderId = turnState ? currentResponderId(turnState) : null;
  const isMyTurnToAsk = turnState?.phase === "asking" && askerId === currentPlayer.id;
  const isMyTurnToAnswer = turnState?.phase === "answering" && responderId === currentPlayer.id;
  const isReviewingMyTurn = turnState?.phase === "reviewing" && askerId === currentPlayer.id;
  const activeQuestion =
    turnState?.activeQuestionId != null
      ? (questions.find((q) => q.id === turnState.activeQuestionId) ?? null)
      : null;

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
    <>
      <section aria-labelledby="who-am-i-turn-heading" className="who-am-i-turn">
        <h2 id="who-am-i-turn-heading">Turn</h2>

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
                  ? "Your turn — ask a yes/no question."
                  : `Waiting for ${nicknameFor(askerId ?? "")} to ask a question.`)}
              {turnState.phase === "answering" &&
                (isMyTurnToAnswer
                  ? "Your turn to answer."
                  : `Waiting for ${nicknameFor(responderId ?? "")} to answer.`)}
              {turnState.phase === "reviewing" &&
                (isReviewingMyTurn
                  ? "All answers are in — review them, update your board, then end your turn."
                  : `Waiting for ${nicknameFor(askerId ?? "")} to finish their turn.`)}
            </p>

            {isMyTurnToAsk && (
              <form className="who-am-i-ask-form" onSubmit={submitQuestion}>
                <label className="field">
                  <span>Ask a yes/no question</span>
                  <input
                    value={questionDraft}
                    onChange={(e) => setQuestionDraft(e.target.value)}
                    maxLength={MAX_QUESTION_LENGTH}
                    required
                    placeholder="e.g. Am I a real person?"
                    autoComplete="off"
                  />
                </label>
                {askError && (
                  <p className="field-error" role="alert">
                    {askError}
                  </p>
                )}
                <button type="submit" disabled={asking || questionDraft.trim().length === 0}>
                  {asking ? "Asking…" : "Ask"}
                </button>
              </form>
            )}

            {turnState.phase === "answering" && activeQuestion && (
              <div className="who-am-i-active-question">
                <p>
                  <strong>{nicknameFor(activeQuestion.asking_player_id)} asks:</strong>{" "}
                  {activeQuestion.question_text}
                </p>
                {isMyTurnToAnswer ? (
                  <div className="who-am-i-answer-buttons">
                    <button
                      type="button"
                      onClick={() => submitAnswer("yes")}
                      disabled={answering}
                      aria-label="Answer yes"
                    >
                      Yes
                    </button>
                    <button
                      type="button"
                      onClick={() => submitAnswer("no")}
                      disabled={answering}
                      aria-label="Answer no"
                    >
                      No
                    </button>
                  </div>
                ) : (
                  <p className="muted">
                    {nicknameFor(responderId ?? "")} is answering next.
                  </p>
                )}
                {answerError && (
                  <p className="field-error" role="alert">
                    {answerError}
                  </p>
                )}
              </div>
            )}

            {turnState.phase === "reviewing" && activeQuestion && (
              <div className="who-am-i-active-question">
                <p>
                  <strong>{nicknameFor(activeQuestion.asking_player_id)} asked:</strong>{" "}
                  {activeQuestion.question_text}
                </p>
                <ul className="who-am-i-answer-summary">
                  {Object.entries(activeQuestion.answers).map(([playerId, answer]) => (
                    <li key={playerId}>
                      {nicknameFor(playerId)}: <strong>{answer === "yes" ? "Yes" : "No"}</strong>
                    </li>
                  ))}
                </ul>
                {isReviewingMyTurn && (
                  <>
                    {doneError && (
                      <p className="field-error" role="alert">
                        {doneError}
                      </p>
                    )}
                    <button type="button" onClick={submitDone} disabled={endingTurn}>
                      {endingTurn ? "Ending turn…" : "I'm Done"}
                    </button>
                  </>
                )}
              </div>
            )}
          </>
        )}

        {questions.length > 0 && (
          <div className="who-am-i-log">
            <h3>Question log</h3>
            <ul className="who-am-i-log-list">
              {questions.map((q) => (
                <li key={q.id} className="who-am-i-log-entry">
                  <p className="who-am-i-log-question">
                    <strong>{nicknameFor(q.asking_player_id)}:</strong> {q.question_text}
                  </p>
                  {Object.keys(q.answers).length > 0 && (
                    <ul className="who-am-i-log-answers">
                      {Object.entries(q.answers).map(([playerId, answer]) => (
                        <li key={playerId}>
                          {nicknameFor(playerId)}: {answer === "yes" ? "Yes" : "No"}
                        </li>
                      ))}
                    </ul>
                  )}
                  {!q.resolved && <span className="muted">Still being answered…</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

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
    </>
  );
}
