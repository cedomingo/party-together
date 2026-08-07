# Phase 1 — Data Model & RLS

Migrations live in `supabase/migrations/`, applied in order:

1. `20260806120000_extensions.sql` — `pgcrypto` for `gen_random_uuid()`.
2. `20260806120100_core_tables.sql` — `rooms`, `players`.
3. `20260806120200_game_tables.sql` — `game_sessions`, `characters`, `who_am_i_assignments`, `questions_log`.
4. `20260806120300_helper_functions.sql` — `is_room_member`, `is_room_host`, `current_player_id_in_room`.
5. `20260806120400_rls_core.sql` — RLS for everything except the identity-protected table.
6. `20260806120500_who_am_i_identity_protection.sql` — the "never see your own character" rule.

No frontend or API route code was touched. `lib/rooms/index.ts` and `games/who-am-i/config.ts` are untouched stubs.

## Identity model — decided: Supabase Anonymous Auth

SPEC.md §2 now states this explicitly. `players.auth_id` ties an app-level player row to a real anonymous `auth.users` row, and every RLS policy keys off `auth.uid()`. This is what SPEC.md §5 means by "enforced at the RLS/query level, not just hidden in the UI" — without a real `auth.uid()`, there is no way to make RLS actually mean anything (an anon key alone can't distinguish one browser from another).

`supabase/config.toml` now enables `enable_anonymous_sign_ins` for local dev. **Still needs doing manually in production:** Dashboard → Authentication → Providers → toggle Anonymous on for the live project — `config.toml` only governs `supabase start`/local dev, it doesn't push that setting to a hosted project.

## Schema summary

- **rooms** — `code` unique, `status` constrained to `lobby | in_progress | finished`, `host_player_id` nullable (see bootstrap below).
- **players** — one row per (room, auth session): `unique(room_id, auth_id)`. `auth_id defaults to auth.uid()`, so a client can never insert a player row impersonating someone else. `one_host_per_room` partial unique index guarantees at most one host regardless of what any policy allows.
- **game_sessions** — `state jsonb` for per-game flexible state, per §5.
- **characters** — global 25-character roster, `active` flag for swapping rosters without deleting history.
- **who_am_i_assignments** — the sensitive one. `is_guessed` is a **generated column**: `guessed_character_id = character_id`, computed server-side, so a player can find out "was I right?" without a policy ever having to expose `character_id` to them directly.
- **questions_log** — `answers jsonb` keyed by `player_id`, `resolved` flag.

### Bootstrap sequence (room creation, chicken-and-egg with host_player_id)

`rooms.host_player_id` references `players.id`, but you can't create the host's player row until the room exists. Sequence:

1. `INSERT INTO rooms (..., host_player_id) VALUES (..., NULL)` — allowed by `rooms_insert_any_authenticated` (requires `host_player_id IS NULL`).
2. `INSERT INTO players (room_id, auth_id, nickname, is_host) VALUES (<new room>, auth.uid(), '<name>', true)` — allowed by `players_insert_self_join_lobby` (room is still `'lobby'`); `one_host_per_room` guarantees this is the only host row for that room.
3. `UPDATE rooms SET host_player_id = <new player id> WHERE id = <room id>` — allowed by `rooms_update_host_only`, since step 2 already made this session the room's host.

Guests joining an existing room just do step 2 (with `is_host` omitted/false).

## How the "can't see own character_id" rule works

Direct table access is blocked entirely — `who_am_i_assignments` has no `SELECT` grant for `anon`/`authenticated`. The only read path is the `who_am_i_board` view, which nulls out `character_id` when the row's `player_id` matches the caller's own player id in that room (via `current_player_id_in_room`). Writes are restricted at the column-privilege level to `crossed_off_character_ids` and `guessed_character_id` — there is no grant that lets a client write `character_id`, so the masking can't be defeated by "just update it back."

### Verification query

Run this in the Supabase SQL editor (or `psql` against the project) after seeding test data as the service role:

```sql
-- 1. Setup as service role (bypasses RLS) — two real auth.users rows are
--    required; easiest is to actually sign in anonymously twice from the
--    client and copy their auth.uid()s, or insert directly into auth.users
--    if your local setup allows it.
--    Assume: user_a, user_b already exist in auth.users.

insert into rooms (id, code, game_id, status)
values ('11111111-1111-1111-1111-111111111111', 'TEST', 'who-am-i', 'in_progress');

insert into players (id, room_id, auth_id, nickname, is_host)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', '<user_a uuid>', 'Alice', true),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', '<user_b uuid>', 'Bob', false);

insert into characters (id, name, image_url)
values
  ('c0000000-0000-0000-0000-000000000001', 'Captain Cosmos', '/x.png'),
  ('c0000000-0000-0000-0000-000000000002', 'Doctor Static', '/y.png');

insert into game_sessions (id, room_id, game_id, started_at)
values ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', 'who-am-i', now());

insert into who_am_i_assignments (session_id, player_id, character_id)
values
  ('55555555-5555-5555-5555-555555555555', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'c0000000-0000-0000-0000-000000000001'),
  ('55555555-5555-5555-5555-555555555555', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'c0000000-0000-0000-0000-000000000002');

-- 2. Impersonate Alice's session and query as `authenticated`.
set role authenticated;
select set_config('request.jwt.claim.sub', '<user_a uuid>', true);
select set_config('request.jwt.claims', json_build_object('sub', '<user_a uuid>', 'role', 'authenticated')::text, true);

select * from who_am_i_board order by player_id;
-- Expect: Alice's row (player_id = aaaa...) has character_id = NULL.
--         Bob's row (player_id = bbbb...) has character_id populated.

select * from who_am_i_assignments;
-- Expect: permission denied / empty — proves there is no direct read path
-- around the masking view.

reset role;
```

If Alice's row ever shows a non-null `character_id`, the rule is broken — check that no policy or grant was added to `who_am_i_assignments` giving `SELECT` to `anon`/`authenticated`.

## Open RLS edge cases (flagging for your review before Phase 2)

1. **`rooms` SELECT is open to any authenticated session, not just members.** Necessary for "join by code" to work before you're a player. No sensitive data lives on `rooms`, so the exposure is just room existence/status/code — flag if you want join-by-code handled differently (e.g. a dedicated RPC) instead.
2. **No RLS path yet for host-managed player actions** (kick a player, transfer host). `players_update_self` only covers a player updating their own row. Deliberately left out rather than writing a loose "host can update any player row" policy, since RLS can't restrict *which columns* a host is allowed to touch on someone else's row (e.g. host shouldn't be able to silently rewrite another player's nickname). Recommend an RPC (`SECURITY DEFINER` function) for these in a later phase instead of a raw UPDATE policy.
3. **`game_sessions.state` and `questions_log.answers`/`resolved` are writable by any room member**, not just "whoever's turn it is." Needed because the active player (not necessarily the host) drives turn state, but this means any member can currently overwrite another player's answer or force `resolved = true` early. Recommend replacing these broad UPDATE policies with turn-validating RPCs once the turn engine is designed (Phase 2/3).
4. **No max-player-count enforcement at the DB level.** `rooms.max_players` exists but nothing stops `players` inserts past it — deferred to app logic or a trigger later.
5. **Character assignment has no write path yet on purpose.** There's no INSERT policy for `who_am_i_assignments` for `authenticated`/`anon` — the random, no-repeats assignment at game start is trusted server logic and belongs in a later phase (likely a `SECURITY DEFINER` RPC called by the host, or the service-role admin client from a route handler). Flag if you want that RPC built now as part of "database only."
6. **`questions_log_insert_asker_only`** checks that the inserting row's `asking_player_id` really is the caller's own player id — but not that it's actually their turn in rotation. Turn-order state doesn't exist yet (lives in `game_sessions.state`), so this is deferred along with #3.

Waiting for your confirmation (and a decision on the anonymous-auth assumption + the flagged items above) before starting Phase 2.
