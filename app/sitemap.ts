import type { MetadataRoute } from "next";
import { games } from "@/lib/games-registry";

// Static/landing pages only — room pages are noindex and must never appear
// here. Automatically picks up new games from the registry (§4 of SPEC.md).
export default function sitemap(): MetadataRoute.Sitemap {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://partytogether.com";

  const staticEntries: MetadataRoute.Sitemap = [
    { url: siteUrl, changeFrequency: "weekly", priority: 1 },
  ];

  const gameEntries: MetadataRoute.Sitemap = games.map((g) => ({
    url: `${siteUrl}/games/${g.id}`,
    changeFrequency: "monthly",
    priority: 0.8,
  }));

  return [...staticEntries, ...gameEntries];
}
