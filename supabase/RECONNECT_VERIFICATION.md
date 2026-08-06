# Reconnect-safety verification (SPEC.md §11)

> "Reconnect-safe: refreshing the page mid-game should not lose a player's
> state."

This was already substantially true before Phase 10 — SPEC.md §9 designed
for it from the start ("Persist the authoritative state ... to Postgres so
a page refresh or reconnect can fully rehydrate the game — Realtime
broadcast is for UX responsiveness, not the source of truth"), and every
phase since has followed that rule. This doc verifies the claim end-to-end,
identifies the one gap that was left, and documents what Phase 10 added to
close it.

## Why this holds: what's persisted vs. what's ephemeral

| State | Where it lives | Rehydrates on refresh? |
|---|---|---|
| Room status, code, host, max_players | `rooms` table | ✅ `RoomClient`'s initial-load effect reads it fresh every mount |
| Player list, connected flags, host badge | `players` table | ✅ same effect |
| Turn order, phase, whose turn, solved players | `game_sessions.state` (jsonb) | ✅ `WhoAmIRoomView`'s initial-load effect |
| Full question/answer log | `questions_log` table | ✅ same effect, ordered by `created_at` |
| Your own character assignment (masked) + crossed-off progress | `who_am_i_assignments` via the `who_am_i_board` view | ✅ same effect |
| Recap (revealed characters, guess order) | Same table, unmasked once `ended_at` is set | ✅ recap-loading effect, keyed on `endedAt` |
| Who's online right now | Presence channel (in-memory, per SPEC.md §9 by design) | ❌ not persisted — re-tracked from scratch on (re)connect, which is correct: presence is *supposed* to reset to "figure out who's here right now" |
| "X is typing…" | Broadcast channel (in-memory, per SPEC.md §9 by design) | ❌ not persisted — correct, it's not meant to survive a refresh |
| Live activity feed (toasts for question-asked/answer-submitted/etc.) | Broadcast channel | ❌ not persisted — explicitly documented in `RoomView.tsx` as ephemeral; the permanent record is the question log above, which *does* rehydrate |

Nothing a player needs to keep playing correctly (whose turn it is, what's
been asked/answered, their own board progress, whether they've solved it)
lives only in memory. Everything ephemeral is explicitly UX sugar with a
persisted equivalent sitting next to it.

## The gap this phase closed: backgrounding without a reload

A full page refresh/reload was already covered — every load-bearing piece
above reads from Postgres on mount, unconditionally, whether that mount is
a first visit or the fifth reload of the session.

What wasn't explicitly covered: a phone gets locked, or a browser tab gets
backgrounded for a while, and **the page is never unmounted** — no refresh
happens, so the mount-time reads never re-run. Mobile OSes are known to
suspend or drop idle WebSocket connections in the background without a
clean close event the app can react to, and `supabase-js`'s own reconnect
logic, while real, isn't an instant or guaranteed-complete resync the
moment the tab wakes up.

Phase 10 adds a `visibilitychange` / `online` / `pageshow` listener in both
`RoomClient.tsx` and `WhoAmIRoomView` that re-reads the same Postgres
tables the initial-load effects already trust, whenever the tab becomes
visible/online again. It's deliberately minimal:

- Re-fetches `rooms` + `players` (`RoomClient`) and `game_sessions` +
  `questions_log` (`WhoAmIRoomView`) — the same read paths as the initial
  load, not a new code path to keep in sync with those.
- Re-marks the caller's own player row `connected = true` if it had fallen
  out of sync.
- Is best-effort: failures are swallowed rather than surfaced as a
  user-facing error, since the Realtime subscription is still the primary
  path and this is only a backstop for it.
- Deliberately does **not** touch local-only state that a naive re-fetch
  could clobber mid-interaction — `crossedOff` (a tap in flight) and the
  recap fetch (already keyed off `endedAt` and re-runs on its own).

## Manual verification steps

1. **Basic refresh mid-game.** Join a room as 3+ players, start the game,
   have one player ask a question and get partway through answers. Hard
   refresh (Cmd/Ctrl+Shift+R) the active asker's tab. Expect: same turn
   phase, same active question, full question log intact, board's
   crossed-off state intact. Confirm from the Network tab that no
   `/api/rooms/join` call fired (§9 rate-limit notes in `PHASE9_NOTES.md`
   already documents refresh ≠ join).
2. **Refresh as a responder mid-answer.** While a question is awaiting a
   specific player's yes/no, refresh that player's tab. Expect: they land
   back on "your turn to answer" for the same question, not skipped or
   stuck.
3. **Refresh after the game ends.** End a game (all-solved or host
   manually ends it), then refresh any player's tab. Expect: recap screen
   renders immediately from `ended_at`, not the turn loop.
4. **Backgrounding without a refresh (the Phase 10 addition).** On a real
   phone: start a game, background the app (press home, or lock the
   screen) for 30-60s while another player asks a question, then reopen
   the app. Expect: within a moment of the tab becoming visible, the turn
   indicator and question log catch up to the new question — verify this
   happens even if you watch the Network/WS tab and can see the Realtime
   socket had actually dropped while backgrounded.
5. **Airplane mode round-trip.** Toggle airplane mode on, wait a few
   seconds, toggle it back off. Expect the `online` listener to trigger a
   resync without needing to background/foreground the tab at all.
6. **Reconnect after being the only one who left.** Player A refreshes
   while players B/C are mid-turn. Expect A's player row to flip back to
   `connected = true` (visible to B/C as A's status dot going green) within
   a moment of A's page finishing its reload — this was already true
   pre-Phase-10 (the initial-load effect handles it) and is unaffected by
   the new listeners.

None of these require special test tooling — they're all reproducible by
hand with 3 browser tabs/devices against a real Supabase project.
