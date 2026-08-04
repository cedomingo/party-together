# Build Prompt: "Party Together" Multiplayer Game Platform

## 1. Project Overview

Build **Party Together**, a skribbl.io-style web platform where a host creates a room, shares a link, and friends join to play browser-based party games together. The platform must be architected so that **new games can be added later without refactoring the core** (room system, lobby, chat, presence, etc.).

The first game to ship is **"Who Am I?"** — a party game (working title only, not to be branded "Guess Who" for IP reasons) where each player is secretly assigned a character identity that only *other* players can see. On their turn, a player asks a yes/no question publicly to the room, and every other player answers Yes/No one at a time. Players use a visual board of 25 characters to cross off candidates as they narrow down who they are.

---

## 2. Tech Stack

- **Frontend/Framework:** Next.js (App Router), deployed on **Vercel**
- **Backend/DB/Realtime/Storage:** **Supabase** (Postgres + Row Level Security + Supabase Realtime + Supabase Storage for character images)
- **Edge/Security:** **Cloudflare** in front of Vercel (DNS, DDoS protection, bot/rate-limit rules, WAF)
- **Auth:** None required for players — anonymous nickname + generated player ID (stored in a signed cookie/localStorage) is sufficient for both host and guests. No login system needed for v1.

---

## 3. Core Architecture Principle: Games as Plugins

The platform has two layers that must stay strictly decoupled:

**A. Platform Core (shared, game-agnostic)**
- Room creation, room codes/links, lobby, player list, presence (who's online), host controls, game selector, chat infrastructure, reconnect handling, room expiry/cleanup.

**B. Game Modules (self-contained, swappable)**
- Each game lives in its own folder and exports:
  - A `GameConfig` (id, display name, min/max players, description, thumbnail, route slug)
  - Its own Postgres tables (or a shared `game_state jsonb` column keyed by game id — see §5)
  - Its own React components for the in-room game view
  - Its own Realtime event handlers/rules
- The room core never contains game-specific logic. Adding a new game later = adding a new folder + registering it in a `games registry` file. It must **not** require touching room/lobby code.

Build a `/games/` directory where `who-am-i` is the first and only entry, but structure it as if a second game will be added next month.

---

## 4. URL & Routing Structure (SEO-oriented)

Use **path-based routing** under a single domain (recommended over subdomains — consolidates SEO authority, avoids duplicate SSL/DNS setup, and Google indexes subdirectories fine):

```
partytogether.com/                          → landing page, lists all games
partytogether.com/games/who-am-i             → indexable marketing/landing page for the game (SEO target)
partytogether.com/games/who-am-i/room/ABCD   → actual live room (noindex, nofollow — dynamic, not for search)
```

- The `/games/who-am-i` landing page must be a real, crawlable, server-rendered page with proper `<title>`, meta description, OG tags, and on-page copy explaining the game — this is the page you want ranking in search.
- Room pages (`/room/ABCD`) must be marked `noindex` since they're ephemeral/dynamic.
- Add a `sitemap.xml` including static/landing pages only.
- Use Next.js metadata API for per-game SEO metadata, driven by each game's `GameConfig` so future games automatically get a landing page + sitemap entry.

---

## 5. Data Model (Supabase / Postgres)

Design tables so the schema supports multiple games without per-game migrations for basic room/lobby data:

- **rooms**: `id`, `code` (short shareable code), `host_player_id`, `game_id`, `status` (lobby / in_progress / finished), `max_players`, `created_at`, `expires_at`
- **players**: `id`, `room_id`, `nickname`, `is_host` (bool), `connected` (bool), `joined_at`
- **game_sessions**: `id`, `room_id`, `game_id`, `state` (jsonb — flexible per-game state), `started_at`, `ended_at`
- **who_am_i_assignments** (game-specific table, scoped to this game only): `session_id`, `player_id`, `character_id`, `crossed_off_character_ids` (array), `is_guessed` (bool)
- **characters**: `id`, `name`, `image_url`, `active` (bool) — the fixed global 25-character roster
- **questions_log**: `session_id`, `asking_player_id`, `question_text`, `created_at`, `answers` (jsonb: `{player_id: 'yes'|'no'}[]`), `resolved` (bool once all players have answered + asker hits "I'm done")

Apply **Row Level Security**: players can only read/write within their own room; a player can never read their *own* `character_id` in `who_am_i_assignments` (critical — this is the whole game), enforced at the RLS/query level, not just hidden in the UI.

---

## 6. Folder/Project Structure

```
/app
  /page.tsx                     → landing page (all games)
  /games/[game]/page.tsx        → SEO landing page per game (static-ish, from GameConfig)
  /games/[game]/room/[code]/    → live room UI
/games                          → game plugin modules
  /who-am-i
    config.ts                   → GameConfig for this game
    /components                 → board, question log, turn controls
    /logic                      → turn state machine, win condition checks
    /realtime                   → channel handlers specific to this game
/lib
  /supabase                     → client, server, RLS helpers
  /rooms                        → core room/lobby logic (game-agnostic)
  /games-registry.ts            → central list of registered games (import point for new games)
/public
  /characters
    /who-am-i
      manifest.json              → [{id, name, imageFile}], 25 entries
      /images/                   → 01.png ... 25.png (placeholder/generated set)
```

**Character folder requirement:** Generate a first-pass roster of 25 original, non-trademarked fictional characters (name + simple placeholder avatar image, generated or illustrated — not real people, not copyrighted characters) and place them exactly per the structure above with the `manifest.json` driving the app. This must be trivially swappable — replacing images/names in that folder (or updating `manifest.json` + re-running a seed script into the `characters` table) should be the *only* step needed to change the roster.

---

## 7. Room & Lobby Flow (Platform Core)

- Host lands on `/`, clicks "Create Room" → picks a game from the registry (only "Who Am I?" for now) → room is created with a short code and shareable link.
- Guests join via link or by entering the code, choose a nickname only (no account).
- No max player cap enforced by default, but host can optionally set one; host can lock the room once the game starts so no new joins mid-game.
- Lobby shows connected players, host badge, "Start Game" button (host-only).
- On disconnect, mark player `connected: false` but keep their slot/state for a grace period to allow reconnect (esp. important since each player's own identity depends on session state).
- Rooms auto-expire/cleanup after a period of inactivity (cron via Supabase scheduled function or Vercel cron hitting a cleanup endpoint).

---

## 8. Game Rules & UX Flow: "Who Am I?"

**Setup**
- When the host starts the game, randomly assign each connected player one character from the 25-character roster (no repeats within a room). A player must never be able to see their own assigned character anywhere in the client — enforce via RLS/query scoping, not just UI hiding.
- Each player sees a **visual grid board of all 25 characters**, tappable to cross off (this state is per-player, local to their own elimination progress, not shared).

**Turn Loop**
1. Turn order is established at game start (e.g., join order or randomized), rotating each round.
2. Active player types a **public** yes/no question, sent to the room (visible to everyone, logged permanently in the question log for the session).
3. Every *other* player answers Yes or No, **one at a time, sequentially** (not simultaneously) — the UI should show whose turn it is to answer next among the responders.
4. Once all other players have answered, the active player reviews the public answers, updates their own board (crossing off characters), and presses **"I'm Done"** to end their turn.
5. Turn passes to the next player in order.
6. A player may attempt to **guess** their identity at any point on their turn instead of/after asking a question. If correct, they're marked "solved" and are removed from the asking rotation but can remain to answer others' questions. If incorrect, turn passes as normal (decide with the user later whether a wrong guess has a penalty — flag this as an open design decision for now, default: no penalty, just wastes the turn).
7. Game ends when all players have guessed correctly, or host manually ends it. Show a results/recap screen (who guessed what, in what order, full question log).

**Chat/Log**
- All questions and all yes/no answers are public and persist in the visible session log for the duration of the round — players should be able to scroll back through the full Q&A history.

---

## 9. Realtime Design (Supabase Realtime)

- Use a **Postgres changes** subscription on `rooms`/`players` for lobby presence and room state (join/leave, host changes, game start).
- Use a **Broadcast** channel scoped per `room_id` for low-latency, ephemeral events: active turn indicator, "player is typing a question," sequential answer prompts, "I'm Done" events.
- Use **Presence** to track which players are currently connected/online in a room.
- Persist the authoritative state (question log, answers, turn order, crossed-off state) to Postgres so a page refresh or reconnect can fully rehydrate the game — Realtime broadcast is for UX responsiveness, not the source of truth.

---

## 10. Security

- **Cloudflare** in front of the Vercel deployment: enable WAF rules, rate-limit room-creation and join endpoints to prevent spam/room-flooding, enable bot-fight mode, DDoS protection.
- **Supabase RLS** on every table — no client ever gets more data than their room/role should allow (especially: never leak a player's own character assignment to themselves).
- Basic input sanitization/length limits on nicknames, questions, and any future chat to prevent XSS and abuse.
- Rate-limit question submissions and answer submissions server-side, not just client-side, to prevent spam-turn abuse.

---

## 11. Non-Functional Requirements

- Fully responsive/mobile-first (many players will join from phones via a shared link).
- Reconnect-safe: refreshing the page mid-game should not lose a player's state.
- Accessible: proper focus states, aria labels on the yes/no buttons and turn indicators.
- Clean loading/empty/error states for room-not-found, room-full, room-already-started.

---

## 12. Build Instructions Summary (for the coding agent)

1. Scaffold the Next.js app on Vercel with the routing structure in §4.
2. Set up Supabase project: tables from §5, RLS policies, Realtime enabled on relevant tables.
3. Build the platform core first (room creation, lobby, join flow, presence) as fully game-agnostic, per §3 and §7.
4. Build the `games-registry.ts` pattern so games are pluggable.
5. Implement the `who-am-i` game module per §8–§9, generate the placeholder 25-character roster per §6, and seed it into the `characters` table.
6. Wire up Cloudflare in front of the Vercel deployment and apply the security measures in §10.
7. Add SEO metadata, sitemap, and noindex rules per §4.
8. Confirm the whole platform can add a second game by only adding a new folder under `/games` + a registry entry — do not hardcode "Who Am I?" logic anywhere in the core.
