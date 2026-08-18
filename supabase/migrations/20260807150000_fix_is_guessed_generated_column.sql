-- ---------------------------------------------------------------------------
-- Fix: correct guesses reported as incorrect (round 2 - see
-- 20260807140000_characters_name_unique.sql for round 1, which fixed a
-- real-but-not-THE-bug issue: characters.name had no uniqueness
-- guarantee. That migration landed cleanly with zero duplicates found,
-- which ruled it out as the cause of THIS symptom and pointed at drift
-- between the live schema and 20260806120200_game_tables.sql instead.
-- ---------------------------------------------------------------------------
-- Confirmed by joining questions_log guesses against the real assignment:
-- every row where the guessed name matched the actual name (now that name
-- is genuinely unique, that means guessed_character_id = character_id,
-- full stop) still showed is_guessed = false. That's only possible if the
-- live `who_am_i_assignments.is_guessed` column isn't actually the
--   generated always as (
--     guessed_character_id is not null and guessed_character_id = character_id
--   ) stored
-- computed column 20260806120200_game_tables.sql defines - it's behaving
-- like a plain stored boolean that defaults to false, which nothing in
-- the app ever writes true to (every route treats it as
-- always-correct-by-construction, per its `generated always as`). This
-- doesn't try to diagnose *how* the live column ended up plain instead of
-- generated - it just makes the live column match what the repo, and
-- every route reading it, has always assumed it already was.
--
-- Postgres won't let you ALTER an existing plain column into a generated
-- one in place, so: drop and re-add as generated. `who_am_i_board`
-- (20260806120700_who_am_i_recap_reveal.sql) selects is_guessed, so it
-- has to be dropped and recreated around the column swap too - verbatim,
-- nothing about its masking logic changes here.
--
-- The fix is retroactive: STORED generated columns are computed for
-- every existing row the moment they're added, so every previously
-- mis-scored guess (dexter's two "Whisper" guesses, maaz's "Duke
-- Marrow", missy's "Captain Ember", sam's "Captain Anchor") flips to
-- correct immediately - no replaying/re-guessing needed. `aa`'s genuine
-- miss (guessed "Nova Stardust", was actually "Zephyr Quick") correctly
-- stays false.

drop view if exists public.who_am_i_board;

alter table public.who_am_i_assignments
  drop column if exists is_guessed;

alter table public.who_am_i_assignments
  add column is_guessed boolean generated always as (
    guessed_character_id is not null and guessed_character_id = character_id
  ) stored;

comment on column public.who_am_i_assignments.is_guessed is
  'Whether guessed_character_id (the player''s current guess at their own '
  'identity) matches character_id (their real, secret assignment). Always '
  'a computed column - never write to this directly. If this ever again '
  'shows false for a guess whose name visibly matches the assigned '
  'character''s name, re-run: select column_name, is_generated, '
  'generation_expression from information_schema.columns where '
  'table_name = ''who_am_i_assignments'' and column_name = ''is_guessed'' '
  'to check for drift again.';

-- Recreated verbatim from 20260806120700_who_am_i_recap_reveal.sql.
create view public.who_am_i_board
  with (security_invoker = false)
  as
  select
    a.session_id,
    a.player_id,
    case
      when gs.ended_at is not null then a.character_id
      when a.player_id = public.current_player_id_in_room(gs.room_id) then null
      else a.character_id
    end as character_id,
    a.crossed_off_character_ids,
    a.guessed_character_id,
    a.is_guessed
  from public.who_am_i_assignments a
  join public.game_sessions gs on gs.id = a.session_id
  where public.is_room_member(gs.room_id);

grant select on public.who_am_i_board to authenticated;

comment on view public.who_am_i_board is
  'Read path for who_am_i_assignments. character_id is nulled out for the '
  'calling player''s own row while the session is in progress, and '
  'revealed for every row (including the viewer''s own) once '
  'game_sessions.ended_at is set, for the recap screen (SPEC.md §8 point '
  '7). Do not grant SELECT on the base table - that would bypass this '
  'masking.';
