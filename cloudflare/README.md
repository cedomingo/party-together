# Cloudflare in front of Vercel (SPEC.md §10)

This isn't infrastructure-as-code Claude can apply from inside this repo -
there are no Cloudflare credentials in this environment, and provisioning a
zone/ruleset happens in the Cloudflare dashboard or via their API/Terraform
provider, not via the Vercel deployment itself. This doc is the reference
for whoever *does* have dashboard/API access to wire it up, and it exists
specifically so "apply Cloudflare WAF/rate-limit/bot-fight config" isn't a
step that only lives in someone's memory.

The app-level rate limiting in `lib/rateLimit.ts` (see
`supabase/PHASE9_NOTES.md`) is the **backstop** - it still holds even if
Cloudflare is misconfigured, disabled, or bypassed. Cloudflare is meant to
be the **first line of defense**: it should absorb the bulk of abuse at the
edge, before a request burns a Vercel invocation or a Postgres round-trip
at all.

## 1. DNS / proxy

- Add the domain to Cloudflare, proxy (orange-cloud) the record(s) pointing
  at Vercel - this is what puts Cloudflare *in front of* Vercel rather than
  just doing DNS resolution.
- SSL/TLS mode: **Full (strict)** - Vercel terminates TLS with a valid cert,
  so there's no reason to fall back to flexible/off.

## 2. WAF

- Enable the **Cloudflare Managed Ruleset** and **OWASP Core Ruleset** at a
  default sensitivity in front of the whole zone. Nothing in this app needs
  exceptions carved out of the managed rules (no file uploads, no raw HTML
  rendering of user content - see the sanitization notes in
  `supabase/PHASE9_NOTES.md`).
- No custom WAF rules are required beyond the managed sets for this app's
  current surface area.

## 3. Bot Fight Mode

- Enable **Bot Fight Mode** (or **Super Bot Fight Mode** on a paid plan)
  zone-wide. This targets the same "room-flooding" and scripted spam
  SPEC.md §10 calls out, ahead of the per-IP limits below - a request an
  automated bot-detection rule blocks never reaches the app's own rate
  limiter at all.

## 4. Rate-limiting rules

Cloudflare Rate Limiting Rules are configured per-route to match (and sit
in front of) the server-side limits already enforced in the app. Keep
Cloudflare's thresholds a little *looser* than the app-level ones below -
Cloudflare's IP detection and the app's `getClientIp` (lib/http/clientIp.ts)
won't always agree bit-for-bit (e.g. clients on carrier-grade NAT sharing
one IP), so Cloudflare should be the coarse edge filter and the app-level
limiter the precise backstop, not two identical redundant walls.

| Route | Matches | Suggested Cloudflare threshold | App-level limit (source of truth) |
|---|---|---|---|
| Room creation | `POST /api/rooms/create` | 10 requests / 10 min / IP | 5 / 10 min - `app/api/rooms/create/route.ts` |
| Room join | `POST /api/rooms/join` | 40 requests / 10 min / IP | 20 / 10 min - `app/api/rooms/join/route.ts` |
| Question submission | `POST /api/games/who-am-i/question` | 20 requests / min / IP | 10 / min / player - `app/api/games/who-am-i/question/route.ts` |
| Answer submission | `POST /api/games/who-am-i/answer` | 40 requests / min / IP | 20 / min / player - `app/api/games/who-am-i/answer/route.ts` |

Action for all of the above: **Block** (or **Managed Challenge** if false
positives on shared IPs turn out to be a problem in practice) for the
duration of the request's own window.

## 5. DDoS protection

- On by default for any proxied zone - no extra configuration needed for
  L3/L4. For L7, the WAF + Bot Fight Mode + rate-limiting rules above are
  what actually shape request-level abuse; Cloudflare's automatic DDoS
  mitigation sits underneath all of it.

## 6. What's deliberately out of scope here

- No caching rules - every route in this app is either a dynamic API route
  or a Next.js page that depends on live room state; nothing here should be
  cached at the edge. The one exception, `/games/[game]` SEO landing pages
  (SPEC.md §4), can use Cloudflare's default cache behavior for static
  assets without any custom page rule - they're static per game, not
  per-request.
- No Cloudflare Access / Zero Trust - there's no admin surface in this app
  that needs it; the cron cleanup endpoint is protected by `CRON_SECRET`
  instead (see `app/api/cron/cleanup-rooms/route.ts`), checked at the
  application layer.
