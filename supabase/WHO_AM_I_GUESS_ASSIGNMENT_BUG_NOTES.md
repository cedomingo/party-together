# "No character assigned" guess bug — full trail

Symptom: submitting a guess in Who Am I? failed with "you don't have a
character assigned for this round," even for players whose assignment row
genuinely existed and matched. This turned out to be two unrelated bugs
plus one instance of untracked drift, found across three rounds of
investigation. Recorded here so the full trail lives in one place instead
of being scattered across chat/debugging sessions.

## Bug 1 — phantom function drift (RLS policy)

The live `who_am_i_assignments_update_own_row` UPDATE policy had been
hand-patched directly against the database (SQL editor, no tracked
migration) to call `current_player_id_for_session(session_id uuid)` — a
function that never existed in this repo. It returned null for every
call, so the policy's `player_id = null` check was never true, so every
guess `UPDATE` matched 0 rows with no error.

Fixed by dropping that phantom function/policy and recreating the policy
against `current_player_id_in_room` (the real, version-controlled helper
from `20260806120300_helper_functions.sql`) — which is what
`20260806120500_who_am_i_identity_protection.sql` specified all along.
That fix itself was run live before being committed back to this folder;
see Bug 3 below for how that gap was found and closed.

## Bug 2 — stale `connected` snapshot at game start

Separately, `who_am_i_assignments` rows were only ever created for
players who were `connected = true` at the instant the host clicked
Start (`start/route.ts`). A real, still-present player whose `connected`
flag happened to be transiently false at that exact moment (e.g. a
backgrounded tab firing `pagehide`/`sendBeacon` right as everyone reacts
to Start being clicked — see `RECONNECT_VERIFICATION.md`) never got an
assignment row for that round. Same user-facing error, unrelated cause.

Confirmed via `debug_whoami()` / `debug_guess_attempt()`
(`20260807140100`/`20260807140200`, dropped in `20260807160000` once this
was root-caused): with Bug 1 fixed, `auth.uid()`,
`current_player_id_in_room()`, and the UPDATE-under-RLS path all evaluate
exactly as intended — ruling out any further RLS explanation.

Fixed by removing the `connected` filter from the start-of-round roster
query in `start/route.ts`; it now assigns to every current room member,
full stop. See that file's own comment for the detailed reasoning.

## Bug 3 (really: process gap) — the Bug-1 fix wasn't committed

`supabase_migrations.schema_migrations` on the live project had a 21st
applied version, `20260808000000`, with no corresponding file anywhere in
`supabase/migrations/` — every other version matched a file 1:1. That's
the Bug 1 fix having been run straight against the live database and
never turned into a tracked migration, i.e. exactly the same class of
problem Bug 1 itself was (an untracked hand-edit silently diverging from
version control).

Closed by `20260808000000_who_am_i_assignments_update_policy_drift_fix.sql`,
which reconstructs that live change as a real, idempotent migration
file, so `supabase db push` against a clean environment now reproduces
the fixed state exactly rather than depending on a one-off SQL editor run.

## Takeaway

If "0 rows matched, no error" shows up again anywhere in this project,
check in this order: (1) does the assignment/target row actually exist
(query as the table owner, bypassing RLS, to rule this in/out first); (2)
does every function the relevant policy calls actually exist in
`supabase/migrations/` — grep `pg_policies`/`pg_proc` on the live project
and diff by eye, the way `scripts/diagnose_join_bug.sql` does; (3) does
`supabase_migrations.schema_migrations` on the live project actually
match every file in this folder, version for version. All three have now
independently caused this exact symptom.
