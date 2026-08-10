-- ---------------------------------------------------------------------------
-- Real 1:1 question targeting for "Who Am I?" (replaces the broadcast
-- model: previously the active player asked ONE public question and every
-- other player answered it in sequence; now the active player asks a
-- DIFFERENT question to EACH other player, one at a time, and only that
-- player answers it). SPEC.md §8 "Turn Loop" is being reinterpreted here —
-- see games/who-am-i/logic/turnState.ts for the state-machine side of this
-- change.
--
-- `answers jsonb` is kept as-is rather than replaced with a single scalar
-- column: every reader (RoomView.tsx, Recap.tsx) already treats it as "a
-- map of player_id -> answer" and just happens to iterate it, so leaving
-- the shape alone and simply guaranteeing exactly one entry (the target's)
-- avoids touching every call site for no functional gain. What's new is
-- *who* is allowed to be that one entry: `target_player_id` names them
-- up front, at question-submission time, instead of the target only being
-- implied by whoever happens to answer first.
-- ---------------------------------------------------------------------------

alter table public.questions_log
  add column target_player_id uuid references public.players(id) on delete cascade;

comment on column public.questions_log.target_player_id is
  'The single player this question is directed at (real 1:1 targeting, not '
  'broadcast to the room). Null only for is_guess = true rows, which have '
  'no target — see the check constraint below. Every non-guess row must '
  'have exactly one target, and `answers` is expected to end up with at '
  'most that one player''s entry.';

-- Every normal (non-guess) question must have a target, and it can never
-- be the asker themselves.
alter table public.questions_log
  add constraint questions_log_target_required_unless_guess
  check (is_guess = true or target_player_id is not null);

alter table public.questions_log
  add constraint questions_log_target_not_self
  check (target_player_id is null or target_player_id <> asking_player_id);

-- Answering a specific person's question is looked up by target constantly
-- (answer/route.ts re-derives "is this really addressed to me?"), so this
-- earns an index same as asking_player_id would.
create index questions_log_target_player_id_idx on public.questions_log (target_player_id);

-- Tightens `questions_log_insert_asker_only` (supabase/migrations/
-- 20260806120400_rls_core.sql) the same amount that policy already tightens
-- around asking_player_id: a room member can't name a target who isn't
-- actually in the same room. This still doesn't verify turn *order* (same
-- documented gap as the original policy — that stays an application-layer
-- check in question/route.ts), just room membership of the target.
drop policy questions_log_insert_asker_only on public.questions_log;

create policy questions_log_insert_asker_only
  on public.questions_log for insert
  to authenticated
  with check (
    exists (
      select 1 from public.game_sessions gs
      where gs.id = session_id
        and asking_player_id = public.current_player_id_in_room(gs.room_id)
        and (
          is_guess = true
          or exists (
            select 1 from public.players p
            where p.id = target_player_id and p.room_id = gs.room_id
          )
        )
    )
  );
