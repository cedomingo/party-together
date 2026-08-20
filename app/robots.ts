import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/site";

// Next.js metadata-route convention: this generates /robots.txt at build/
// request time, the same way app/sitemap.ts generates /sitemap.xml - no
// static file needed, and the two always agree on siteUrl.
//
// Live room pages (/games/*/room/*) are already noindex via their own
// route `metadata` export (see app/games/[game]/room/[code]/page.tsx);
// disallowing the path here too keeps crawlers from spending budget on an
// ephemeral, per-room URL space that can never usefully rank.
export default function robots(): MetadataRoute.Robots {
  const siteUrl = getSiteUrl();

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/games/*/room/*", "/api/"],
    },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
