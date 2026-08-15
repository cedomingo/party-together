import type { MetadataRoute } from "next";
import { games } from "@/lib/games-registry";

// Static/landing pages only — room pages are noindex and must never appear
// here. Automatically picks up new games from the registry (§4 of SPEC.md).
// The bare /games listing is indexable; the /games?room=... swap variant is
// ephemeral and dynamic (it mutates a room), so it is intentionally NOT
// here — and query-param variants can't appear in a sitemap anyway.
export default function sitemap(): MetadataRoute.Sitemap {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://partytogether.com";

  const staticEntries: MetadataRoute.Sitemap = [
    { url: siteUrl, changeFrequency: "weekly", priority: 1 },
    { url: `${siteUrl}/games`, changeFrequency: "monthly", priority: 0.8 },
  ];

  const gameEntries: MetadataRoute.Sitemap = games.map((g) => ({
    url: `${siteUrl}/games/${g.id}`,
    changeFrequency: "monthly",
    priority: 0.8,
  }));

  return [...staticEntries, ...gameEntries];
}
