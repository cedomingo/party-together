"use client";

// Combines the avatar creator with the Create/Join forms so every page
// that offers "create or join a room" (home page, per-game landing page -
// SPEC.md §7) shares one name/avatar picker instead of each form asking
// for a nickname separately. The chosen name/look is remembered in
// localStorage so it carries over between the home page and a specific
// game's landing page.

import { useEffect, useState } from "react";
import { AvatarCreator } from "@/app/components/AvatarCreator";
import { CreateRoomForm } from "@/app/components/CreateRoomForm";
import { CreateRoomShellForm } from "@/app/components/CreateRoomShellForm";
import { JoinRoomForm } from "@/app/components/JoinRoomForm";
import {
  DEFAULT_AVATAR,
  loadStoredAvatar,
  preloadAvatarAssets,
  saveStoredAvatar,
  type AvatarSelection,
} from "@/lib/avatar";

export function RoomForms({
  fixedGameId,
  shellCreate = false,
}: {
  fixedGameId?: string;
  /** Render the shell-first create form (game-less room, game picked later
   * on /games) instead of the fixed-game create form. The home page passes
   * this; the per-game landing pages create directly for their fixed game. */
  shellCreate?: boolean;
}) {
  const [avatar, setAvatar] = useState<AvatarSelection>(DEFAULT_AVATAR);
  const [hydrated, setHydrated] = useState(false);
  // False until every mushroom/accessory image is preloaded (lib/avatar.ts)
  // - the picker and the Create/Join buttons below both wait on this so a
  // player never sees their avatar pop in late or clicks Next into an
  // avatar that hasn't actually finished loading.
  const [avatarAssetsReady, setAvatarAssetsReady] = useState(false);

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

  useEffect(() => {
    let cancelled = false;
    preloadAvatarAssets().then(() => {
      if (!cancelled) setAvatarAssetsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <AvatarCreator
        name={avatar.name}
        onNameChange={(name) => setAvatar((a) => ({ ...a, name }))}
        mushroomIndex={avatar.mushroomIndex}
        onMushroomIndexChange={(mushroomIndex) => setAvatar((a) => ({ ...a, mushroomIndex }))}
        accessoryIndex={avatar.accessoryIndex}
        onAccessoryIndexChange={(accessoryIndex) => setAvatar((a) => ({ ...a, accessoryIndex }))}
        assetsReady={avatarAssetsReady}
      />

      <div className="two-up">
        {shellCreate ? (
          <CreateRoomShellForm
            nickname={avatar.name}
            mushroomIndex={avatar.mushroomIndex}
            accessoryIndex={avatar.accessoryIndex}
          />
        ) : (
          fixedGameId && (
            <CreateRoomForm
              fixedGameId={fixedGameId}
              nickname={avatar.name}
              mushroomIndex={avatar.mushroomIndex}
              accessoryIndex={avatar.accessoryIndex}
            />
          )
        )}
        <JoinRoomForm
          nickname={avatar.name}
          mushroomIndex={avatar.mushroomIndex}
          accessoryIndex={avatar.accessoryIndex}
        />
      </div>
    </>
  );
}
