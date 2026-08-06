// Indexable, server-rendered SEO landing page for a single game
// (e.g. /games/who-am-i). Crawlable — this is the page meant to rank in
// search, as opposed to the live room pages under /room/[code] which are
// noindex (see app/games/[game]/room/[code]/page.tsx).
//
// Driven entirely by that game's GameConfig (SPEC.md §4):
//   - 404s via notFound() when the slug isn't a registered game
//   - per-game <title>/description/OG/Twitter tags via `generateMetadata`
//   - on-page marketing copy + a "Create Room" CTA for this game

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { games, getGameConfig, toGameSummary } from "@/lib/games-registry";
import { CreateRoomForm } from "@/app/components/CreateRoomForm";
import { JoinRoomForm } from "@/app/components/JoinRoomForm";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://partytogether.com";

type GameLandingPageProps = {
  params: Promise<{ game: string }>;
};

export async function generateMetadata({
  params,
}: GameLandingPageProps): Promise<Metadata> {
  const { game } = await params;
  const config = getGameConfig(game);

  // Let the page itself 404 (via notFound() below) rather than duplicating
  // the "unknown game" branch here — an empty object just falls back to the
  // root layout's default metadata for the 404 render.
  if (!config) return {};

  const url = `${siteUrl}/games/${config.id}`;
  const thumbnailUrl = `${siteUrl}${config.thumbnailPath}`;

  return {
    title: config.displayName,
    description: config.description,
    alternates: { canonical: url },
    openGraph: {
      title: config.displayName,
      description: config.description,
      url,
      siteName: "Party Together",
      images: [{ url: thumbnailUrl }],
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: config.displayName,
      description: config.description,
      images: [thumbnailUrl],
    },
  };
}

// New games automatically get a static path (and therefore a build-time
// prerendered landing page) purely by being added to the registry — no
// change needed here.
export function generateStaticParams() {
  return games.map((g) => ({ game: g.id }));
}

export default async function GameLandingPage({ params }: GameLandingPageProps) {
  const { game } = await params;
  const config = getGameConfig(game);

  if (!config) notFound();

  return (
    <main className="page">
      <h1>{config.displayName}</h1>
      <p className="lede">{config.description}</p>
      <p className="muted">
        {config.minPlayers}–{config.maxPlayers} players
      </p>
      <div className="two-up">
        <CreateRoomForm games={[toGameSummary(config)]} fixedGameId={config.id} />
        <JoinRoomForm />
      </div>
    </main>
  );
}
