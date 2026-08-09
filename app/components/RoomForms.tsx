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
import { DEFAULT_AVATAR, loadStoredAvatar, saveStoredAvatar, type AvatarSelection } from "@/lib/avatar";
import type { GameSummary } from "@/lib/games-registry";

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
    saveStoredAvatar(avatar);
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
        <CreateRoomForm
          games={games}
          fixedGameId={fixedGameId}
          nickname={avatar.name}
          mushroomIndex={avatar.mushroomIndex}
          accessoryIndex={avatar.accessoryIndex}
        />
        <JoinRoomForm
          nickname={avatar.name}
          mushroomIndex={avatar.mushroomIndex}
          accessoryIndex={avatar.accessoryIndex}
        />
      </div>
    </>
  );
}
