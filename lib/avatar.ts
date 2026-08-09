// Shared avatar-creator data (SPEC.md-adjacent, but purely presentational —
// no backend persistence yet). Mushrooms are the base body/color; accessories
// are optional transparent overlays. Both live under /public/ui/avatar and
// share the same 2025x2025 canvas, so an accessory always lines up with the
// mushroom underneath it without any per-item offset math.

export interface MushroomOption {
  id: string;
  label: string;
  src: string;
  /** Small swatch color used for the color-picker dot — approximate, just for the UI chrome. */
  swatch: string;
}

export interface AccessoryOption {
  id: string | null;
  label: string;
  src: string | null;
}

export const MUSHROOMS: MushroomOption[] = [
  { id: "M1", label: "Cherry", src: "/ui/avatar/mushrooms/M1.png", swatch: "#c0463c" },
  { id: "M2", label: "Amber", src: "/ui/avatar/mushrooms/M2.png", swatch: "#e08a2c" },
  { id: "M3", label: "Gold", src: "/ui/avatar/mushrooms/M3.png", swatch: "#e8b93a" },
  { id: "M4", label: "Fern", src: "/ui/avatar/mushrooms/M4.png", swatch: "#6f8a3e" },
  { id: "M5", label: "Blueberry", src: "/ui/avatar/mushrooms/M5.png", swatch: "#2f4f7a" },
  { id: "M6", label: "Grape", src: "/ui/avatar/mushrooms/M6.png", swatch: "#8a5bb0" },
  { id: "M7", label: "Charcoal", src: "/ui/avatar/mushrooms/M7.png", swatch: "#2c2a28" },
  { id: "M8", label: "Cloud", src: "/ui/avatar/mushrooms/M8.png", swatch: "#c9c9c2" },
];

export const ACCESSORIES: AccessoryOption[] = [
  { id: null, label: "None", src: null },
  { id: "A1", label: "Leaf Sprig", src: "/ui/avatar/accessories/A1.png" },
  { id: "A2", label: "Purple Flower", src: "/ui/avatar/accessories/A2.png" },
  { id: "A3", label: "Bow Tie", src: "/ui/avatar/accessories/A3.png" },
  { id: "A4", label: "Beret", src: "/ui/avatar/accessories/A4.png" },
  { id: "A5", label: "Baseball Cap", src: "/ui/avatar/accessories/A5.png" },
  { id: "A6", label: "Leaf Bandana", src: "/ui/avatar/accessories/A6.png" },
  { id: "A7", label: "Goggles", src: "/ui/avatar/accessories/A7.png" },
  { id: "A8", label: "Round Glasses", src: "/ui/avatar/accessories/A8.png" },
  { id: "A9", label: "Sunglasses", src: "/ui/avatar/accessories/A9.png" },
  { id: "A10", label: "Sprout", src: "/ui/avatar/accessories/A10.png" },
  { id: "A11", label: "Rosy Cheeks", src: "/ui/avatar/accessories/A11.png" },
  { id: "A12", label: "Mustache", src: "/ui/avatar/accessories/A12.png" },
];

export function getMushroom(index: number): MushroomOption {
  return MUSHROOMS[index] ?? MUSHROOMS[0]!;
}

export function getAccessory(index: number): AccessoryOption {
  return ACCESSORIES[index] ?? ACCESSORIES[0]!;
}

export interface AvatarSelection {
  name: string;
  mushroomIndex: number;
  accessoryIndex: number;
}

export const DEFAULT_AVATAR: AvatarSelection = {
  name: "",
  mushroomIndex: 0,
  accessoryIndex: 0,
};

// ---------------------------------------------------------------------
// Local persistence — remembers name/color/accessory across visits (and
// across the homepage, per-game landing pages, and joining via an invite
// link) so a player never has to rebuild their look every time they
// create or join a room. Shared by every screen that renders
// <AvatarCreator> (app/components/RoomForms.tsx and the in-room "join by
// link" form in app/games/[game]/room/[code]/RoomClient.tsx) so they all
// read/write the same record instead of each keeping its own copy.
//
// localStorage rather than a cookie: this is a client-only display
// preference — nothing server-side ever needs to read it (see the
// `AvatarSelection` note above), so there's no reason to pay the
// send-it-with-every-request cost a cookie carries.
// ---------------------------------------------------------------------

export const AVATAR_STORAGE_KEY = "party-together:avatar";

export function loadStoredAvatar(): AvatarSelection {
  if (typeof window === "undefined") return DEFAULT_AVATAR;
  try {
    const raw = window.localStorage.getItem(AVATAR_STORAGE_KEY);
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

export function saveStoredAvatar(avatar: AvatarSelection): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AVATAR_STORAGE_KEY, JSON.stringify(avatar));
  } catch {
    // Storage can be unavailable (private browsing, quota) — the picker
    // still works for this visit, it just won't be remembered.
  }
}
