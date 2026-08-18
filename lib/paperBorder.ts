/** Hand-drawn frame assets under public/ui/elements/borders/ - each PNG is
 *  authored at a specific size; pick the closest aspect ratio so the stroke
 *  does not look stretched when scaled to the container. */
export const PAPER_BORDER_SIZES = [
  { id: "800x800", width: 800, height: 800 },
  { id: "800x1200", width: 800, height: 1200 },
  { id: "800x1600", width: 800, height: 1600 },
  { id: "1024x800", width: 1024, height: 800 },
  { id: "1600x800", width: 1600, height: 800 },
  { id: "2400x800", width: 2400, height: 800 },
] as const;

export type PaperBorderId = (typeof PAPER_BORDER_SIZES)[number]["id"];

export function paperBorderUrl(id: PaperBorderId): string {
  return `/ui/elements/borders/${id}.png`;
}

export function pickPaperBorderId(width: number, height: number): PaperBorderId {
  if (width <= 0 || height <= 0) return "800x800";

  const aspect = width / height;
  let bestId: PaperBorderId = PAPER_BORDER_SIZES[0].id;
  let bestDelta = Infinity;

  for (const size of PAPER_BORDER_SIZES) {
    const delta = Math.abs(aspect - size.width / size.height);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestId = size.id;
    }
  }

  return bestId;
}

export function applyPaperBorder(el: HTMLElement, id: PaperBorderId): void {
  el.style.backgroundImage = `url("${paperBorderUrl(id)}")`;
}
