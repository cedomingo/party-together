"use client";

// Results/recap screen for "Who Are You?" (WHO-ARE-YOU-SPEC.md §9).
// One tab per player; each tab shows that player's outcome against every
// opponent (solved/unsolved + turn number) and their per-opponent Q&A
// history — restructured from Who Am I's single ranked list for the
// all-pairs shape.

import { useMemo, useState } from "react";
import Image from "next/image";
import { cardSoundHandlers } from "@/lib/animalSounds";
import type { WhoAreYouBaseMode } from "@/games/who-are-you/logic/sessionState";
import type { WhoAreYouSolvedPairing } from "@/games/who-are-you/logic/turnState";
import { rivalOf } from "@/games/who-are-you/logic/turnState";

export interface WhoAreYouRecapPlayer {
  playerId: string;
  nickname: string;
  isYou: boolean;
  characterName: string | null;
  characterImageUrl: string | null;
}

export interface WhoAreYouRecapQuestion {
  id: string;
  asking_player_id: string;
  target_player_id: string | null;
  question_text: string;
  answers: Record<string, string>;
  is_guess: boolean;
  guessedCharacterName?: string | null;
}

interface WhoAreYouRecapProps {
  players: WhoAreYouRecapPlayer[];
  turnOrder: string[];
  solvedPairings: WhoAreYouSolvedPairing[];
  questions: WhoAreYouRecapQuestion[];
  nicknameFor: (playerId: string) => string;
  baseMode: WhoAreYouBaseMode | null;
  firstWinEnds: boolean;
  winnerPlayerIds: string[];
  loserPlayerIds: string[];
  loading: boolean;
  error: string | null;
  isHost: boolean;
  onPlayAgain: () => void;
  playAgainSubmitting: boolean;
  playAgainError: string | null;
  /** Host-only: sends the host to /games?room=CODE to swap the room to a
   * different game without anyone leaving it (see
   * app/api/rooms/switch-game/route.ts). Non-hosts never see the control
   * that would call this. */
  onPlayMoreGames: () => void;
}

export function WhoAreYouRecap({
  players,
  turnOrder,
  solvedPairings,
  questions,
  nicknameFor,
  baseMode,
  firstWinEnds,
  winnerPlayerIds,
  loserPlayerIds,
  loading,
  error,
  isHost,
  onPlayAgain,
  playAgainSubmitting,
  playAgainError,
  onPlayMoreGames,
}: WhoAreYouRecapProps) {
  // Mode 1: order tabs by solve-completeness / who finished first.
  // Mode 2: keep turnOrder, flag rival outcome in each tab.
  const tabOrder = useMemo(() => {
    if (baseMode === "guess-everyone") {
      const finishedAt = new Map<string, number>();
      for (const p of players) {
        const theirs = solvedPairings.filter((s) => s.viewerId === p.playerId);
        if (theirs.length === 0) continue;
        finishedAt.set(p.playerId, Math.max(...theirs.map((s) => s.turnNumber)));
      }
      return [...players].sort((a, b) => {
        const aFin = finishedAt.has(a.playerId);
        const bFin = finishedAt.has(b.playerId);
        if (aFin !== bFin) return aFin ? -1 : 1;
        const aTurn = finishedAt.get(a.playerId) ?? Number.MAX_SAFE_INTEGER;
        const bTurn = finishedAt.get(b.playerId) ?? Number.MAX_SAFE_INTEGER;
        return aTurn - bTurn;
      });
    }
    return players;
  }, [players, solvedPairings, baseMode]);

  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const selectedId = activeTabId ?? tabOrder[0]?.playerId ?? null;
  const selected = players.find((p) => p.playerId === selectedId) ?? null;

  const winnerSet = new Set(winnerPlayerIds);
  const loserSet = new Set(loserPlayerIds);
  const hasOutcome = winnerPlayerIds.length > 0 || loserPlayerIds.length > 0;

  const opponentsForSelected = useMemo(() => {
    if (!selected) return [];
    return turnOrder.filter((id) => id !== selected.playerId);
  }, [selected, turnOrder]);

  function pairingFor(viewerId: string, targetId: string): WhoAreYouSolvedPairing | undefined {
    return solvedPairings.find((p) => p.viewerId === viewerId && p.targetId === targetId);
  }

  function conversationFor(viewerId: string, targetId: string): WhoAreYouRecapQuestion[] {
    return questions.filter(
      (q) =>
        (q.asking_player_id === viewerId && q.target_player_id === targetId) ||
        (q.asking_player_id === targetId && q.target_player_id === viewerId)
    );
  }

  return (
    <section aria-labelledby="who-are-you-recap-heading" className="who-are-you-recap">
      <h2 id="who-are-you-recap-heading">Recap</h2>
      <p className="muted">The game has ended. Here&rsquo;s how everyone did against each opponent.</p>

      {hasOutcome && firstWinEnds && winnerPlayerIds[0] && (
        <p className="who-am-i-recap-outcome">
          <strong>{nicknameFor(winnerPlayerIds[0])}</strong> finished first and wins!
        </p>
      )}
      {hasOutcome && !firstWinEnds && baseMode === "guess-everyone" && loserPlayerIds.length > 0 && (
        <p className="who-am-i-recap-outcome">
          <strong>{loserPlayerIds.map((id) => nicknameFor(id)).join(", ")}</strong>{" "}
          {loserPlayerIds.length === 1 ? "was" : "were"} last standing and{" "}
          {loserPlayerIds.length === 1 ? "loses" : "lose"}.
        </p>
      )}
      {hasOutcome && !firstWinEnds && baseMode === "rival-match" && (
        <p className="who-am-i-recap-outcome">Every rival matchup is resolved.</p>
      )}

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {loading && !error && <p className="muted">Loading recap…</p>}

      {!loading && !error && tabOrder.length > 0 && (
        <>
          <div className="who-are-you-recap-tabs" role="tablist" aria-label="Players">
            {tabOrder.map((p) => {
              const selectedTab = p.playerId === selectedId;
              return (
                <button
                  key={p.playerId}
                  type="button"
                  role="tab"
                  aria-selected={selectedTab}
                  className={`who-are-you-recap-tab${selectedTab ? " selected" : ""}`}
                  onClick={() => setActiveTabId(p.playerId)}
                >
                  {p.nickname}
                  {p.isYou ? " (you)" : ""}
                  {winnerSet.has(p.playerId) && (
                    <span className="badge who-am-i-recap-winner-badge">Winner</span>
                  )}
                  {loserSet.has(p.playerId) && (
                    <span className="badge who-am-i-recap-loser-badge">Loser</span>
                  )}
                </button>
              );
            })}
          </div>

          {selected && (
            <div className="who-are-you-recap-panel" role="tabpanel">
              <div className="who-are-you-recap-player-summary">
                {selected.characterImageUrl && (
                  <span className="who-am-i-recap-image" {...cardSoundHandlers(selected.characterName)}>
                    <Image src={selected.characterImageUrl} alt="" fill sizes="56px" draggable={false} />
                  </span>
                )}
                <div>
                  <strong>
                    {selected.nickname}
                    {selected.isYou && " (you)"}
                  </strong>
                  <p className="muted">picked {selected.characterName ?? "Unknown"}</p>
                  {baseMode === "rival-match" && (
                    <p className="muted">
                      Rival: {nicknameFor(rivalOf(turnOrder, selected.playerId) ?? "")}
                      {(() => {
                        const rival = rivalOf(turnOrder, selected.playerId);
                        if (!rival) return null;
                        const solved = pairingFor(selected.playerId, rival);
                        return solved
                          ? ` — solved on turn ${solved.turnNumber}`
                          : " — unsolved";
                      })()}
                    </p>
                  )}
                </div>
              </div>

              <h3>Outcomes</h3>
              <ul className="who-are-you-recap-outcomes">
                {opponentsForSelected.map((targetId) => {
                  const solved = pairingFor(selected.playerId, targetId);
                  const isRival =
                    baseMode === "rival-match" &&
                    rivalOf(turnOrder, selected.playerId) === targetId;
                  return (
                    <li key={targetId}>
                      <strong>{nicknameFor(targetId)}</strong>
                      {isRival && <span className="muted"> (rival)</span>}
                      {": "}
                      {solved ? (
                        <span className="who-am-i-guess-result-correct">
                          solved on turn {solved.turnNumber}
                        </span>
                      ) : (
                        <span className="who-am-i-guess-result-incorrect">unsolved</span>
                      )}
                    </li>
                  );
                })}
              </ul>

              <h3>Conversations</h3>
              {opponentsForSelected.map((targetId) => {
                const thread = conversationFor(selected.playerId, targetId);
                return (
                  <div key={targetId} className="who-are-you-recap-thread">
                    <h4>vs {nicknameFor(targetId)}</h4>
                    {thread.length === 0 ? (
                      <p className="muted">No questions or guesses.</p>
                    ) : (
                      <ul className="who-am-i-log-list">
                        {thread.map((q) => {
                          if (q.is_guess) {
                            const wasCorrect = q.answers[q.asking_player_id] === "correct";
                            return (
                              <li key={q.id} className="who-am-i-log-entry who-am-i-log-entry-guess">
                                <p className="who-am-i-log-question">
                                  <strong>{nicknameFor(q.asking_player_id)}</strong> guessed{" "}
                                  <strong>{q.guessedCharacterName ?? "a character"}</strong> —{" "}
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
                              </li>
                            );
                          }
                          return (
                            <li key={q.id} className="who-am-i-log-entry">
                              <p className="who-am-i-log-question">
                                <strong>
                                  {nicknameFor(q.asking_player_id)}
                                  {q.target_player_id
                                    ? ` asked ${nicknameFor(q.target_player_id)}`
                                    : ""}
                                  :
                                </strong>{" "}
                                {q.question_text}
                              </p>
                              {Object.keys(q.answers).length > 0 && (
                                <ul className="who-am-i-log-answers">
                                  {Object.entries(q.answers).map(([pid, answer]) => (
                                    <li key={pid}>
                                      {nicknameFor(pid)}:{" "}
                                      {answer === "yes"
                                        ? "Yes"
                                        : answer === "no"
                                          ? "No"
                                          : `"${answer}"`}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Host-only actions, mirroring the End Game vs Leave Game split
          elsewhere in this game: "Play Again" sends the room back to the
          lobby (onPlayAgain — app/api/games/who-are-you/play-again/route.ts)
          for a fresh round of the SAME game; "Play More Games" sends the
          host to /games?room=CODE to swap the room to a DIFFERENT game
          (app/api/rooms/switch-game/route.ts) without anyone leaving.
          Non-hosts get a single waiting note instead of dead buttons. */}
      <div className="who-am-i-recap-actions">
        {isHost ? (
          <>
            <button
              type="button"
              className="who-am-i-btn-outline"
              onClick={onPlayAgain}
              disabled={playAgainSubmitting}
            >
              {playAgainSubmitting ? "Starting…" : "Play Again"}
            </button>
            <button type="button" className="who-am-i-btn-outline" onClick={onPlayMoreGames}>
              Play More Games
            </button>
          </>
        ) : (
          <p className="muted who-am-i-recap-waiting">Waiting for the host to start the next game…</p>
        )}
      </div>
      {playAgainError && (
        <p className="field-error" role="alert">
          {playAgainError}
        </p>
      )}
    </section>
  );
}
