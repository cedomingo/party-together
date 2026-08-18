Party Together - Phased Build Prompts
Feed these to Claude one phase at a time, in separate sessions (or a fresh /clear in Claude Code) once the previous phase is reviewed and committed. Each phase ends with a required stop-and-report step so you can course-correct before more tokens are spent.
Reference the full original spec as SPEC.md in the repo so each phase-prompt can point back to it for detail instead of restating everything.

Phase 0 - Repo & Environment Scaffolding
Goal: Empty, working skeleton. No game logic, no room logic.
Scaffold the Next.js (App Router) project for "Party Together" per §2 and §6
of SPEC.md. Set up:
- Next.js app deployed-ready for Vercel
- Supabase client/server helpers in /lib/supabase (no tables yet)
- Folder structure exactly as in §6, with empty placeholder files/comments
  marking where each future piece goes
- .env.example with required Supabase/Cloudflare vars documented

Do NOT implement rooms, games, or any business logic yet - this phase is
scaffolding only.

Stop when done. Summarize what was created, list any assumptions, and wait
for my confirmation before continuing.


Phase 1 - Data Model & RLS (no app code)
Goal: Database only.
Using SPEC.md §5 as reference, write the Supabase migration(s) for all tables
(rooms, players, game_sessions, who_am_i_assignments, characters,
questions_log) and their Row Level Security policies. Pay special attention
to the RLS rule that a player can never read their own character_id.

Do NOT write any frontend or API route code yet - this phase is schema + RLS
only. Include a short doc explaining how to verify the "can't see own
character" rule with a test query.

Stop when done. Summarize the schema, flag any open RLS edge cases, and wait
for my confirmation before continuing.


Phase 2 - Platform Core: Rooms & Lobby (game-agnostic)
Goal: Create/join/lobby flow works end-to-end with zero game logic.
Build the game-agnostic platform core per SPEC.md §3(A) and §7: room
creation with short codes, join-by-link/code, nickname-only identity,
lobby with connected players + host badge, host-only "Start Game" button
(can be a no-op stub for now), disconnect/reconnect handling, and room
expiry cleanup.

Do NOT implement any "Who Am I?" specific logic, board, or turn system -
core only. The "Start Game" button should just flip room status, nothing
game-specific.

Stop when done. Summarize what works, what's stubbed, and wait for my
confirmation before continuing.


Phase 3 - Games Registry Pattern (plugin skeleton)
Goal: Prove the plugin architecture with an empty/minimal game.
Implement games-registry.ts per SPEC.md §3(B). Create the /games/who-am-i
folder with only a GameConfig (id, name, min/max players, description,
thumbnail, route slug) and a placeholder component that just renders
"Game starting soon" - no real game logic yet.

Wire the registry into the room/game-selector flow from Phase 2 so a host
can select "Who Am I?" and the room routes to this placeholder.

Goal of this phase is proving a second game could be added later by adding
a folder + registry entry, without touching core code - don't build real
game mechanics yet.

Stop when done and wait for my confirmation before continuing.


Phase 4 - Character Roster
Goal: Content/asset step, isolated from game logic.
Generate the 25-character roster per SPEC.md §6: original, non-trademarked
fictional characters with placeholder avatars, manifest.json, and a seed
script to load them into the `characters` table.

This is a content-only phase - don't touch game logic.

Stop when done and wait for my confirmation before continuing.


Phase 5 - "Who Am I?" Game Module: Setup & Board
Goal: Assignment + board UI, no turn loop yet.
Implement the game start / character assignment logic and the per-player
25-character board UI from SPEC.md §8 ("Setup" section only). On game start,
randomly assign characters (no repeats), enforce via RLS/query that a player
can never fetch their own character_id, and render the tappable board with
local cross-off state.

Do NOT build the question/answer turn loop yet - that's the next phase.

Stop when done and wait for my confirmation before continuing.


Phase 6a - Turn Loop & Question Log (core).
Implement from SPEC.md §8 ("Turn Loop") and §5 (questions_log persistence):
turn order, public yes/no/type (other) question submission, sequential
answer collection from other players, and "I'm Done" to end turn.

Don't implement the guess/solved flow, game end condition, or recap
screen yet - that's a separate follow-up. Stop when done and wait for
my confirmation before continuing.

Phase 6b 1
Clone https://github.com/cedomingo/party-together and read SPEC.md and
PHASE.md. Phase 6a is already implemented for the who-am-i game: turn
order, question submission, sequential answer collection, and "I'm Done"
(app/api/games/who-am-i/{question,answer,done}/route.ts, plus
turnState.ts and turnSession.ts). Verify these exist - don't redo them.

Implement ONLY the backend/logic half of Phase 6b, per SPEC.md §8
points 6–7:

1. Extend turnState.ts / turnSession.ts as needed: guess attempt on a
   player's turn, correct → mark "solved" + remove from asking rotation
   (still answers others' questions), incorrect → turn passes as normal,
   no penalty.
2. Game end condition: all players solved, OR host manually ends the
   game.
3. New API route(s) for submitting a guess and for host-triggered
   manual end. Enforce the same RLS/query-scoping as the rest of the
   game - never leak character_id outside the correctness check.
4. Any migration needed to support recap data (e.g. revealing
   character_id once the game has ended).

Do NOT build the recap UI component, do NOT touch RoomView.tsx/
RoomClient.tsx rendering, and do NOT run build/lint/tests yet. Stop
once the backend logic and routes are written and wait for my
confirmation before continuing.

Phase 6b 2
Continuing Phase 6b on the who-am-i game. The guess/end-game backend
logic and routes from the previous step are done. Now implement the
frontend half, per SPEC.md §8 point 7:

1. A Recap component: ranked list of who guessed correctly in what
   order, plus the full public Q&A log.
2. Wire RoomView.tsx to show a guess UI during play and render the
   Recap once the game has ended.
3. Update RoomClient.tsx if needed so the "finished" room status
   delegates to the game module's recap view instead of a generic
   message.
4. Add any CSS classes this UI needs to globals.css.

Do NOT run build/lint/tests or smoke-test yet. Stop once written and
wait for my confirmation before continuing.







Phase 7 - Realtime Wiring
Goal: Make it feel live.
Wire up Supabase Realtime per SPEC.md §9: Postgres changes subscription for
lobby/room presence, a per-room Broadcast channel for turn indicator /
typing / sequential answer prompts / "I'm Done" events, and Presence for
online status. Confirm Postgres remains the source of truth and a refresh
mid-game fully rehydrates state.

Stop when done and wait for my confirmation before continuing.


Phase 8 - SEO & Routing
Goal: Indexing correctness.
Implement the routing/SEO structure from SPEC.md §4: server-rendered,
crawlable /games/[game] landing pages driven by GameConfig, noindex on
/room/[code] pages, sitemap.xml of static pages only, and per-game metadata
via the Next.js metadata API.

Stop when done and wait for my confirmation before continuing.


Phase 9 - Security Hardening
Goal: Lock it down last, once behavior is stable.
Apply SPEC.md §10: Cloudflare WAF/rate-limit/bot-fight config in front of
Vercel, server-side rate limiting on room creation, join, question, and
answer submission endpoints, and input sanitization/length limits on
nicknames and questions.

Stop when done and wait for my confirmation before continuing.


Phase 10 - Non-Functional Polish
Goal: Final pass.
Address SPEC.md §11: mobile-first responsiveness, reconnect-safety
verification, accessibility (focus states, aria labels on yes/no buttons
and turn indicators), and clean loading/empty/error states for
room-not-found, room-full, and room-already-started.

Stop when done and give a final summary of the whole build against
SPEC.md §12's checklist.


Tips for running this
Keep SPEC.md (your original doc) in the repo root so each phase-prompt can reference it instead of you re-pasting sections.
Commit after each phase before starting the next.
If a phase's diff is still large, split it further (e.g. Phase 6 could become 6a "question/answer submission" + 6b "turn state machine + guess").
Start each new phase in a fresh session/context - don't keep dragging the full prior conversation forward.

