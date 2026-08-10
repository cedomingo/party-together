# Build Prompt: "Who Are You?" — New Game Module for Party Together

## 0. Context

This is a new game module for the existing **Party Together** platform (`cedomingo/party-together`), added the same way `SPEC.md` §3(B)/§12.8 requires: a new folder under `/games/`, a new registry entry in `lib/games-registry.ts`, and (if any) new tables/RLS — **no changes to platform core** (room/lobby/chat/presence code).

It reuses the visual language, character roster, and most of the turn-loop plumbing of the existing **"Who Am I?"** game (`games/who-am-i/`), but flips the core secrecy rule: in Who Am I you don't know your own character; in **Who Are You?** you *pick* your own character and everyone else has to guess it — classic "Guess Who?" mechanics (working title only, same IP-safety naming rule as Who Am I).

---

## 1. One-line pitch

Everyone secretly picks a character. On your turn, you ask a yes/no question to each other player, one at a time, to narrow down what *they* picked — and each opponent gets their own separate board, because they may not have picked the same character as each other.

---

## 2. Shared assets (reused, not duplicated)

- **Character roster:** the same 25-character set as Who Am I — `public.characters` table, same `public/characters/who-am-i/images/*` art and `manifest.json`. No new art asset work needed.
- **Duplicate picks allowed:** unlike Who Am I's assignment step, two+ players **can** pick the same character. Nobody is told when this happens — from any other player's perspective, that character is simply still a valid, uneliminated guess on the relevant board(s).
- **Question/answer format:** identical to Who Am I — free-form question text, answered **Yes / No / Other** (Other = short free text), same 1:1 targeting model already shipped in `games/who-am-i/logic/turnState.ts` + the `questions_log.target_player_id` column added in `20260810000000_who_am_i_targeted_questions.sql`. This game reuses that turn-loop shape almost as-is (see §6).
- **Player count:** same range as Who Am I, **3–12 players.**

---

## 3. Setup phase (pre-game, in the room)

1. After the host clicks "Start Game," every player independently lands on a **character picker**, shown as the same tappable grid/thumbnail UI as Who Am I's board (not a dropdown/text field).
2. Each player taps a character to select it (highlighted/selected state), or taps **"Pick for me"** to get a random pick — random pick draws only from the full 25-character pool (does *not* need to avoid characters other players already chose, since duplicates are allowed — see §2).
3. Player confirms with **"Done."** Selection is now locked for that player for the rest of the game (no changing your mind after Done — mirrors Who Am I's identity being fixed at assignment).
4. A waiting screen shows who's picked / still picking (reuse the presence-aware waiting-room pattern already used elsewhere in the room lobby, if one exists — otherwise a simple "3 of 5 players ready" state is enough).
5. Once every player has picked, the game transitions to the main turn loop (§6).

**Secrecy direction (important — this is the opposite of Who Am I):**
- Your own pick is never secret **from you** — you always see what you picked.
- Your pick **is** secret from every other player, until/unless they correctly guess it.
- This means the DB masking rule flips relative to `who_am_i_assignments`: a player must be able to read their **own** selection row in full, but must **never** be able to read another player's `character_id` directly — only via the guess-comparison mechanic (§7), same trusted-server pattern Who Am I already uses for guesses.

---

## 4. Boards — one per opponent, not one shared board

This is the single biggest structural difference from Who Am I.

- Every player maintains **N−1 independent boards**, one per opponent (for a 5-player game, that's 4 boards).
- Each board is a full 25-character grid, cross-off-able independently of the others — crossing off "Gork" on your board-for-Player-2 does **not** cross out "Gork" on your board-for-Player-3.
- **UI:** reuse Who Am I's messaging-app layout (`RoomView.tsx`'s "one conversation per other player" sidebar) — each opponent is a "conversation." Opening a conversation with Player 2 shows *your board for Player 2* alongside the Q&A history with them. Switching to the Player 3 conversation swaps in *your board for Player 3*. This matches your description: "Boards can be accessed on whatever chat's opened."
- Cross-offs are local elimination notes only (same as Who Am I) — never enforced/validated server-side, just persisted per (viewer, opponent) pair so they survive a refresh.

---

## 5. Guessing

- Guessing works per opponent, and mirrors Who Am I's "guess instead of ask" rule exactly, just re-targeted:
  - On your turn, when it's that opponent's slot, you may **guess their character instead of asking them a question** (tapping a still-live/uncrossed card while in "guess mode" for that board, same tap-to-guess UX Who Am I already has).
  - **Correct guess:** that opponent's pairing is now *solved* — you stop asking/guessing **that specific opponent** going forward (their conversation shows as solved, similar to a "resolved" chat thread), but you keep asking/guessing everyone else you haven't solved yet.
  - **Wrong guess:** same as Who Am I — it wastes your slot with that opponent for this turn (you don't get to ask them a question too), but doesn't lock you out of guessing them again on a future turn.
- A wrong guess against Player 2 has **no effect** on your boards for Player 3, Player 4, etc. — each opponent relationship is fully independent.
- Once you've solved every opponent required by the active game mode (§8), you're done asking on future turns (you still answer other players' questions about your own pick, same as a "solved" player in Who Am I still answers others).

---

## 6. Turn loop (per active player's turn)

Directly reuses Who Am I's existing state machine shape (`games/who-am-i/logic/turnState.ts`) — same `asking → answering → reviewing` cycle, just applied per-opponent-board instead of per-shared-board:

1. It's Player 1's turn. `answeringOrder` = every other player in the room, in rotation order (unsolved-only, per whichever game mode is active — see §8).
2. Player 1 opens the conversation with the first player in that order (say Player 2) and either:
   - asks a yes/no question → Player 2 answers Yes/No/Other → the answer is visible in that conversation, and Player 1 manually crosses off characters on *their P2 board* based on the answer, or
   - guesses P2's character outright (§5).
3. Once resolved with P2, Player 1 moves to the next player in the order (P3), and repeats — one question (or one guess) per opponent, per turn, same "exactly one interaction per responder before moving on" rule Who Am I already enforces.
4. After Player 1 has gone through every opponent in `answeringOrder`, the turn moves to **"reviewing"** (Player 1 can look back over everything just asked/answered this turn across all boards), then Player 1 presses **"I'm Done."**
5. Turn passes to the next player in `turnOrder` (skipping anyone who's fully out per the active game mode), and that player repeats steps 1–4 against *their own* per-opponent boards.

---

## 7. Data model changes (proposed — flag for review before building)

New tables, additive only, no changes to `rooms`/`players`/`game_sessions` shape:

```sql
-- Each player's own locked-in pick. Selection is visible to the owner,
-- masked from everyone else (opposite direction from who_am_i_assignments).
create table public.who_are_you_selections (
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  character_id uuid not null references public.characters(id),
  primary key (session_id, player_id)
);
-- RLS: a player can SELECT only their own row in full. No SELECT grant on
-- character_id for other players' rows at all (same "no query could ever
-- leak it" pattern as who_am_i_assignments, just inverted).

-- One row per DIRECTED pair (viewer, target) — viewer's private board and
-- guess progress *about* target. Not shared/visible to target or anyone else.
create table public.who_are_you_boards (
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  viewer_player_id uuid not null references public.players(id) on delete cascade,
  target_player_id uuid not null references public.players(id) on delete cascade,
  crossed_off_character_ids uuid[] not null default '{}',
  guessed_character_id uuid references public.characters(id),
  is_guessed boolean generated always as (
    guessed_character_id is not null
    -- compared server-side against who_are_you_selections.character_id for
    -- (session_id, target_player_id) via the same trusted-write pattern
    -- who-am-i/guess/route.ts already uses; not a naive stored-generated
    -- expression since it needs a cross-table lookup.
  ) stored,
  primary key (session_id, viewer_player_id, target_player_id),
  check (viewer_player_id <> target_player_id)
);
```

- `questions_log` is reused **as-is**, no schema change — it already has `target_player_id` from the Who Am I targeting migration, which is exactly what per-opponent questions need here too.
- Guess *attempts* can either extend `questions_log` (`is_guess = true`, `target_player_id` = who's being guessed) or write straight to `who_are_you_boards.guessed_character_id` via a trusted route — recommend mirroring Who Am I's existing `guess/route.ts` pattern as closely as possible so the two games' guess-handling code stays symmetric.

*(This section is a proposed starting point, not locked — happy to adjust before implementation starts.)*

---

## 8. Game modes (host-configurable in the lobby, like Who Am I's "First One Out Wins?" checkbox)

The lobby offers a **base win-condition radio** (Mode 1 or Mode 2) plus an **independent "First Win Ends Game" checkbox** that layers on top of whichever base mode is selected — this is the more flexible generalization of Who Am I's single checkbox, and lets the lobby UI grow the same way if a third base mode is ever added later.

### Mode 1 — "Guess Everyone" (default, base mode)
- Win condition per player: correctly guess **every other player's** character.
- Game continues, round-robin, until only **one player** still has an unsolved opponent remaining — that player loses; everyone else wins.
- Direct generalization of Who Am I's default "last-standing-loses" mode, just per-board instead of per-identity.

### Mode 2 — "Rival Match" (base mode)
- At game start, each player is assigned exactly **one fixed rival** to win against. **Confirmed pairing rule:** a simple rotation — Player *i*'s rival is Player *i+1* in `turnOrder*, wrapping around (last player's rival is the first player). Works cleanly for any player count, including odd numbers, with no special-casing.
- You can still ask questions of / build boards against non-rival opponents (keeps the social/deduction gameplay going), but only correctly guessing your **assigned rival's** character counts toward your win.
- Game ends once every player has resolved their rival matchup (correct or not).

### "First Win Ends Game" (checkbox, layers on either base mode)
- The instant **any single player** satisfies the active base mode's win condition (fully solves everyone in Mode 1, or solves their rival in Mode 2), the game ends immediately for the whole room and the recap shows that player as the winner — direct equivalent of Who Am I's "first-out-wins" toggle, just generalized to sit on top of either base mode instead of being its own separate mode.
- Off (default): play continues per the base mode's own natural end condition (Mode 1: last-standing-loses; Mode 2: every rival matchup resolved).

---

## 9. Recap screen

Reuse Who Am I's `Recap.tsx` pattern for reveal (every player's actual pick, the full per-pairing Q&A/guess log) but restructure the layout for the all-pairs shape this game needs:

- **Confirmed layout: one tab per player.** Each player gets a tab; opening a player's tab shows that player's outcome against every opponent (solved/unsolved, and — if solved — on which turn), plus their Q&A history per opponent, nested the same "one conversation per other player" way the live board UI already works. This keeps the recap consistent with the rest of the game's mental model (tabs = players, same as the in-game sidebar) and avoids dumping every pairing into one dense grid at once.
- Mirrors Who Am I's ranked win/loss ordering where it still applies (e.g., in Mode 1, order tabs by solve-order/who's still unsolved; in Mode 2, flag each player's win/loss against their specific rival up front in their tab).

---

## 10. Naming

**Confirmed:** the game keeps **"Who Are You?"** as both the internal id (`who-are-you`) and the player-facing display name — same working-title/IP-safety framing as "Who Am I?" (SPEC.md §1: not a reference to "Guess Who" for IP reasons).

---

All open questions from the previous draft are now resolved. This doc is ready to hand off as a build prompt (e.g., to Claude Code) the same way `SPEC.md` was for the original Who Am I build — see `WHO-ARE-YOU-PHASES.md` for the two-step breakdown.