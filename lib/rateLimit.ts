import "server-only";

// Server-side rate limiting (SPEC.md §10: "server-side rate limiting on
// room creation, join, question, and answer submission endpoints ... to
// prevent spam-turn abuse"). Backed by the `rate_limits` table + atomic
// `rate_limit_hit` Postgres function (see
// supabase/migrations/20260806120800_rate_limits.sql) — durable across
// Vercel's serverless instances, unlike an in-memory counter.
//
// Always goes through the service-role admin client: `rate_limits` has RLS
// enabled with zero policies, so the anon/authenticated roles (i.e. every
// normal request's own cookie-authenticated client) can't touch it at all.
// This is infrastructure bookkeeping, not user data — there's no reason a
// room member's own client should ever read or write it directly.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export class RateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfterSeconds: number
  ) {
    super(message);
  }
}

export interface RateLimitConfig {
  /** Namespaced key, e.g. `room-create:<ip>` or `who-am-i-answer:<player_id>`. */
  key: string;
  limit: number;
  windowSeconds: number;
}

interface RateLimitHitRow {
  allowed: boolean;
  remaining: number;
  retry_after_seconds: number;
}

/**
 * Throws `RateLimitError` if `key` has exceeded `limit` hits within the
 * current `windowSeconds` window, otherwise records this call as a hit and
 * returns normally. Fails *open* (allows the request through, logging the
 * failure) if the rate-limit infrastructure itself errors — a broken
 * rate-limit check shouldn't take the whole app down with it; the
 * endpoints this guards still have their own validation/RLS underneath.
 */
export async function enforceRateLimit(
  config: RateLimitConfig,
  admin: SupabaseClient = createSupabaseAdminClient()
): Promise<void> {
  const { data, error } = await admin
    .rpc("rate_limit_hit", {
      p_key: config.key,
      p_limit: config.limit,
      p_window_seconds: config.windowSeconds,
    })
    .single<RateLimitHitRow>();

  if (error) {
    console.error(`Rate limit check failed for "${config.key}" — allowing request:`, error.message);
    return;
  }

  if (!data?.allowed) {
    throw new RateLimitError(
      "Too many requests — please slow down and try again shortly.",
      data?.retry_after_seconds ?? config.windowSeconds
    );
  }
}

/**
 * Best-effort cleanup of stale rows so `rate_limits` doesn't grow forever
 * as new IPs/players show up. Called from the existing room-expiry cron
 * (app/api/cron/cleanup-rooms) rather than a separate scheduled job.
 */
export async function cleanupStaleRateLimits(
  admin: SupabaseClient,
  olderThanSeconds: number = 24 * 60 * 60
): Promise<number> {
  const { data, error } = await admin.rpc("cleanup_stale_rate_limits", {
    p_older_than_seconds: olderThanSeconds,
  });
  if (error) {
    console.error("Stale rate-limit cleanup failed:", error.message);
    return 0;
  }
  return (data as number) ?? 0;
}
