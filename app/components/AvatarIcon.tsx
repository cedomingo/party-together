// Small composited avatar preview: base mushroom + optional accessory,
// layered inside a circle. Both art layers share the same 2025x2025 canvas
// (see lib/avatar.ts) so no per-item offset math is needed — they're just
// stacked. The gentle "wiggle" is two independently-timed jitters (one per
// layer) so it reads as hand-animated paper rather than a single uniform
// bounce (art direction: cozy, hand-drawn, never static-y).

import { getMushroom, getAccessory } from "@/lib/avatar";

export function AvatarIcon({
  mushroomIndex,
  accessoryIndex,
  size = 88,
  wiggle = true,
  className,
}: {
  mushroomIndex: number;
  accessoryIndex: number;
  size?: number;
  wiggle?: boolean;
  className?: string;
}) {
  const mushroom = getMushroom(mushroomIndex);
  const accessory = getAccessory(accessoryIndex);

  return (
    <div
      className={`avatar-icon${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={mushroom.src}
        alt=""
        className={wiggle ? "avatar-icon-layer avatar-wiggle-a" : "avatar-icon-layer"}
      />
      {accessory.src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={accessory.src}
          alt=""
          className={wiggle ? "avatar-icon-layer avatar-wiggle-b" : "avatar-icon-layer"}
        />
      )}
    </div>
  );
}
