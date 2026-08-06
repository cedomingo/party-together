-- ---------------------------------------------------------------------------
-- Phase 1: game tables (SPEC.md §5)
-- ---------------------------------------------------------------------------

create table public.game_sessions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  game_id text not null,
  state jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  ended_at timestamptz
);

create index game_sessions_room_id_idx on public.game_sessions (room_id);

-- Fixed global 25-character roster, shared across all rooms/games that use it.
create table public.characters (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  image_url text not null,
  active boolean not null default true
);

-- Game-specific table for "Who Am I?". This is the one with the critical
-- secrecy rule: a player must never be able to read their own character_id.
create table public.who_am_i_assignments (
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  character_id uuid not null references public.characters(id),
  -- Per-player, local elimination board. Not shared with other players.
  crossed_off_character_ids uuid[] not null default '{}',
  -- The player's current active guess at their own identity. Comparing it
  -- to character_id server-side (via the generated column below) lets a
  -- player learn "was I right?" without the row ever exposing character_id
  -- to them directly.
  guessed_character_id uuid references public.characters(id),
  is_guessed boolean generated always as (
    guessed_character_id is not null and guessed_character_id = character_id
  ) stored,
  primary key (session_id, player_id)
);

create index who_am_i_assignments_player_id_idx on public.who_am_i_assignments (player_id);

create table public.questions_log (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  asking_player_id uuid not null references public.players(id) on delete cascade,
  question_text text not null check (char_length(btrim(question_text)) between 1 and 280),
  created_at timestamptz not null default now(),
  -- { "<player_id>": "yes" | "no", ... }
  answers jsonb not null default '{}'::jsonb,
  resolved boolean not null default false
);

create index questions_log_session_id_idx on public.questions_log (session_id);
