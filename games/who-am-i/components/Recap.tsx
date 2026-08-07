"use client";

// Results/recap screen for "Who Am I?" (SPEC.md §8 point 7: "Show a
// results/recap screen (who guessed what, in what order, full question
// log)."). Rendered by ../components/RoomView.tsx once
// `game_sessions.ended_at` is set — see that file's header comment for
// which two paths can set it (a correct guess that solves the last
// remaining player, or a host manually ending the game).
//
// This component is intentionally "dumb": it takes fully-computed data as
// props (RoomView is the one that knows about turn state, the roster, and
// the unmasked `who_am_i_board` rows) and just renders it. That keeps the
// "never leak character_id" rule in one place (RoomView's data-loading
// effects, gated on `endedAt`) rather than duplicated into this file.

import Image from "next/image";

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
  question_text: string;
  answers: Record<string, string>;
  /** True when this entry records a guess rather than an asked question
   * (SPEC.md §8 point 6) — mirrors RoomView's questions_log shape. */
  is_guess?: boolean;
  guessedCharacterName?: string | null;
}

interface WhoAmIRecapProps {
  entries: WhoAmIRecapEntry[];
  questions: WhoAmIRecapQuestion[];
  nicknameFor: (playerId: string) => string;
  loading: boolean;
  error: string | null;
}

export function WhoAmIRecap({ entries, questions, nicknameFor, loading, error }: WhoAmIRecapProps) {
  const solved = entries.filter((entry) => entry.rank !== null);
  const unsolved = entries.filter((entry) => entry.rank === null);

  return (
    <section aria-labelledby="who-am-i-recap-heading" className="who-am-i-recap">
      <h2 id="who-am-i-recap-heading">Recap</h2>
      <p className="muted">
        The game has ended. Here&rsquo;s who figured out who they were, and in what order.
      </p>

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
                  <span className="who-am-i-recap-image">
                    {entry.characterImageUrl && (
                      <Image src={entry.characterImageUrl} alt="" fill sizes="56px" />
                    )}
                  </span>
                  <span className="who-am-i-recap-info">
                    <strong>
                      {entry.nickname}
                      {entry.isYou && " (you)"}
                    </strong>
                    <span className="muted">was {entry.characterName ?? "Unknown"}</span>
                  </span>
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
                  <li key={entry.playerId}>
                    <strong>
                      {entry.nickname}
                      {entry.isYou && " (you)"}
                    </strong>{" "}
                    <span className="muted">
                      was {entry.characterName ?? "Unknown"}
                      {entry.guessedCharacterName &&
                        ` \u2014 last guessed ${entry.guessedCharacterName}`}
                    </span>
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
                      <strong>{q.guessedCharacterName ?? "a character"}</strong> —{" "}
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
                    <strong>{nicknameFor(q.asking_player_id)}:</strong> {q.question_text}
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
    </section>
  );
}
