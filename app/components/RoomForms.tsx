"use client";

// Combines the avatar creator with the Create/Join forms so every page
// that offers "create or join a room" (home page, per-game landing page —
// SPEC.md §7) shares one name/avatar picker instead of each form asking
// for a nickname separately. The chosen name/look is remembered in
// localStorage so it carries over between the home page and a specific
// game's landing page.

import { useEffect, useState } from "react";
import { AvatarCreator } from "@/app/components/AvatarCreator";
import { CreateRoomForm } from "@/app/components/CreateRoomForm";
import { JoinRoomForm } from "@/app/components/JoinRoomForm";
import { DEFAULT_AVATAR, MUSHROOMS, ACCESSORIES, type AvatarSelection } from "@/lib/avatar";
import type { GameSummary } from "@/lib/games-registry";

const STORAGE_KEY = "party-together:avatar";

function loadStoredAvatar(): AvatarSelection {
  if (typeof window === "undefined") return DEFAULT_AVATAR;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_AVATAR;
    const parsed = JSON.parse(raw) as Partial<AvatarSelection>;
    return {
      name: typeof parsed.name === "string" ? parsed.name : DEFAULT_AVATAR.name,
      mushroomIndex:
        typeof parsed.mushroomIndex === "number" && parsed.mushroomIndex >= 0 && parsed.mushroomIndex < MUSHROOMS.length
          ? parsed.mushroomIndex
          : DEFAULT_AVATAR.mushroomIndex,
      accessoryIndex:
        typeof parsed.accessoryIndex === "number" &&
        parsed.accessoryIndex >= 0 &&
        parsed.accessoryIndex < ACCESSORIES.length
          ? parsed.accessoryIndex
          : DEFAULT_AVATAR.accessoryIndex,
    };
  } catch {
    return DEFAULT_AVATAR;
  }
}

export function RoomForms({ games, fixedGameId }: { games: GameSummary[]; fixedGameId?: string }) {
  const [avatar, setAvatar] = useState<AvatarSelection>(DEFAULT_AVATAR);
  const [hydrated, setHydrated] = useState(false);

  // Read localStorage after mount only, so SSR markup and the first client
  // render match (avoids a hydration mismatch warning).
  useEffect(() => {
    setAvatar(loadStoredAvatar());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(avatar));
    } catch {
      // Storage can be unavailable (private browsing, quota) — the picker
      // still works for this visit, it just won't be remembered.
    }
  }, [avatar, hydrated]);

  return (
    <>
      <AvatarCreator
        name={avatar.name}
        onNameChange={(name) => setAvatar((a) => ({ ...a, name }))}
        mushroomIndex={avatar.mushroomIndex}
        onMushroomIndexChange={(mushroomIndex) => setAvatar((a) => ({ ...a, mushroomIndex }))}
        accessoryIndex={avatar.accessoryIndex}
        onAccessoryIndexChange={(accessoryIndex) => setAvatar((a) => ({ ...a, accessoryIndex }))}
      />

      <div className="two-up">
        <CreateRoomForm games={games} fixedGameId={fixedGameId} nickname={avatar.name} />
        <JoinRoomForm nickname={avatar.name} />
      </div>
    </>
  );
}
