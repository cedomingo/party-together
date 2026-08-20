// Single source of truth for the canonical production origin. Used by
// anywhere that needs an absolute URL server-side (sitemap, robots,
// metadataBase, JSON-LD structured data) - keeps the fallback domain from
// drifting out of sync across files if it's ever typo'd in one place.
export function getSiteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.partytogether.online";
}
