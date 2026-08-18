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
import { MUSHROOMS, ACCESSORIES } from "@/lib/avatar";

// ------------------------------------------------------------------ types --

export type RoomStatus = "lobby" | "in_progress" | "finished";

export interface Room {
  id: string;
  code: string;
  host_player_id: string | null;
  /** Null until the host picks a game on /games — rooms are created as a
   * game-less shell (code + max players) and the game is assigned
   * afterwards via the switch-game route (setRoomGame). Game-less rooms
   * are joinable like any other (the joiner is redirected to
   * /games?room=CODE — there's no room URL yet); the game start routes
   * refuse a mismatched/null game_id. */
  game_id: string | null;
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
  mushroom_index: number;
  accessory_index: number;
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

// How long a player may go without a heartbeat (`last_seen_at`) before the
// stale-player sweep treats their seat as abandoned and removes it
// (sweepStalePlayers). Deliberately ~3x PLAYER_HEARTBEAT_MS: browsers
// throttle background-tab timers to roughly once a minute, so a player who
// merely switched tabs still lands comfortably inside this window — only a
// page that has truly stopped running (closed tab, dead network) drifts
// past it.
export const OFFLINE_GRACE_MS = 90_000;

// Room pages (RoomClient, GamesListing) refresh their own player row's
// `last_seen_at` on this interval so the sweep above can tell a live
// player from an abandoned seat.
export const PLAYER_HEARTBEAT_MS = 30_000;

// How often room pages re-run the lobby sweep (see the /api/rooms/sweep
// route) so the roster / player-count gates reflect who's actually here
// without waiting for a reload or the authoritative sweep inside the
// game-start routes.
export const LOBBY_SWEEP_INTERVAL_MS = 60_000;

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

/**
 * Falls back to 0 for anything not a valid in-range index (including
 * "in range for an older/shorter build of lib/avatar.ts") rather than
 * throwing — an out-of-range avatar index isn't a reason to fail the
 * whole create/join, unlike an empty nickname. `getMushroom`/`getAccessory`
 * apply the same 0-fallback on read, so this just means an odd value never
 * makes it into storage in the first place.
 */
function clampAvatarIndex(value: unknown, length: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const truncated = Math.trunc(value);
  return truncated >= 0 && truncated < length ? truncated : 0;
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
  /** Optional since the home page creates a game-less shell and the host
   * picks the game afterwards (switch-game route). Per-game landing pages
   * still pass it up front. */
  gameId?: string | null;
  nickname: string;
  maxPlayers?: number | null;
  mushroomIndex?: number;
  accessoryIndex?: number;
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
  mushroomIndex,
  accessoryIndex,
}: CreateRoomParams): Promise<CreateRoomResult> {
  // ensureAnonSession already resolves (or mints) the anonymous session and
  // returns its user id — a second getUser() here was a redundant network
  // round trip on every create, which is exactly the kind of latency that
  // makes the create click feel unresponsive.
  const userId = await ensureAnonSession(supabase);

  const cleanNickname = sanitizeNickname(nickname);

  let room: Room | null = null;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_CODE_GENERATION_ATTEMPTS; attempt++) {
    const code = generateRoomCode();
    const { data, error } = await supabase
      .from("rooms")
      .insert({
        code,
        // May be null: the home page creates a game-less shell and the
        // host picks the game afterwards (switch-game route).
        game_id: gameId ?? null,
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

  const { data: playerRow, error: playerError } = await supabase
    .from("players")
    .insert({
      room_id: room.id,
      auth_id: userId,
      nickname: cleanNickname,
      is_host: true,
      mushroom_index: clampAvatarIndex(mushroomIndex, MUSHROOMS.length),
      accessory_index: clampAvatarIndex(accessoryIndex, ACCESSORIES.length),
    })
    .select()
    .single();

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
  /** null until the host picks a game (game-less shell room) — callers
   * that redirect by this must send the joiner to /games?room=CODE instead
   * of building a room URL when it's null. */
  gameId: string | null;
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
  nickname: string,
  mushroomIndex?: number,
  accessoryIndex?: number
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

  // A game-less room joins exactly like a game-assigned one — all the
  // checks below (reconnect, lobby status, room-full cap) are game-agnostic.
  // The joiner just gets redirected to /games?room=CODE by their caller
  // (JoinRoomResult.gameId is null) until the host picks a game.

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
      .update({
        connected: true,
        mushroom_index: clampAvatarIndex(mushroomIndex, MUSHROOMS.length),
        accessory_index: clampAvatarIndex(accessoryIndex, ACCESSORIES.length),
      })
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
    .insert({
      room_id: room.id,
      auth_id: user.id,
      nickname: cleanNickname,
      is_host: false,
      mushroom_index: clampAvatarIndex(mushroomIndex, MUSHROOMS.length),
      accessory_index: clampAvatarIndex(accessoryIndex, ACCESSORIES.length),
    })
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

/**
 * Host-only assignment of which game a room will play (enforced by the
 * `rooms_update_host_only` RLS policy — a non-host update simply matches
 * zero rows). Used by the switch-game route when the host picks a game on
 * /games?room=CODE: the room may have been created as a game-less shell
 * (see `createRoom`) or be flipping from a finished game. Throws a
 * RoomError on failure so callers can surface it.
 */
export async function setRoomGame(
  supabase: SupabaseClient,
  roomId: string,
  gameId: string
): Promise<void> {
  const { error } = await supabase.from("rooms").update({ game_id: gameId }).eq("id", roomId);
  if (error) throw new RoomError(error.message);
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
 * Marks this session's player row as alive — the heartbeat that keeps
 * `last_seen_at` fresh so the stale-player sweep never mistakes an
 * actively-open room page for an abandoned seat. Callers treat failures as
 * best-effort (a missed ping just makes the sweep see an older timestamp).
 * RLS (`players_update_self`) restricts the write to the caller's own row.
 */
export async function touchPlayerSeen(supabase: SupabaseClient, playerId: string): Promise<void> {
  const { error } = await supabase
    .from("players")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", playerId);
  if (error) throw new RoomError(error.message);
}

/**
 * Removes players whose `last_seen_at` is older than `graceMs` — seats that
 * have been offline long enough to be considered abandoned — so the lobby
 * roster, the max_players cap, and the game start all reflect only the
 * people actually here. The host is never swept (is_host rows are
 * excluded); callers only run this for `lobby` rooms (the sweep route and
 * the game-start routes both check status first). Requires the admin
 * client: RLS deliberately only lets a player delete their own row
 * (`players_delete_self`). Returns the ids of the removed players.
 *
 * If the players.last_seen_at migration hasn't been applied yet, the delete
 * fails with Postgres code 42703 (undefined column) — carried on the thrown
 * RoomError as `.code` so callers can fall back to the old behavior rather
 * than breaking game start.
 */
export async function sweepStalePlayers(
  supabaseAdmin: SupabaseClient,
  roomId: string,
  graceMs: number = OFFLINE_GRACE_MS
): Promise<string[]> {
  const cutoff = new Date(Date.now() - graceMs).toISOString();
  const { data, error } = await supabaseAdmin
    .from("players")
    .delete()
    .eq("room_id", roomId)
    .eq("is_host", false)
    .lt("last_seen_at", cutoff)
    .select("id");

  if (error) {
    const wrapped = new RoomError(error.message) as RoomError & { code?: string };
    wrapped.code = error.code;
    throw wrapped;
  }

  return ((data ?? []) as { id: string }[]).map((p) => p.id);
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