-- ---------------------------------------------------------------------------
-- Fix: a correct guess gets marked incorrect ("I guessed Whisper and it
-- said I was wrong, even though another account can see I *am* Whisper").
-- ---------------------------------------------------------------------------
-- Root cause: `characters.name` has never had a uniqueness constraint (see
-- 20260806120200_game_tables.sql), even though every reader of this table
-- assumes it:
--   - scripts/seed-who-am-i.ts upserts by name and its own comment says
--     "Names must be unique - the seed script upserts by name."
--   - games/who-am-i/components/RoomView.tsx builds the "guess who you are"
--     <select> as `characters.map(c => <option value={c.id}>{c.name}</option>)`.
--
-- If the `characters` table ever ends up with two rows sharing a name (a
-- one-off dashboard insert, a manual test row, etc. - nothing stops it
-- today, since the only write path is the service-role seed script, which
-- bypasses RLS entirely), the guess dropdown shows that name twice as two
-- visually-identical options with two different underlying ids. A player
-- assigned character_id = A can pick the option that happens to submit
-- character_id = B - same label, wrong id - and guess/route.ts (correctly)
-- reports that as incorrect, because it *is* a different row, even though
-- the name the player typed/selected was right. Meanwhile any other player
-- looking at that player's revealed card is reading the *correct* row's
-- name, so from their side everything looks right - exactly the "my other
-- account can see I'm Whisper" symptom.
--
-- Fix, in two parts:
--   1. Merge any duplicate-named rows that exist today into one canonical
--      row per name (lowest id wins, arbitrary but deterministic), so no
--      currently-stored game data ends up dangling once the constraint
--      below is added. Every foreign key into `characters.id` gets
--      repointed at the canonical row first.
--   2. A real UNIQUE constraint on `name`, so this can't silently happen
--      again - any future insert/update that would create a duplicate
--      name now fails loudly (as a 23505 from the seed script) instead of
--      quietly shipping a broken guess dropdown.
-- ---------------------------------------------------------------------------

do $$
declare
  dupe_name_count int;
begin
  -- Canonical row per name: prefer an active row over a retired one (so a
  -- currently-in-play character never loses to a stale duplicate), then
  -- the lowest id as a deterministic tiebreaker.
  create temporary table _character_dupes on commit drop as
  select
    id,
    first_value(id) over (
      partition by name
      order by (case when active then 0 else 1 end), id
    ) as canonical_id
  from public.characters
  where name in (
    select name from public.characters group by name having count(*) > 1
  );

  select count(distinct canonical_id) into dupe_name_count from _character_dupes;

  if dupe_name_count > 0 then
    raise notice
      'characters_name_unique: merging % duplicate-named character group(s) before adding the constraint.',
      dupe_name_count;
  end if;

  -- Repoint every reference to a duplicate row at its canonical row.
  update public.who_am_i_assignments a
  set character_id = d.canonical_id
  from _character_dupes d
  where a.character_id = d.id
    and d.id <> d.canonical_id;

  update public.who_am_i_assignments a
  set guessed_character_id = d.canonical_id
  from _character_dupes d
  where a.guessed_character_id = d.id
    and d.id <> d.canonical_id;

  update public.questions_log q
  set guessed_character_id = d.canonical_id
  from _character_dupes d
  where q.guessed_character_id = d.id
    and d.id <> d.canonical_id;

  -- Now safe to drop the now-unreferenced duplicate rows.
  delete from public.characters c
  using _character_dupes d
  where c.id = d.id
    and d.id <> d.canonical_id;
end $$;

alter table public.characters
  add constraint characters_name_unique unique (name);

comment on constraint characters_name_unique on public.characters is
  'Every reader of this table (seed script upsert-by-name, and the '
  'who-am-i guess dropdown, which renders one <option> per row keyed on '
  'name) assumes names are unique. This makes that assumption a real '
  'guarantee instead of a comment.';
