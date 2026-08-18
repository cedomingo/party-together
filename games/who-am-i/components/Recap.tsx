"use client";

// Results/recap screen for "Who Am I?" (SPEC.md §8 point 7: "Show a
// results/recap screen (who guessed what, in what order, full question
// log)."). Rendered by ../components/RoomView.tsx once
// `game_sessions.ended_at` is set - see that file's header comment for
// which two paths can set it (a correct guess that solves the last
// remaining player, or a host manually ending the game).
//
// This component is intentionally "dumb": it takes fully-computed data as
// props (RoomView is the one that knows about turn state, the roster, and
// the unmasked `who_am_i_board` rows) and just renders it. That keeps the
// "never leak character_id" rule in one place (RoomView's data-loading
// effects, gated on `endedAt`) rather than duplicated into this file.

import Image from "next/image";
import { cardSoundHandlers } from "@/lib/animalSounds";
import type { WhoAmIGameMode } from "@/games/who-am-i/logic/turnState";

export interface WhoAmIRecapEntry {
  playerId: string;
  nickname: string;
  isYou: boolean;
  /** 1-based order this player correctly guessed in, or null if they never did. */
  rank: number | null;
  characterName: string | null;
  characterImageUrl: string | null;
  /** The character this player's final guess landed on, if any. */
  guessedCharacterName: string | null;
  correct: boolean;
}

export interface WhoAmIRecapQuestion {
  id: string;
  asking_player_id: string;
  /** Who this question was 1:1 directed at. Undefined/null for guess rows. */
  target_player_id?: string | null;
  question_text: string;
  answers: Record<string, string>;
  /** True when this entry records a guess rather than an asked question
   * (SPEC.md §8 point 6) - mirrors RoomView's questions_log shape. */
  is_guess?: boolean;
  guessedCharacterName?: string | null;
}

interface WhoAmIRecapProps {
  entries: WhoAmIRecapEntry[];
  questions: WhoAmIRecapQuestion[];
  nicknameFor: (playerId: string) => string;
  loading: boolean;
  error: string | null;
  /**
   * Win-condition variant for this session, and the outcome it produced
   * (turnState.ts `getGameOutcome`) - null/empty when the session hasn't
   * actually reached a mode-defined game-over state (e.g. the host ended
   * the round manually while multiple players were still unsolved), in
   * which case this just falls back to the plain "who solved it" list
   * below with no winner/loser banner.
   */
  gameMode?: WhoAmIGameMode | null;
  winnerPlayerIds?: string[];
  loserPlayerIds?: string[];
  /** Whether the CALLER (not necessarily anyone in `entries`) is this
   * room's host - only the host can send everyone back to the lobby, same
   * restriction as starting/ending the game itself. */
  isHost: boolean;
  /** Host-only: sends the room back to `lobby` so it can be re-invited to
   * (app/api/games/who-am-i/play-again/route.ts). Non-hosts never see the
   * control that would call this. */
  onPlayAgain: () => void;
  playAgainSubmitting: boolean;
  playAgainError: string | null;
  /** Host-only: sends the host to /games?room=CODE to swap the room to a
   * different game without anyone leaving it (see
   * app/api/rooms/switch-game/route.ts). Non-hosts never see the control
   * that would call this. */
  onPlayMoreGames: () => void;
}

export function WhoAmIRecap({
  entries,
  questions,
  nicknameFor,
  loading,
  error,
  gameMode = null,
  winnerPlayerIds = [],
  loserPlayerIds = [],
  isHost,
  onPlayAgain,
  playAgainSubmitting,
  playAgainError,
  onPlayMoreGames,
}: WhoAmIRecapProps) {
  const solved = entries.filter((entry) => entry.rank !== null);
  const unsolved = entries.filter((entry) => entry.rank === null);
  const winnerSet = new Set(winnerPlayerIds);
  const loserSet = new Set(loserPlayerIds);
  const hasOutcome = winnerPlayerIds.length > 0 || loserPlayerIds.length > 0;

  return (
    <section aria-labelledby="who-am-i-recap-heading" className="who-am-i-recap">
      <h2 id="who-am-i-recap-heading">Recap</h2>
      <p className="muted">
        The game has ended. Here&rsquo;s who figured out who they were, and in what order.
      </p>

      {hasOutcome && gameMode === "first-out-wins" && (
        <p className="who-am-i-recap-outcome">
          <strong>{nicknameFor(winnerPlayerIds[0]!)}</strong> was first to guess correctly and wins!
        </p>
      )}
      {hasOutcome && gameMode === "last-standing-loses" && loserPlayerIds.length > 0 && (
        <p className="who-am-i-recap-outcome">
          <strong>{loserPlayerIds.map((id) => nicknameFor(id)).join(", ")}</strong>{" "}
          {loserPlayerIds.length === 1 ? "was" : "were"} the last one standing and{" "}
          {loserPlayerIds.length === 1 ? "loses" : "lose"}.
        </p>
      )}

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      {loading && !error && <p className="muted">Loading recap…</p>}

      {!loading && !error && (
        <>
          {solved.length > 0 ? (
            <ol className="who-am-i-recap-ranking">
              {solved.map((entry) => (
                <li key={entry.playerId} className="who-am-i-recap-entry">
                  <span className="who-am-i-recap-rank" aria-hidden="true">
                    #{entry.rank}
                  </span>
                  <span className="who-am-i-recap-image" {...cardSoundHandlers(entry.characterName)}>
                    {entry.characterImageUrl && (
                      <Image src={entry.characterImageUrl} alt="" fill sizes="56px" draggable={false} />
                    )}
                  </span>
                  <span className="who-am-i-recap-info">
                    <strong>
                      {entry.nickname}
                      {entry.isYou && " (you)"}
                    </strong>
                    <span className="muted">was {entry.characterName ?? "Unknown"}</span>
                  </span>
                  {winnerSet.has(entry.playerId) && (
                    <span className="badge who-am-i-recap-winner-badge">Winner</span>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">Nobody guessed their identity this round.</p>
          )}

          {unsolved.length > 0 && (
            <div className="who-am-i-recap-unsolved">
              <h3>Didn&rsquo;t guess it</h3>
              <ul className="who-am-i-recap-unsolved-list">
                {unsolved.map((entry) => (
                  <li key={entry.playerId} className="who-am-i-recap-entry">
                    <span className="who-am-i-recap-image" {...cardSoundHandlers(entry.characterName)}>
                      {entry.characterImageUrl && (
                        <Image src={entry.characterImageUrl} alt="" fill sizes="56px" draggable={false} />
                      )}
                    </span>
                    <span className="who-am-i-recap-info">
                      <strong>
                        {entry.nickname}
                        {entry.isYou && " (you)"}
                      </strong>
                      <span className="muted">
                        was {entry.characterName ?? "Unknown"}
                        {entry.guessedCharacterName &&
                          ` - last guessed ${entry.guessedCharacterName}`}
                      </span>
                    </span>
                    {loserSet.has(entry.playerId) && (
                      <span className="badge who-am-i-recap-loser-badge">Loser</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {questions.length > 0 && (
        <div className="who-am-i-log who-am-i-recap-log">
          <h3>Full question log</h3>
          <ul className="who-am-i-log-list">
            {questions.map((q) => {
              if (q.is_guess) {
                const wasCorrect = q.answers[q.asking_player_id] === "correct";
                return (
                  <li key={q.id} className="who-am-i-log-entry who-am-i-log-entry-guess">
                    <p className="who-am-i-log-question">
                      <strong>{nicknameFor(q.asking_player_id)}</strong> guessed{" "}
                      <strong>{q.guessedCharacterName ?? "a character"}</strong> -{" "}
                      <span
                        className={
                          wasCorrect ? "who-am-i-guess-result-correct" : "who-am-i-guess-result-incorrect"
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
                      {q.target_player_id ? ` asked ${nicknameFor(q.target_player_id)}` : ""}:
                    </strong>{" "}
                    {q.question_text}
                  </p>
                  {Object.keys(q.answers).length > 0 && (
                    <ul className="who-am-i-log-answers">
                      {Object.entries(q.answers).map(([playerId, answer]) => (
                        <li key={playerId}>
                          {nicknameFor(playerId)}: {answer === "yes" ? "Yes" : answer === "no" ? "No" : `"${answer}"`}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Host-only actions, mirroring the End Game vs Leave Game split
          elsewhere in this game: "Play Again" sends the room back to the
          lobby (onPlayAgain - app/api/games/who-am-i/play-again/route.ts)
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
