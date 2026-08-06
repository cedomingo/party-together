-- ---------------------------------------------------------------------------
-- Phase 9: server-side rate limiting (SPEC.md §10)
-- ---------------------------------------------------------------------------
-- "Server-side rate limiting on room creation, join, question, and answer
-- submission endpoints" needs to survive across Vercel's serverless
-- instances — an in-memory counter in the route handler wouldn't (every
-- cold start / region gets its own memory). Postgres is already the
-- project's one shared, durable store (SPEC.md §2), so rate limits live
-- here as a small fixed-window counter table, rather than pulling in an
-- external dependency (e.g. Upstash Redis) purely for this.
--
-- This is deliberately the *backstop*, not the first line of defense — the
-- Cloudflare WAF/rate-limit/bot-fight rules in front of Vercel (see
-- /cloudflare/README.md) are what should absorb most abuse before it ever
-- reaches a route handler. This table protects the app even if that edge
-- layer is misconfigured, disabled, or bypassed.

create table public.rate_limits (
  -- e.g. "room-create:203.0.113.4" or "who-am-i-question:<player_id>" —
  -- callers namespace their own keys (see lib/rateLimit.ts).
  key text primary key,
  window_start timestamptz not null default now(),
  count integer not null default 0
);

-- No policies defined on purpose: RLS is enabled with zero grants, so this
-- table is completely inaccessible to the anon/authenticated roles (i.e.
-- every normal client request), regardless of what a route handler's own
-- application logic does or doesn't check. Only the service-role client
-- (which bypasses RLS entirely) can read/write it — see lib/rateLimit.ts,
-- which always calls `rate_limit_hit` via `createSupabaseAdminClient()`.
alter table public.rate_limits enable row level security;

-- Atomic "hit" for a fixed-window rate limiter: increments `key`'s counter
-- if it's within `p_limit` for the current `p_window_seconds` window,
-- otherwise reports it as disallowed without incrementing further. `for
-- update` takes a row lock on this key's own row so concurrent hits from
-- the *same* key (e.g. a double-submit) serialize instead of racing on the
-- read-modify-write — separate keys never contend with each other.
--
-- security definer + pinned search_path for the same reason as the Phase 1
-- RLS helper functions (supabase/migrations/20260806120300_helper_functions.sql):
-- lets the function read/write a table RLS otherwise locks everyone out of,
-- without a search_path-hijacking risk. Only ever invoked via the
-- service-role client in practice (see revoke/grant below), so RLS would
-- already be bypassed either way — this is belt-and-suspenders.
create or replace function public.rate_limit_hit(
  p_key text,
  p_limit int,
  p_window_seconds int
)
returns table (allowed boolean, remaining int, retry_after_seconds int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_window_start timestamptz;
  v_count int;
  v_elapsed int;
begin
  insert into public.rate_limits (key, window_start, count)
  values (p_key, v_now, 0)
  on conflict (key) do nothing;

  select window_start, count into v_window_start, v_count
  from public.rate_limits
  where key = p_key
  for update;

  v_elapsed := greatest(extract(epoch from (v_now - v_window_start))::int, 0);

  -- Window expired — start a fresh one for this key.
  if v_elapsed >= p_window_seconds then
    v_window_start := v_now;
    v_count := 0;
    v_elapsed := 0;
  end if;

  if v_count >= p_limit then
    -- Already at/over the limit for the current window — don't increment
    -- further, just report how long until it resets.
    update public.rate_limits
      set window_start = v_window_start
      where key = p_key;

    return query select false, 0, greatest(p_window_seconds - v_elapsed, 1);
    return;
  end if;

  v_count := v_count + 1;

  update public.rate_limits
    set window_start = v_window_start, count = v_count
    where key = p_key;

  return query select true, (p_limit - v_count), greatest(p_window_seconds - v_elapsed, 0);
end;
$$;

revoke execute on function public.rate_limit_hit(text, int, int) from public;
grant execute on function public.rate_limit_hit(text, int, int) to service_role;

-- Opportunistic cleanup for the cron route (lib/rateLimit.ts ->
-- cleanupStaleRateLimits, called from app/api/cron/cleanup-rooms), so this
-- table doesn't grow unbounded as new IPs/players show up over time. A key
-- is safe to drop once its window has been over for a while — nothing
-- reads a row except `rate_limit_hit`, which just re-creates it fresh via
-- the `on conflict do nothing` insert above.
create or replace function public.cleanup_stale_rate_limits(p_older_than_seconds int)
returns int
language sql
security definer
set search_path = public
as $$
  with deleted as (
    delete from public.rate_limits
    where window_start < now() - make_interval(secs => p_older_than_seconds)
    returning 1
  )
  select count(*)::int from deleted;
$$;

revoke execute on function public.cleanup_stale_rate_limits(int) from public;
grant execute on function public.cleanup_stale_rate_limits(int) to service_role;
