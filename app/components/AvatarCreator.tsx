"use client";

// Platform-core avatar creator. Sits above the Create/Join forms on the
// home page, every per-game landing page, and the in-room "join by link"
// form (SPEC.md §7 pattern) so a visitor picks a name + look exactly once,
// instead of typing a nickname separately into each form. The chosen
// name/color/accessory is persisted to localStorage by the caller (see
// loadStoredAvatar/saveStoredAvatar in lib/avatar.ts) so it carries over
// the next time this visitor creates or joins a room — the look itself is
// still client-side only, `name` is just handed down to
// CreateRoomForm/JoinRoomForm as the nickname.
//
// The color/accessory rows show only the category word ("Color" /
// "Accessory"), not the specific option's name — the swatch/name already
// isn't needed to tell what changed, since the preview above updates live.
// The actual value is still exposed to screen readers via the buttons'
// aria-labels and a visually-hidden suffix on each row.

import { MUSHROOMS, ACCESSORIES, getMushroom, getAccessory } from "@/lib/avatar";
import { AvatarIcon } from "@/app/components/AvatarIcon";

export interface AvatarCreatorProps {
  name: string;
  onNameChange: (name: string) => void;
  mushroomIndex: number;
  onMushroomIndexChange: (index: number) => void;
  accessoryIndex: number;
  onAccessoryIndexChange: (index: number) => void;
}

function cycle(current: number, length: number, delta: number) {
  return (current + delta + length) % length;
}

export function AvatarCreator({
  name,
  onNameChange,
  mushroomIndex,
  onMushroomIndexChange,
  accessoryIndex,
  onAccessoryIndexChange,
}: AvatarCreatorProps) {
  const mushroom = getMushroom(mushroomIndex);
  const accessory = getAccessory(accessoryIndex);

  return (
    <div className="avatar-creator">
      <label className="field">
        <input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          maxLength={32}
          placeholder="e.g. Sam"
          autoComplete="off"
          aria-label="Your name"
        />
      </label>

      <div className="avatar-creator-preview">
        <AvatarIcon mushroomIndex={mushroomIndex} accessoryIndex={accessoryIndex} size={104} />
      </div>

      <div className="avatar-picker">
        <button
          type="button"
          className="avatar-picker-arrow"
          aria-label={`Previous color (currently ${mushroom.label})`}
          onClick={() => onMushroomIndexChange(cycle(mushroomIndex, MUSHROOMS.length, -1))}
        >
          ‹
        </button>
        <span className="avatar-picker-value">
          Color
          <span className="sr-only"> ({mushroom.label})</span>
        </span>
        <button
          type="button"
          className="avatar-picker-arrow"
          aria-label={`Next color (currently ${mushroom.label})`}
          onClick={() => onMushroomIndexChange(cycle(mushroomIndex, MUSHROOMS.length, 1))}
        >
          ›
        </button>
      </div>

      <div className="avatar-picker">
        <button
          type="button"
          className="avatar-picker-arrow"
          aria-label={`Previous accessory (currently ${accessory.label})`}
          onClick={() => onAccessoryIndexChange(cycle(accessoryIndex, ACCESSORIES.length, -1))}
        >
          ‹
        </button>
        <span className="avatar-picker-value">
          Accessory
          <span className="sr-only"> ({accessory.label})</span>
        </span>
        <button
          type="button"
          className="avatar-picker-arrow"
          aria-label={`Next accessory (currently ${accessory.label})`}
          onClick={() => onAccessoryIndexChange(cycle(accessoryIndex, ACCESSORIES.length, 1))}
        >
          ›
        </button>
      </div>
    </div>
  );
}
