# Party Together

party game platform. Host creates a room, shares a link,
friends join and play browser-based party games together. First game:
**Who Am I?**

See `SPEC.md` for the full build spec.

## Status

**Phase 2 - Platform Core: Rooms & Lobby.** Create/join/lobby flow works
end-to-end: short room codes, join by link or code, nickname-only identity
(Supabase Anonymous Auth), live lobby (connected players + host badge),
host-only "Start Game" stub (flips room status, zero game logic), best-effort
disconnect/reconnect handling, and a cron-ready room expiry cleanup endpoint.
See `supabase/PHASE1_NOTES.md` for the Phase 1 data model/RLS writeup.

No game itself is implemented yet - "Who Am I?" is registered in
`lib/games-registry.ts` as metadata only (name/description/player counts),
with no board, turn system, or components.

## Stack

- Next.js (App Router) → Vercel
- Supabase (Postgres + RLS + Realtime + Storage)
- Cloudflare in front of Vercel (DNS/WAF/rate limiting)

## Getting started (once Phase 1+ lands)

```bash
npm install
cp .env.example .env.local   # fill in Supabase project values
npm run dev
```

## Project structure

```
/app                          Next.js routes (platform core UI)
/games                        Game plugin modules (self-contained, swappable)
  /who-am-i
/lib
  /supabase                   Supabase client/server/admin helpers
  /rooms                      Game-agnostic room/lobby core logic
  /games-registry.ts          Central list of registered games
/public/characters/who-am-i   Character roster assets (manifest.json + images)
```

Core architecture rule: the platform core (`/app`, `/lib/rooms`) must never
contain game-specific logic. Adding a new game = a new folder under `/games`
plus one entry in `/lib/games-registry.ts`.
