// Reads /public/characters/who-am-i/manifest.json and upserts rows into the
// `characters` table via the Supabase admin client (§5, §6 of SPEC.md).
// This is meant to be the ONLY step needed to change the roster: edit
// manifest.json (+ swap images), then re-run `npm run seed:who-am-i`.
//
// Left unimplemented in Phase 0 — no `characters` table exists yet.

async function main() {
  throw new Error(
    "seed-who-am-i: not implemented yet (Phase 0 scaffolding only)."
  );
}

main();
