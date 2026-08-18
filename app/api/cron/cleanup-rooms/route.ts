// Room expiry cleanup (SPEC.md §7: "rooms auto-expire/cleanup after a
// period of inactivity - cron via Supabase scheduled function or Vercel
// cron hitting a cleanup endpoint"). Wired up here as a Vercel Cron target
// (see /vercel.json); protected by CRON_SECRET so only the scheduler (or
// whoever holds the secret) can trigger it. Uses the service-role admin
// client since there is deliberately no DELETE policy for `rooms` under
// normal RLS - see supabase/migrations/20260806120400_rls_core.sql.

import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { cleanupExpiredRooms } from "@/lib/rooms";
import { cleanupStaleRateLimits } from "@/lib/rateLimit";

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured (e.g. local dev) - allow
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

async function handle(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabaseAdmin = createSupabaseAdminClient();
  const result = await cleanupExpiredRooms(supabaseAdmin);
  // Piggyback the rate-limit table's own housekeeping (SPEC.md §10) on this
  // existing cron rather than standing up a second scheduled job - see
  // lib/rateLimit.ts. Best-effort: a failure here shouldn't fail room
  // cleanup, which is why cleanupStaleRateLimits already swallows its own
  // errors internally.
  const rateLimitRowsDeleted = await cleanupStaleRateLimits(supabaseAdmin);
  return NextResponse.json({ ...result, rateLimitRowsDeleted });
}

export const GET = handle;
export const POST = handle;
