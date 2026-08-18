-- ---------------------------------------------------------------------------
-- Phase 6c: guesses show up in the shared question log (treated the same
-- as an asked question), and answers are no longer constrained to "yes"/
-- "no" only.
-- ---------------------------------------------------------------------------
-- 1. `questions_log.answers` is (and always was) an unconstrained jsonb
--    map - there is no check constraint limiting values to "yes"/"no", so
--    free-text answers ("Other... <typed answer>") need no schema change
--    at all. That validation is purely an application-layer choice (see
--    app/api/games/who-am-i/answer/route.ts).
--
-- 2. Guessing your own identity (app/api/games/who-am-i/guess/route.ts)
--    previously only ever touched `who_am_i_assignments` + `game_sessions.
--    state` - it never wrote anything to `questions_log`, so a guess was
--    invisible in the shared log every other player scrolls through,
--    even though SPEC.md §8 point 6 treats it as a first-class turn
--    action ("at any point on their turn instead of/after asking a
--    question"). These two columns let the guess route log a guess the
--    same way a question gets logged, without ever having to smuggle the
--    *true* character_id through question_text (guess/route.ts already
--    never reads it - see that file's header - and this doesn't change
--    that).
--
-- Nothing here touches who_am_i_assignments, its RLS, or the who_am_i_board
-- masking view - a guess entry only ever records the *guessed* character
-- (public information the guesser themselves chose), never the secret one.

alter table public.questions_log
  add column is_guess boolean not null default false,
  add column guessed_character_id uuid references public.characters(id);

comment on column public.questions_log.is_guess is
  'True when this log entry records a player guessing their own identity '
  '(SPEC.md §8 point 6) rather than a normal yes/no question. Guess entries '
  'are always inserted already-resolved (see guess/route.ts) - there is no '
  'separate answering phase for them.';

comment on column public.questions_log.guessed_character_id is
  'Only set when is_guess = true: the character the guesser picked. This '
  'is public information the moment it is submitted (the guesser chose '
  'it), so exposing it here does not weaken the who_am_i_board masking '
  'guarantee for the *actual* assigned character_id.';
