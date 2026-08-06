import "server-only";

// Resolves the caller's IP for use as a rate-limit key (SPEC.md §10).
// `CF-Connecting-IP` is set by Cloudflare (see /cloudflare/README.md) and is
// the most trustworthy source once that's in front of Vercel — it's the
// original client IP, not any proxy hop in between. `X-Forwarded-For` is
// Vercel's own fallback (and what you get in local dev / previews without
// Cloudflare wired up yet); its first entry is the original client. Neither
// header is attacker-controllable from outside Cloudflare/Vercel's own
// edge — a client can send whatever it wants in these headers, but
// Cloudflare/Vercel overwrite them at the edge rather than appending, so
// what reaches this route handler is theirs, not the caller's.
export function getClientIp(request: Request): string {
  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.trim();

  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();

  // No identifiable IP (e.g. some local dev setups) — fall back to a
  // constant bucket rather than throwing, so rate limiting fails safe
  // (shared, stricter-feeling limit) instead of crashing the request.
  return "unknown";
}
