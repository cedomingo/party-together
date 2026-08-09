"use client";

// Platform-core avatar creator. Sits above the Create/Join forms on the
// home page and every per-game landing page (SPEC.md §7 pattern) so a
// visitor picks a name + look exactly once, instead of typing a nickname
// separately into each form. Purely presentational/client-side for now —
// nothing here is persisted server-side yet, `name` is just handed down to
// CreateRoomForm/JoinRoomForm as the nickname.

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
        <span>Your name</span>
        <input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          maxLength={32}
          placeholder="e.g. Sam"
          autoComplete="off"
        />
      </label>

      <div className="avatar-creator-preview">
        <AvatarIcon mushroomIndex={mushroomIndex} accessoryIndex={accessoryIndex} size={104} />
      </div>

      <div className="avatar-picker">
        <span className="avatar-picker-label">Color</span>
        <div className="avatar-picker-control">
          <button
            type="button"
            className="avatar-picker-arrow"
            aria-label="Previous color"
            onClick={() => onMushroomIndexChange(cycle(mushroomIndex, MUSHROOMS.length, -1))}
          >
            ‹
          </button>
          <span className="avatar-picker-value">
            <span className="avatar-swatch" style={{ background: mushroom.swatch }} aria-hidden="true" />
            {mushroom.label}
          </span>
          <button
            type="button"
            className="avatar-picker-arrow"
            aria-label="Next color"
            onClick={() => onMushroomIndexChange(cycle(mushroomIndex, MUSHROOMS.length, 1))}
          >
            ›
          </button>
        </div>
      </div>

      <div className="avatar-picker">
        <span className="avatar-picker-label">Accessory</span>
        <div className="avatar-picker-control">
          <button
            type="button"
            className="avatar-picker-arrow"
            aria-label="Previous accessory"
            onClick={() => onAccessoryIndexChange(cycle(accessoryIndex, ACCESSORIES.length, -1))}
          >
            ‹
          </button>
          <span className="avatar-picker-value">{accessory.label}</span>
          <button
            type="button"
            className="avatar-picker-arrow"
            aria-label="Next accessory"
            onClick={() => onAccessoryIndexChange(cycle(accessoryIndex, ACCESSORIES.length, 1))}
          >
            ›
          </button>
        </div>
      </div>
    </div>
  );
}
