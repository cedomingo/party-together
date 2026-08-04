"use client";

// Supabase client for use in Client Components.
// Uses the public anon key — RLS policies are what actually restrict access,
// not this key, so it is safe to ship to the browser.
//
// Usage:
//   import { createSupabaseBrowserClient } from "@/lib/supabase/client";
//   const supabase = createSupabaseBrowserClient();

import { createBrowserClient } from "@supabase/ssr";

// NOTE: Database type will be generated once tables exist (Phase 1+) via
// `supabase gen types typescript`. Left untyped for now on purpose.
export function createSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
        "Copy .env.example to .env.local and fill them in."
    );
  }

  return createBrowserClient(url, anonKey);
}
