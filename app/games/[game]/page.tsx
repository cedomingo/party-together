// Indexable, server-rendered SEO landing page for a single game
// (e.g. /games/who-am-i). Crawlable - this is the page meant to rank in
// search, as opposed to the live room pages under /room/[code] which are
// noindex (see app/games/[game]/room/[code]/page.tsx).
//
// <title>/description come from generateMetadata below, driven entirely by
// the game's GameConfig.seo (lib/games-registry.ts). Games without `seo`
// fall back to displayName/description so a new game can still ship a
// (less optimized) landing page without touching this file.
//
// Also emits two JSON-LD blocks (buildJsonLd below) for rich-result
// eligibility: a BreadcrumbList (Home > Games > this game - Google's
// best-supported structured-data type, shows the breadcrumb trail in the
// SERP instead of the raw URL) and a VideoGame entry describing the game
// itself (player count, free price, genre) for broader search feature/
// Knowledge Graph eligibility. Both are additive - they don't change what
// renders on the page, only what crawlers can parse out of it.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getGameConfig, games, type GameConfig } from "@/lib/games-registry";
import { RoomForms } from "@/app/components/RoomForms";
import { getSiteUrl } from "@/lib/site";

export function generateStaticParams() {
  return games.map((g) => ({ game: g.id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ game: string }>;
}): Promise<Metadata> {
  const { game } = await params;
  const config = getGameConfig(game);
  if (!config) return {};

  const title = config.seo?.title ?? config.displayName;
  const description = config.seo?.metaDescription ?? config.description;

  return {
    title,
    description,
    keywords: config.seo?.searchTerms,
    alternates: { canonical: `/games/${config.id}` },
    openGraph: {
      title,
      description,
      url: `/games/${config.id}`,
      images: [{ url: config.thumbnailPath }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [config.thumbnailPath],
    },
  };
}

// Kept as plain objects (not schema-dts or similar) - the JSON-LD vocab
// here is small and stable enough that a dependency would be overkill;
// each block matches the shape Google's Rich Results Test expects.
function buildJsonLd(config: GameConfig) {
  const siteUrl = getSiteUrl();
  const gameUrl = `${siteUrl}/games/${config.id}`;
  const name = config.seo?.title ?? config.displayName;
  const description = config.seo?.metaDescription ?? config.description;

  const breadcrumbList = {
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: siteUrl },
      { "@type": "ListItem", position: 2, name: "Games", item: `${siteUrl}/games` },
      { "@type": "ListItem", position: 3, name: config.displayName, item: gameUrl },
    ],
  };

  const videoGame = {
    "@type": "VideoGame",
    name,
    description,
    url: gameUrl,
    image: `${siteUrl}${config.thumbnailPath}`,
    genre: "Party game",
    playMode: "MultiPlayer",
    applicationCategory: "GameApplication",
    operatingSystem: "Web Browser",
    numberOfPlayers: {
      "@type": "QuantitativeValue",
      minValue: config.minPlayers,
      maxValue: config.maxPlayers,
    },
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
    publisher: {
      "@type": "Organization",
      name: "Party Together",
      url: siteUrl,
    },
    keywords: config.seo?.searchTerms?.join(", "),
  };

  return {
    "@context": "https://schema.org",
    "@graph": [breadcrumbList, videoGame],
  };
}

export default async function GameLandingPage({
  params,
}: {
  params: Promise<{ game: string }>;
}) {
  const { game } = await params;
  const config = getGameConfig(game);
  if (!config) notFound();

  return (
    <main className="page" id="main-content">
      {/* eslint-disable-next-line react/no-danger -- static, server-built JSON we control (buildJsonLd), not user input */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(buildJsonLd(config)) }}
      />

      <h1>{config.seo?.h1 ?? config.displayName}</h1>
      <p className="lede">{config.seo?.intro ?? config.description}</p>
      <p className="muted">
        {config.minPlayers}–{config.maxPlayers} players
      </p>
      <RoomForms fixedGameId={config.id} />

      {config.seo?.tags && (
        <ul className="game-tags" aria-label="Related tags">
          {config.seo.tags.map((tag) => (
            <li key={tag}>{tag}</li>
          ))}
        </ul>
      )}
    </main>
  );
}
