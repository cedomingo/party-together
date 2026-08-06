// Pure assignment logic for "Who Am I?" game start (SPEC.md §8 "Setup").
// No React, no I/O, no Supabase import — just: given a set of player ids
// and a set of character ids, produce a random, no-repeat pairing. This is
// exactly what the games/who-am-i/logic/.gitkeep placeholder called for.
//
// The actual database write (via the service-role admin client, since
// who_am_i_assignments has no INSERT grant for authenticated/anon at all —
// see supabase/migrations/..._who_am_i_identity_protection.sql) lives in
// app/api/games/who-am-i/start/route.ts. Keeping this file free of I/O
// means the shuffle/assignment algorithm itself is trivially unit-testable
// in isolation.

export interface CharacterAssignment {
  playerId: string;
  characterId: string;
}

export class AssignmentError extends Error {}

/**
 * Fisher-Yates shuffle. Deliberately not `.sort(() => Math.random() - 0.5)`,
 * which is a well-known biased shuffle (some permutations are more likely
 * than others) — this game's whole premise depends on assignment actually
 * being random.
 */
function shuffled<T>(items: readonly T[]): T[] {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = result[i]!;
    result[i] = result[j]!;
    result[j] = temp;
  }
  return result;
}

/**
 * Randomly assigns each player exactly one character, with no character
 * repeated across players (SPEC.md §8: "no repeats within a room").
 * Duplicate character ids in the input are de-duped first, so a caller
 * doesn't need to guarantee uniqueness itself.
 *
 * Throws AssignmentError if there are no players, or not enough distinct
 * characters to give each player a unique one.
 */
export function assignCharacters(
  playerIds: readonly string[],
  characterIds: readonly string[]
): CharacterAssignment[] {
  if (playerIds.length === 0) {
    throw new AssignmentError("No players to assign characters to.");
  }

  const uniqueCharacterIds = Array.from(new Set(characterIds));
  if (uniqueCharacterIds.length < playerIds.length) {
    throw new AssignmentError(
      `Not enough active characters (${uniqueCharacterIds.length}) for ${playerIds.length} players.`
    );
  }

  const shuffledPlayers = shuffled(playerIds);
  const shuffledCharacters = shuffled(uniqueCharacterIds);

  return shuffledPlayers.map((playerId, i) => ({
    playerId,
    characterId: shuffledCharacters[i]!,
  }));
}
