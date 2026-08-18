// Reads /public/characters/who-am-i/manifest.json and syncs it into the
// `characters` table via the Supabase admin client (§5, §6 of SPEC.md).
//
// This is meant to be the ONLY step needed to change the roster: edit
// manifest.json (+ swap image files under /images), then re-run
// `npm run seed:who-am-i`.
//
// Sync strategy (upsert-by-name, soft-retire on removal):
//   - A manifest entry whose `name` already exists in `characters` gets its
//     image_url updated in place (same row/id) and is (re)marked active.
//   - A manifest entry with a `name` not yet in the table gets inserted.
//   - An existing character row whose `name` is no longer in the manifest
//     is marked `active = false`, not deleted. Rows are never hard-deleted
//     by this script: `who_am_i_assignments.character_id` has a foreign key
//     into `characters`, so a past game session can still reference a
//     retired character. `active` is exactly the flag SPEC.md §5 puts on
//     this table for this purpose, and `characters_select_active` (RLS)
//     already filters retired rows out of anything player-facing.
//
// Run with: npm run seed:who-am-i
// Requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the
// environment (loaded from .env.local below if present, same keys as
// .env.example).

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

// Deliberately NOT importing lib/supabase/admin.ts here. That helper pulls
// in the `server-only` package, which only resolves to a no-op under
// Next.js's bundler ("react-server" export condition) - run directly via
// `tsx` (a plain Node process, no Next.js/webpack involved), it always
// throws. This script builds the same privileged (service-role) client
// inline instead, scoped to this standalone script.
function createSeedAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
        "Set them in .env.local (see .env.example) before running the seed script."
    );
  }

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

interface ManifestEntry {
  id: string;
  name: string;
  imageFile: string;
}

interface CharacterRow {
  id: string;
  name: string;
  image_url: string;
  active: boolean;
}

const MANIFEST_PATH = path.join(
  process.cwd(),
  "public/characters/who-am-i/manifest.json"
);
const IMAGE_URL_PREFIX = "/characters/who-am-i/images";

// tsx doesn't auto-load .env.local the way `next dev`/`next build` do, so
// this script loads it itself (only filling in vars not already set -
// real env vars, e.g. in CI, always win). No new dependency: a `.env.local`
// is just KEY=VALUE lines.
function loadDotEnvLocal() {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;

  for (const rawLine of readFileSync(envPath, "utf-8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function loadManifest(): ManifestEntry[] {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`Manifest not found at ${MANIFEST_PATH}`);
  }

  const raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));

  if (!Array.isArray(raw)) {
    throw new Error("manifest.json must be a top-level array");
  }

  const entries: ManifestEntry[] = raw.map((entry, i) => {
    if (
      typeof entry?.id !== "string" ||
      typeof entry?.name !== "string" ||
      typeof entry?.imageFile !== "string" ||
      entry.id.trim() === "" ||
      entry.name.trim() === "" ||
      entry.imageFile.trim() === ""
    ) {
      throw new Error(
        `manifest.json entry ${i} is malformed - expected {id, name, imageFile} strings, got: ${JSON.stringify(
          entry
        )}`
      );
    }
    return entry as ManifestEntry;
  });

  const seenNames = new Set<string>();
  for (const entry of entries) {
    if (seenNames.has(entry.name)) {
      throw new Error(
        `manifest.json has a duplicate character name: "${entry.name}". ` +
          "Names must be unique - the seed script upserts by name."
      );
    }
    seenNames.add(entry.name);
  }

  return entries;
}

async function main() {
  loadDotEnvLocal();

  const manifest = loadManifest();
  console.log(`Loaded ${manifest.length} entries from manifest.json`);

  const supabaseAdmin = createSeedAdminClient();

  const { data: existingRows, error: fetchError } = await supabaseAdmin
    .from("characters")
    .select("id, name, image_url, active");

  if (fetchError) {
    throw new Error(`Failed to read characters table: ${fetchError.message}`);
  }

  const existingByName = new Map<string, CharacterRow>(
    (existingRows ?? []).map((row) => [row.name, row as CharacterRow])
  );
  const manifestNames = new Set(manifest.map((entry) => entry.name));

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  for (const entry of manifest) {
    const image_url = `${IMAGE_URL_PREFIX}/${entry.imageFile}`;
    const existing = existingByName.get(entry.name);

    if (!existing) {
      const { error } = await supabaseAdmin
        .from("characters")
        .insert({ name: entry.name, image_url, active: true });
      if (error) {
        throw new Error(`Failed to insert "${entry.name}": ${error.message}`);
      }
      inserted++;
      continue;
    }

    if (existing.image_url !== image_url || !existing.active) {
      const { error } = await supabaseAdmin
        .from("characters")
        .update({ image_url, active: true })
        .eq("id", existing.id);
      if (error) {
        throw new Error(`Failed to update "${entry.name}": ${error.message}`);
      }
      updated++;
    } else {
      unchanged++;
    }
  }

  const toRetire = (existingRows ?? []).filter(
    (row) => row.active && !manifestNames.has(row.name)
  );

  let retired = 0;
  for (const row of toRetire) {
    const { error } = await supabaseAdmin
      .from("characters")
      .update({ active: false })
      .eq("id", row.id);
    if (error) {
      throw new Error(`Failed to retire "${row.name}": ${error.message}`);
    }
    retired++;
  }

  console.log(
    `Done. inserted=${inserted} updated=${updated} unchanged=${unchanged} retired=${retired}`
  );

  if (manifest.length !== 25) {
    console.warn(
      `Note: manifest.json has ${manifest.length} entries, SPEC.md §6 calls for 25.`
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
