# Phase 9 - Security Hardening

Applies SPEC.md §10. Four pieces:

1. Cloudflare WAF/rate-limit/bot-fight config - see `/cloudflare/README.md`
   (documentation, not code - no Cloudflare credentials or API access in
   this environment, and provisioning a zone happens outside the repo).
2. Server-side rate limiting on room creation, join, question, and answer
   submission.
3. Input sanitization/length limits on nicknames and questions.
4. RLS (already in place since Phase 1) continues to be the actual data
   access boundary - nothing in this phase weakens or replaces it.

## Rate limiting

New: `supabase/migrations/20260806120800_rate_limits.sql`,
`lib/rateLimit.ts`, `lib/http/clientIp.ts`.

**Why Postgres instead of Redis/Upstash:** Vercel serverless functions
don't share memory across instances/regions, so an in-process counter
wouldn't actually limit anything under real traffic - the project already
has one shared, durable store (Supabase/Postgres, SPEC.md §2), so the
limiter lives there instead of adding an external dependency just for
this. `rate_limit_hit` is a fixed-window counter (`key`, `window_start`,
`count`), atomic via `for update` row locking so concurrent hits on the
*same* key serialize instead of racing - separate keys (different IPs,
different players) never contend with each other, so this doesn't become
a bottleneck under normal traffic.

`rate_limits` has RLS enabled with **zero policies** - not "policies that
happen to be restrictive," genuinely no way in for `anon`/`authenticated`.
Every read/write goes through `rate_limit_hit`/`cleanup_stale_rate_limits`
(`security definer`, granted only to `service_role`), called exclusively
via the admin client (`lib/rateLimit.ts` always uses
`createSupabaseAdminClient()`). This is infrastructure bookkeeping, not
user data - no room member's own client has any reason to read or write
it directly.

**What's limited, and where the key comes from:**

| Endpoint | Key | Limit |
|---|---|---|
| `POST /api/rooms/create` | `room-create:<ip>` | 5 / 10 min |
| `POST /api/rooms/join` | `room-join:<ip>` | 20 / 10 min |
| `POST /api/games/who-am-i/question` | `who-am-i-question:<player_id>` | 10 / min |
| `POST /api/games/who-am-i/answer` | `who-am-i-answer:<player_id>` | 20 / min |

Room create/join are keyed by IP (`lib/http/clientIp.ts`, reading
`CF-Connecting-IP` first, falling back to `X-Forwarded-For`) because
there's no player identity yet at the point someone's trying to create or
join a room - that's exactly the "room-flooding" spam SPEC.md §10 names.
Question/answer are keyed by player id instead, once a caller is already
an authenticated room member - IP would either be too coarse (a whole
household behind one NAT'd IP playing together, sharing the limit) or
pointless (the turn-order check already only lets one specific player
call these at a given moment; the limit exists as a backstop against a
single compromised/scripted session, not against multiple legitimate
players).

**Reconnect vs. join, and why the join limit doesn't break refreshing:**
`joinRoomByCode` is *only* called when someone submits a code + nickname
they don't already have a player row for
(`app/components/JoinRoomForm.tsx`, and the in-room join form in
`RoomClient.tsx` for someone who navigated straight to a room link).
Reconnecting an *existing* player row on page load/refresh
(`RoomClient.tsx`'s initial-load effect) calls `getRoomByCode` +
`listPlayers` + `setPlayerConnected` directly - it never touches
`joinRoomByCode` or the new `/api/rooms/join` route at all, so refreshing
the room page repeatedly does not count against the join rate limit.

**Fail-open, not fail-closed:** if the rate-limit RPC itself errors (e.g.
a transient DB issue), `enforceRateLimit` logs and allows the request
through rather than blocking everyone. The endpoints underneath still have
their own validation and RLS; a broken rate limiter shouldn't be able to
take the whole app down with it.

**Why room creation/join moved into route handlers at all:** before this
phase, `createRoom`/`joinRoomByCode` (`lib/rooms/index.ts`) were called
directly from the browser's Supabase client - RLS scoped *what* they could
write, but there was no server-side place to put a rate limit in front of
*how often*. Phase 9 adds `app/api/rooms/{create,join}/route.ts` as thin
wrappers around the exact same `lib/rooms` functions (unchanged) purely so
there's a route handler to rate-limit; the browser now calls those routes
via `lib/rooms/client.ts` instead of the Supabase SDK directly for these
two actions specifically. Every other room/lobby operation (listing
players, presence, starting the game, etc.) is untouched.

**Cleanup:** `rate_limits` rows for IPs/players that stop showing up would
otherwise accumulate forever. `cleanup_stale_rate_limits` (Postgres
function) deletes rows whose window hasn't been touched in 24h+; it's
called from the existing room-expiry cron
(`app/api/cron/cleanup-rooms/route.ts`) rather than standing up a second
scheduled job, and is best-effort (its own errors are swallowed so a
cleanup hiccup never fails room cleanup).

## Input sanitization

`lib/rooms/index.ts` exports `stripUnsafeChars`, shared by
`sanitizeNickname` (same file) and `sanitizeQuestionText`
(`app/api/games/who-am-i/question/route.ts`, already existed pre-Phase-9
- extended here to share the same character-stripping logic). Both strip:

- Angle brackets (`<` `>`) - not a full HTML sanitizer, and doesn't need
  to be: nicknames/questions are only ever rendered as React text content
  (never `dangerouslySetInnerHTML`), which already escapes everything
  else. This keeps raw `<script>`-shaped strings out of the *stored* data
  too, as defense in depth for any future consumer (an export, a
  different renderer) that might not escape as carefully.
- C0/C1 control characters and zero-width/bidi-override characters - no
  legitimate nickname or question needs them, and they're a known vector
  for spoofing or obscuring displayed text.

Both then collapse whitespace, trim, and enforce a length cap (32 chars
for nicknames, 280 for questions) before the value ever reaches Postgres.
The DB's own `check` constraints (`players.nickname`,
`questions_log.question_text` - `supabase/migrations/20260806120100_core_tables.sql`,
`20260806120200_game_tables.sql`) remain the actual backstop; the
application-level sanitization exists to fail fast with a friendlier
error and a consistent shape, not to be the only thing standing between
user input and the database.

## Open items / not done in this phase

- Cloudflare zone config itself (see `/cloudflare/README.md`) still needs
  to be applied by whoever has dashboard/API access - it can't be done
  from this repo/environment.
- No CAPTCHA/challenge on room create or join. Cloudflare Bot Fight Mode
  (per the README) is the intended first line of defense against
  scripted/automated abuse here; nothing in the app layer does bot
  detection itself.
