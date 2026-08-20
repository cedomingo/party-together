# Party Together

**A Skribbl.io-style multiplayer party game platform.** A host creates a room, shares a short link or code, friends join from their phones with just a nickname (no account/signup), and everyone plays a real-time party game together in the browser.

- **Live:** [party-together-lovat.vercel.app](https://party-together-lovat.vercel.app) (production domain target: `partytogether.online`)
- **Repo:** `cedomingo/party-together`
- **Status:** Platform core + 2 full games shipped and polished (see [Status & Roadmap](#status--roadmap))
- **Scale:** ~199 tracked files, ~12,700 lines of TypeScript/TSX, 30 Postgres migrations

---

## The pitch

Think Jackbox/Skribbl.io, but architected from day one so **new games can be dropped in without touching the platform.** Rooms, lobbies, presence, reconnect handling, and security are all game-agnostic "platform core." Each game is a self-contained plugin folder that registers itself. Two games currently ship on top of that core:

### 🎭 Who Am I?
Everyone in the room can see your secret character except *you*. On your turn you ask the room a yes/no question; the game requires each other player answer one at a time (not all-at-once), publicly and permanently logged. Guess your own identity correctly to "solve"; guess wrong and your turn is just wasted (no penalty). Two win-condition modes: **last-one-standing-loses** or **first-correct-guess-wins**, host-configurable in the lobby.

### 🕵️ Who Are You?
The inverse: everyone secretly *picks* a character (duplicates allowed), and you're trying to guess everyone else's pick, not your own. Structurally the harder build of the two — each player maintains **N−1 independent boards** (one per opponent), presented as a "messaging app" UI where each opponent is a separate conversation thread with its own board and Q&A history. Two host-configurable base modes (**Guess Everyone** vs **Rival Match**, where each player is assigned one fixed rival in rotation order) plus an orthogonal "First Win Ends Game" toggle that layers on top of either.

Both games reuse the same 25-character roster, the same yes/no/other question-log plumbing, and the same turn-loop shape — proving the plugin architecture actually works rather than just being aspirational.

---

## Architecture: platform core vs. game plugins

This is the central design decision of the whole codebase (see `SPEC.md` §3). Two strictly decoupled layers:

**A. Platform core** (`/app`, `/lib/rooms`, `/lib/supabase`) — 100% game-agnostic:
- Room creation with short shareable codes, join by link or code
- Nickname-only identity (no email/password/OAuth)
- Lobby: connected players, host badge, host-only "Start Game"
- Presence (who's online right now), disconnect/reconnect handling
- Room expiry + scheduled cleanup

**B. Game modules** (`/games/<game-id>/`) — self-contained and swappable:
- Own `GameConfig` (id, display name, min/max players, description, thumbnail, optional SEO copy)
- Own Postgres tables + RLS policies
- Own React components for the in-room view
- Own `onStart` hook (runs instead of the platform's generic "flip status to in_progress" stub — e.g. Who Am I's character assignment)
- Optional `LobbyOptions` component for host-configurable game modes/checkboxes, threaded opaquely through the core without the core ever knowing what it means

The **only** file the platform core is allowed to import a game module from is `lib/games-registry.ts`. Adding a third game = a new folder + one registry entry, with zero changes to room/lobby code — this was explicitly validated by building a *second* game (Who Are You?) after the first, reusing ~most of the turn-loop and all of the character-roster/asset pipeline.

---

## Tech stack

| Layer | Choice |
|---|---|
| Frontend/Framework | Next.js 15 (App Router), React 18, TypeScript |
| Hosting | Vercel |
| Database / Backend | Supabase (Postgres + Row Level Security + Realtime + Storage) |
| Auth | Supabase Anonymous Auth (no accounts) |
| Edge / Security | Cloudflare in front of Vercel (DNS, WAF, bot-fight mode, rate limiting) |
| Scheduling | Vercel Cron (daily room-expiry cleanup) |

No external state/animation/UI libraries beyond what's listed in `package.json` (`@supabase/supabase-js`, `@supabase/ssr`) — styling is hand-written CSS (`globals.css`), and even the character sound effects are synthesized in-browser via the Web Audio API (see [Fun/notable details](#fun--notable-engineering-details)) rather than shipped as audio files.

---

## Identity model (no accounts, but not anonymous-anonymous)

There's no login system a player ever sees. Under the hood, every browser session calls `supabase.auth.signInAnonymously()`, which creates a real `auth.users` row and a real `auth.uid()` — invisible to the player, but exactly what makes the security model below possible. The app-level "player" is a separate row in `players`, keyed off that `auth_id`, one row per **(room, session)** pair — so a single browser session can be in multiple rooms at once without collisions. This is a deliberate architectural choice, not just convenience: it's the only way Row-Level Security can distinguish "your browser" from "their browser" without trusting a client-supplied ID.

---

## Data model & Row-Level Security

Core tables: `rooms`, `players`, `game_sessions` (generic `jsonb` state), plus per-game tables (`who_am_i_assignments`, `who_are_you_selections`, `who_are_you_boards`), `characters` (shared 25-entry roster), and `questions_log` (shared question/answer format across both games, including a `target_player_id` column added specifically so Who Are You could reuse it for per-opponent targeting).

**The one rule the entire first game hinges on:** a player must *never* be able to read their own `character_id` in `who_am_i_assignments`, enforced at the RLS/query level — not hidden in the UI, not "trust the client not to look." Who Are You needed the **inverse** masking rule (you can always read your own pick, never anyone else's) using the same trusted-server-write pattern.

Other RLS-level guarantees worth noting:
- `rate_limits` has RLS enabled with **zero policies** — not "restrictive policies," genuinely no path in for normal clients. Every read/write goes through a `security definer` Postgres function callable only by the service-role admin client.
- The room-full cap (`max_players`) is enforced **both** in application code (friendly error message) **and** as a `with check` condition baked into the join-policy itself — because only the RLS check, running atomically as part of the insert statement, can actually close the race where two people submit the join form for the last open seat at the same instant.
- 30 timestamped migrations track the schema's real evolution, including several targeted bug-fix migrations (e.g. a generated-column fix for `is_guessed`, a grant-drift fix for assignment visibility) — the schema wasn't designed once and frozen, it was iterated on as edge cases surfaced.

---

## Realtime design

Three different Supabase Realtime primitives, each used for what it's actually good at:
- **Postgres changes** subscription on `rooms`/`players` — lobby membership, room status changes
- **Broadcast** (per-room channel) — low-latency ephemeral UX events: turn indicator, "someone is answering," "I'm Done"
- **Presence** — who's currently online, shared across the lobby view and whichever game module is active (one subscription per room, not one per view)

Postgres remains the source of truth throughout — Realtime is for responsiveness, not authority. A page refresh or reconnect fully rehydrates game state from the database, backed up by `visibilitychange`/`online`/`pageshow` listeners that force a resync when a backgrounded tab/phone comes back to life, as a backstop to Realtime's own reconnect logic rather than a replacement for it.

---

## Security (defense in depth, four layers)

1. **Cloudflare, in front of Vercel** (documented in `cloudflare/README.md` as the reference for whoever has dashboard access — not applicable as infrastructure-as-code from inside the repo): proxied DNS, SSL mode Full (strict), Cloudflare Managed Ruleset + OWASP Core Ruleset, Bot Fight Mode, and per-route rate-limiting rules deliberately set a little *looser* than the app-level limits below, so Cloudflare is the coarse edge filter and the app is the precise backstop — not two redundant identical walls.
2. **App-level rate limiting**, backed by Postgres rather than an in-memory counter (Vercel serverless instances don't share memory) — a fixed-window counter with row-level locking so concurrent hits on the *same* key serialize correctly. Room create/join are keyed by IP; question/answer submission are keyed by player ID once someone's already an authenticated room member. Fails **open** (allows the request, logs the error) if the limiter infrastructure itself breaks, rather than taking the whole app down.
3. **Row-Level Security** on every table — the actual, unbypassable data-access boundary described above.
4. **Input sanitization**: nicknames and questions strip angle brackets and control/zero-width/bidi-override characters, collapse whitespace, and get length-capped (32 / 280 chars) before ever reaching Postgres — defense in depth on top of React's own escaping, plus a DB-level `check` constraint as the final backstop.

---

## SEO & routing

Path-based routing under one domain (chosen over subdomains to consolidate SEO authority and avoid duplicate SSL/DNS): `/games/<game-id>` is a real, crawlable, server-rendered landing page per game with full metadata + `BreadcrumbList`/`VideoGame` JSON-LD structured data, driven entirely by each game's `GameConfig` so a third game gets a landing page and sitemap entry for free. `/games/<game-id>/room/<code>` (the actual live room) is `noindex`, since it's ephemeral and dynamic.

---

## Accessibility & mobile polish

- WCAG-checked color contrast (one color adjusted from ~4.38:1 to ~5.4:1 to clear AA for normal text)
- Global `:focus-visible` styles, skip-to-content link, `prefers-reduced-motion` handling that freezes rather than removes animations
- Explicit `viewport` meta that deliberately preserves pinch-zoom (WCAG 1.4.4) instead of relying on framework defaults
- 44px minimum touch targets, `touch-action: manipulation` to kill iOS's double-tap-zoom delay, and a dedicated `max-width: 480px` layout pass (e.g. the 25-character grid re-flows from an awkward partial-column layout to a clean 4-column grid on phone-width screens)
- `aria-label`s on yes/no answer buttons, `role="status" aria-live="polite"` on the turn indicator
- A shared `StatusScreen` component standardizes loading/room-not-found/room-full/room-already-started/generic-error states with the correct ARIA role per state, replacing what had been several slightly-inconsistent one-off implementations

---

## Fun / notable engineering details

- **Custom avatar creator**: players pick a mushroom-character base color + one of 12 accessories (bow tie, goggles, beret, sunglasses, mustache, etc.) from hand-designed art assets, persisted to `localStorage` and shared across the homepage, per-game landing pages, and the in-room join form — deliberately *not* sent to the server, since it's a pure client-side display preference.
- **Character sound effects, zero audio files**: each of the 25 characters plays a short cartoonish animal-sound impression (bee buzz, lion roar, pig oink, etc.) on tap, entirely synthesized in-browser through the Web Audio API — no network request, no licensing concerns, lazily initialized on first tap to satisfy autoplay policies.
- **Debug/diagnostic trail as first-class artifacts**: multiple SQL scripts and dedicated markdown writeups (`WHO_AM_I_GUESS_ASSIGNMENT_BUG_NOTES.md`, `RECONNECT_VERIFICATION.md`, `diagnose_join_bug.sql`) document real production bugs that were tracked down and fixed, not just silently patched — including a live-vs-repo state mismatch and a room-full enforcement gap that had existed since Phase 1 and wasn't caught until the final polish pass.
- **Phased build process**: the entire platform was built via an explicit, numbered phase plan (`PHASE.md`) — 10+ phases from empty scaffolding through schema/RLS, platform core, the plugin registry pattern, each game module, realtime wiring, SEO, security hardening, and final polish — each phase scoped narrowly enough to review and commit independently before the next began.

---

## Project structure

```
/app
  page.tsx                          Landing page (lists all games)
  games/[game]/page.tsx             SEO-indexable per-game landing page
  games/[game]/room/[code]/         Live room UI (RoomClient.tsx = platform core shell)
  api/
    rooms/{create,join,sweep,switch-game}/
    games/who-am-i/{start,question,answer,done,guess,end,play-again}/
    games/who-are-you/{start,begin-turns,question,answer,done,guess,end,play-again}/
    cron/cleanup-rooms/            Daily Vercel Cron target
    presence/
  components/                       Shared UI: forms, avatar creator, room roster, status screens

/games
  who-am-i/                         config, board/recap components, turn-state logic, realtime events
  who-are-you/                      config, per-opponent board/recap components, turn-state + session logic

/lib
  rooms/                            Game-agnostic room/lobby core (index.ts + browser client wrapper)
  supabase/                         client / server / admin (service-role) Supabase clients
  http/clientIp.ts                  CF-Connecting-IP-aware client IP resolution
  games-registry.ts                 The single import point for all game modules
  rateLimit.ts, avatar.ts, animalSounds.ts, paperBorder.ts, site.ts

/public/characters/who-am-i         manifest.json + 25 character images (shared by both games)
/public/ui                          Avatar parts, game cover art

/supabase
  migrations/                       30 timestamped SQL migrations (schema + RLS, chronological)
  PHASE1_NOTES.md, PHASE9_NOTES.md, PHASE10_NOTES.md, RECONNECT_VERIFICATION.md,
  WHO_AM_I_GUESS_ASSIGNMENT_BUG_NOTES.md

/scripts/seed-who-am-i.ts           Seeds the characters table from manifest.json

/cloudflare/README.md               Reference doc for whoever configures the Cloudflare zone
SPEC.md                             Original full build specification
PHASE.md                            Phase-by-phase build prompts used to construct the app
app/games/WHO-ARE-YOU-SPEC.md       Build spec for the second game module
```

---

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in Supabase project values
npm run dev
```

Required environment variables (see `.env.example`):
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — safe to expose; RLS enforces access
- `SUPABASE_SERVICE_ROLE_KEY` — server-only, never committed or exposed to the client
- `NEXT_PUBLIC_SITE_URL` — canonical origin for sitemap/OG/JSON-LD
- `CRON_SECRET` — shared secret gating the cleanup cron endpoint
- `CLOUDFLARE_ZONE_ID` / `CLOUDFLARE_API_TOKEN` — documented but not consumed at runtime (Cloudflare sits in front of Vercel at the DNS layer, configured via dashboard/API, not app code)

Also requires enabling **Anonymous Sign-ins** in the Supabase project (local: `supabase/config.toml`, production: Dashboard → Authentication → Providers → Anonymous).

---

## Status & roadmap

Both games are feature-complete through the full phase plan: setup, turn loop, guessing, win conditions, recap screens, realtime wiring, SEO, security hardening, and accessibility/mobile polish are all shipped and verified (clean `tsc --noEmit`, `next build`, and `next lint`). The Cloudflare zone itself is documented but requires dashboard/API access outside the repo to actually provision — that's the one piece still open at time of writing.

The plugin architecture is proven in practice (two independent games sharing one platform core, one adding *before* not knowing its own identity, the other flipping that rule entirely), which is the structural bet the whole project was built around.
