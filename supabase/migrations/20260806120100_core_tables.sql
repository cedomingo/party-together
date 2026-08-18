-- ---------------------------------------------------------------------------
-- Phase 1: core platform tables - rooms, players (SPEC.md §5)
-- ---------------------------------------------------------------------------
-- Identity model: there is no traditional login. Every browser session signs
-- in via Supabase Anonymous Auth (auth.users row, real auth.uid()). The
-- app-level "player id" is a separate row in `players`, one per (room, auth
-- session), so a single anonymous session can join multiple rooms without
-- collisions. This is what lets RLS enforce "own room only" / "own row
-- only" using auth.uid() instead of trusting a client-supplied id.

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  -- Nullable + FK added below: the host's player row can't exist until
  -- after the room row does (see bootstrap sequence in the Phase 1 doc).
  host_player_id uuid,
  game_id text not null,
  status text not null default 'lobby'
    check (status in ('lobby', 'in_progress', 'finished')),
  max_players int check (max_players is null or max_players > 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create table public.players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  -- The anonymous auth session this player row belongs to. Defaulting to
  -- auth.uid() means the client never has to (and never gets to) claim an
  -- identity for someone else on insert.
  auth_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nickname text not null check (char_length(btrim(nickname)) between 1 and 32),
  is_host boolean not null default false,
  connected boolean not null default true,
  joined_at timestamptz not null default now(),
  -- One player row per auth session per room - re-joining the same room
  -- from the same session should upsert onto this row, not duplicate it.
  unique (room_id, auth_id)
);

alter table public.rooms
  add constraint rooms_host_player_id_fkey
  foreign key (host_player_id) references public.players(id) on delete set null;

-- Belt-and-suspenders on top of app logic: at most one host per room,
-- enforced at the database level regardless of what RLS allows.
create unique index one_host_per_room on public.players (room_id) where is_host;

create index players_room_id_idx on public.players (room_id);
create index rooms_code_idx on public.rooms (code);
