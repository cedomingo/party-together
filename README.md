# Party Together

Skribbl.io-style party game platform. Host creates a room, shares a link,
friends join and play browser-based party games together. First game:
**Who Am I?**

See `SPEC.md` for the full build spec.

## Status

**Phase 0 — scaffolding.** Folder structure, empty Next.js app, and Supabase
client helpers only. No rooms, no games, no database tables yet.

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
