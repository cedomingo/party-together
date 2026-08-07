// ---------------------------------------------------------------------------
// Platform core: room + lobby logic.
// ---------------------------------------------------------------------------
// This module must stay 100% game-agnostic. Nothing in here should ever
// import from /games/**. Game modules depend on this layer, never the
// reverse.
//
// All functions take a Supabase client as their first argument (or inside
// their params object) rather than constructing one internally — this lets
// the same logic run from the browser client (Client Components), the
// server client (Server Actions/Route Handlers), or the admin client (cron
// cleanup), while staying agnostic about *how* that client authenticates.
// Row Level Security (see supabase/migrations/) is what actually enforces
// who can do what; this module just shapes the calls.

import type { SupabaseClient } from "@supabase/supabase-js";

// ------------------------------------------------------------------ types --

export type RoomStatus = "lobby" | "in_progress" | "finished";

export interface Room {
  id: string;
  code: string;
  host_player_id: string | null;
  game_id: string;
  status: RoomStatus;
  max_players: number | null;
  created_at: string;
  expires_at: string | null;
}

export interface Player {
  id: string;
  room_id: string;
  auth_id: string;
  nickname: string;
  is_host: boolean;
  connected: boolean;
  joined_at: string;
}

// ----------------------------------------------------------------- errors --

export class RoomError extends Error {}
export class RoomNotFoundError extends RoomError {}
export class RoomAlreadyStartedError extends RoomError {}
export class RoomFullError extends RoomError {}
export class InvalidNicknameError extends RoomError {}
export class AuthSessionError extends RoomError {}

// ------------------------------------------------------------- constants --

// Excludes 0/O/1/I to avoid ambiguous codes when read aloud or handwritten.
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 4;
const MAX_CODE_GENERATION_ATTEMPTS = 8;

export const NICKNAME_MAX_LENGTH = 32;

// How long an inactive room stays alive before the cleanup cron reaps it.
// Refreshed (see `touchRoomExpiry`) whenever the room sees activity, so an
// actively-played room never expires mid-game.
export const ROOM_EXPIRY_HOURS = 24;

// ------------------------------------------------------------------ utils --

export function generateRoomCode(length: number = ROOM_CODE_LENGTH): string {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

export function normalizeRoomCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Strips characters no legitimate nickname/question needs and that are
 * classic abuse vectors: angle brackets (keeps raw `<script>`-shaped
 * strings out of stored data — defense in depth, since these are only
 * ever rendered as React text content, which already escapes everything),
 * C0/C1 control characters (NUL and friends), and zero-width/bidi-override
 * characters (used to spoof or obscure displayed text). Shared by
 * `sanitizeNickname` here and `sanitizeQuestionText` in
 * app/api/games/who-am-i/question/route.ts (SPEC.md §10).
 */
export function stripUnsafeChars(raw: string): string {
  return raw
    .replace(/[<>]/g, "")
    // eslint-disable-next-line no-control-regex -- intentionally matching control/zero-width chars to strip them
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\uFEFF]/g, "");
}

/**
 * Trims, collapses whitespace, strips unsafe characters (see
 * `stripUnsafeChars`), and enforces the length window the DB also enforces
 * (SPEC.md §10: "basic input sanitization/length limits on nicknames ...
 * to prevent XSS and abuse"). The DB check constraint is the real
 * backstop; this just fails fast with a friendlier error and a consistent
 * shape before it ever reaches Postgres.
 */
export function sanitizeNickname(raw: string): string {
  const stripped = stripUnsafeChars(raw)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NICKNAME_MAX_LENGTH);

  if (stripped.length < 1) {
    throw new InvalidNicknameError("Nickname must be between 1 and 32 characters.");
  }
  return stripped;
}

function expiryTimestamp(hours: number = ROOM_EXPIRY_HOURS): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

// -------------------------------------------------------------- identity --

/**
 * Every player is a real Supabase Anonymous Auth session (SPEC.md §2) — no
 * email/password/OAuth, but a real `auth.uid()` so RLS can tell one
 * browser's session apart from another's. Idempotent: if a session already
 * exists, reuses it rather than minting a new anonymous user.
 */
export async function ensureAnonSession(supabase: SupabaseClient): Promise<string> {
  const { data: userData } = await supabase.auth.getUser();
  if (userData.user) return userData.user.id;

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error || !data.user) {
    throw new AuthSessionError(error?.message ?? "Failed to start an anonymous session.");
  }
  return data.user.id;
}

export async function getCurrentUserId(supabase: SupabaseClient): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

// ---------------------------------------------------------------- reads ---

export async function getRoomByCode(supabase: SupabaseClient, code: string): Promise<Room | null> {
  const { data, error } = await supabase
    .from("rooms")
    .select("*")
    .eq("code", normalizeRoomCode(code))
    .maybeSingle();

  if (error) throw new RoomError(error.message);
  return (data as Room | null) ?? null;
}

export async function getRoom(supabase: SupabaseClient, roomId: string): Promise<Room | null> {
  const { data, error } = await supabase.from("rooms").select("*").eq("id", roomId).maybeSingle();
  if (error) throw new RoomError(error.message);
  return (data as Room | null) ?? null;
}

export async function listPlayers(supabase: SupabaseClient, roomId: string): Promise<Player[]> {
  const { data, error } = await supabase
    .from("players")
    .select("*")
    .eq("room_id", roomId)
    .order("joined_at", { ascending: true });

  if (error) throw new RoomError(error.message);
  return (data as Player[]) ?? [];
}

// -------------------------------------------------------------- mutations --

export interface CreateRoomParams {
  supabase: SupabaseClient;
  gameId: string;
  nickname: string;
  maxPlayers?: number | null;
}

export interface CreateRoomResult {
  roomId: string;
  code: string;
  playerId: string;
}

/**
 * Bootstrap sequence (see supabase/PHASE1_NOTES.md — "chicken-and-egg with
 * host_player_id"): a room can't be created with its host already set,
 * because the host's player row doesn't exist until the room does.
 *   1. insert the room with host_player_id = null
 *   2. insert the host's own player row (is_host = true)
 *   3. update the room to point host_player_id at that new row
 * Each step is individually allowed by RLS; skipping the order breaks it.
 */
export async function createRoom({
  supabase,
  gameId,
  nickname,
  maxPlayers = null,
}: CreateRoomParams): Promise<CreateRoomResult> {
  await ensureAnonSession(supabase);

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (!user) {
    throw new AuthSessionError(userError?.message ?? "No authenticated user.");
  }

  console.log("[DEBUG createRoom]", {
    userId: user?.id,
    error: userError?.message,
  });

  const cleanNickname = sanitizeNickname(nickname);

  let room: Room | null = null;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_CODE_GENERATION_ATTEMPTS; attempt++) {
    const code = generateRoomCode();
    const { data, error } = await supabase
      .from("rooms")
      .insert({
        code,
        game_id: gameId,
        max_players: maxPlayers,
        expires_at: expiryTimestamp(),
      })
      .select()
      .single();

    if (!error && data) {
      room = data as Room;
      break;
    }
    lastError = error;
    // 23505 = unique_violation — only worth retrying a code collision.
    if ((error as { code?: string } | null)?.code !== "23505") {
      throw new RoomError(error?.message ?? "Failed to create room.");
    }
  }

  if (!room) {
    throw new RoomError(
      `Could not generate a unique room code after ${MAX_CODE_GENERATION_ATTEMPTS} attempts.`,
      { cause: lastError }
    );
  }

  // TEMPORARY DIAGNOSTIC — remove once auth.uid() is confirmed working.
  const { data: authDebug, error: authDebugError } = await supabase.rpc("debug_auth");
  console.log("[DEBUG createRoom] auth.uid() as seen by Postgres:", authDebug, authDebugError);

  // TEMPORARY DIAGNOSTIC — remove once the players-insert RLS policy is
  // confirmed working. `full_with_check` is the answer: if it comes back
  // `true` but the insert below still fails, the bug isn't in this
  // policy's logic at all (something stranger — worth capturing the raw
  // Postgres error `code`, not just the message, at that point). If it
  // comes back `false`, whichever of `auth_id_matches` / `status_is_lobby`
  // / `under_cap` is false tells us exactly where.
  const { data: checkDebug, error: checkDebugError } = await supabase.rpc("debug_insert_check", {
    target_room_id: room.id,
    candidate_auth_id: user.id,
  });
  console.log("[DEBUG createRoom] insert-check breakdown:", checkDebug, checkDebugError);

  const { data: playerRow, error: playerError } = await supabase
    .from("players")
    .insert({
      room_id: room.id,
      auth_id: user.id,
      nickname: cleanNickname,
      is_host: true,
    })
    .select()
    .single();

  console.log("[DEBUG createRoom] player insert result", {
    success: !!playerRow,
    code: playerError?.code,
    message: playerError?.message,
    details: playerError?.details,
    hint: playerError?.hint,
  });

  if (playerError || !playerRow) {
    throw new RoomError(playerError?.message ?? "Failed to create the host's player row.");
  }

  // Step 3 of the bootstrap sequence documented above — point the room at
  // its host now that the host's player row exists. Covered by
  // rooms_update_host_only (RLS): is_room_host(id) is satisfied because
  // the row we just inserted has is_host = true and auth_id = auth.uid().
  const { error: hostLinkError } = await supabase
    .from("rooms")
    .update({ host_player_id: playerRow.id })
    .eq("id", room.id);

  if (hostLinkError) throw new RoomError(hostLinkError.message);

  return {
    roomId: room.id,
    code: room.code,
    playerId: playerRow.id,
  };
}

export interface JoinRoomResult {
  roomId: string;
  code: string;
  gameId: string;
  playerId: string;
  /** true if this session already had a player row (refresh / reconnect). */
  reconnected: boolean;
}

/**
 * Joins by code, or reconnects if this anonymous session already has a
 * player row in the room (survives page refresh — see SPEC.md §7 & §11).
 * New joins are only possible while the room is still `lobby`; RLS enforces
 * this independently (`players_insert_self_join_lobby`), so the status
 * check here is purely for a friendlier error message.
 */
export async function joinRoomByCode(
  supabase: SupabaseClient,
  code: string,
  nickname: string
): Promise<JoinRoomResult> {
  await ensureAnonSession(supabase);

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new AuthSessionError("No authenticated user.");
  }

  const cleanNickname = sanitizeNickname(nickname);

  const room = await getRoomByCode(supabase, code);
  if (!room) {
    throw new RoomNotFoundError(`No room found for code "${normalizeRoomCode(code)}".`);
  }

  const { data: existing, error: existingError } = await supabase
    .from("players")
    .select("*")
    .eq("room_id", room.id)
    .eq("auth_id", user.id)
    .maybeSingle();

  if (existingError) throw new RoomError(existingError.message);

  if (existing) {
    const { error: reconnectError } = await supabase
      .from("players")
      .update({ connected: true })
      .eq("id", existing.id);
    if (reconnectError) throw new RoomError(reconnectError.message);

    return {
      roomId: room.id,
      code: room.code,
      gameId: room.game_id,
      playerId: existing.id,
      reconnected: true,
    };
  }

  if (room.status !== "lobby") {
    throw new RoomAlreadyStartedError(
      "This room has already started — new players can't join mid-game."
    );
  }

  // Room-full check (SPEC.md §7: "host can optionally set [a max player
  // cap]"; §11: "clean ... error states for ... room-full"). Only applies
  // to *new* joins — an existing player reconnecting (handled above,
  // before this point) always gets their slot back even if the room later
  // filled up around them. This is a friendly-error backstop, not the
  // actual access boundary: `players_insert_self_join_lobby` (see
  // supabase/migrations/20260806121000_room_full_guard.sql) enforces the
  // same cap at the RLS level, so a direct/racing insert can't slip past
  // it even if this check is skipped or stale.
  if (room.max_players != null) {
    const { count, error: countError } = await supabase
      .from("players")
      .select("id", { count: "exact", head: true })
      .eq("room_id", room.id);
    if (countError) throw new RoomError(countError.message);
    if ((count ?? 0) >= room.max_players) {
      throw new RoomFullError(
        `This room is full (max ${room.max_players} player${room.max_players === 1 ? "" : "s"}).`
      );
    }
  }

  const { data: playerRow, error: insertError } = await supabase
    .from("players")
    .insert({ room_id: room.id, auth_id: user.id, nickname: cleanNickname, is_host: false })
    .select()
    .single();

  console.log("[DEBUG joinRoomByCode] player insert failed", {
    code: insertError?.code,
    message: insertError?.message,
    details: insertError?.details,
    hint: insertError?.hint,
    roomId: room.id,
    userId: user.id,
  });

  if (insertError || !playerRow) {
    // The RLS guard above can also reject this insert directly (a race
    // between the count check and another player's concurrent join) —
    // Postgres reports that as a generic RLS policy violation (42501), not
    // a distinguishable error shape, so it surfaces as a room-full message
    // too rather than a confusing raw DB error.
    if ((insertError as { code?: string } | null)?.code === "42501") {
      throw new RoomFullError(
        room.max_players != null
          ? `This room is full (max ${room.max_players} player${room.max_players === 1 ? "" : "s"}).`
          : "This room is no longer accepting new players."
      );
    }
    throw new RoomError(insertError?.message ?? "Failed to join room.");
  }

  // Best-effort activity refresh — a room that's actively gaining players
  // shouldn't expire mid-lobby. Not fatal if it fails.
  await touchRoomExpiry(supabase, room.id).catch(() => undefined);

  return {
    roomId: room.id,
    code: room.code,
    gameId: room.game_id,
    playerId: playerRow.id,
    reconnected: false,
  };
}

export async function touchRoomExpiry(supabase: SupabaseClient, roomId: string): Promise<void> {
  const { error } = await supabase
    .from("rooms")
    .update({ expires_at: expiryTimestamp() })
    .eq("id", roomId);
  if (error) throw new RoomError(error.message);
}

export async function setPlayerConnected(
  supabase: SupabaseClient,
  playerId: string,
  connected: boolean
): Promise<void> {
  const { error } = await supabase.from("players").update({ connected }).eq("id", playerId);
  if (error) throw new RoomError(error.message);
}

/**
 * Host-only (enforced by the `rooms_update_host_only` RLS policy — a
 * non-host caller's update simply matches zero rows). Deliberately just
 * flips `status`; SPEC.md Phase 2 wants this as a no-op-ish stub with zero
 * game logic. Once flipped, `players_insert_self_join_lobby` automatically
 * blocks new joins (it requires status = 'lobby'), which is what "host can
 * lock the room once the game starts" (§7) reduces to — no separate lock
 * flag needed.
 */
export async function startGame(supabase: SupabaseClient, roomId: string): Promise<void> {
  const { error } = await supabase
    .from("rooms")
    .update({ status: "in_progress" })
    .eq("id", roomId)
    .eq("status", "lobby");
  if (error) throw new RoomError(error.message);
}

/** Cron-only (SPEC.md §7). Expects the service-role admin client — there is
 * no delete policy for `rooms` under normal RLS on purpose (see
 * supabase/migrations/20260806120400_rls_core.sql).
 */
export async function cleanupExpiredRooms(
  supabaseAdmin: SupabaseClient
): Promise<{ deletedCount: number; codes: string[] }> {
  const { data, error } = await supabaseAdmin
    .from("rooms")
    .delete()
    .lt("expires_at", new Date().toISOString())
    .select("code");

  if (error) throw new RoomError(error.message);
  const codes = ((data ?? []) as { code: string }[]).map((r) => r.code);
  return { deletedCount: codes.length, codes };
}