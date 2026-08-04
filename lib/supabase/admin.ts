import "server-only";

// Privileged Supabase client using the service role key.
// Bypasses RLS entirely — only ever import this from trusted server-side
// code (cron/cleanup route handlers, the character-roster seed script).
// NEVER import this from a Client Component or anything bundled to the browser.
//
// Usage:
//   import { createSupabaseAdminClient } from "@/lib/supabase/admin";
//   const supabaseAdmin = createSupabaseAdminClient();

import { createClient } from "@supabase/supabase-js";

export function createSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
        "These must be set server-side only (cron jobs, seed scripts)."
    );
  }

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
