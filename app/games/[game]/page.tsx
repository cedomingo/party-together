// Indexable, server-rendered SEO landing page for a single game
// (e.g. /games/who-am-i). Crawlable — this is the page meant to rank in
// search, as opposed to the live room pages under /room/[code] which are
// noindex (see app/games/[game]/room/[code]/page.tsx).
//
// Once games are registered in /lib/games-registry.ts, this page will:
//   - call getGameConfig(params.game) and 404 if not found
//   - generate per-game <title>/description/OG tags via `generateMetadata`,
//     driven entirely by that game's GameConfig (§4 of SPEC.md)
//   - render on-page marketing copy + a "Create Room" CTA for this game
//
// Scaffolding only in Phase 0.

import { getGameConfig, toGameSummary } from "@/lib/games-registry";
import { CreateRoomForm } from "@/app/components/CreateRoomForm";
import { JoinRoomForm } from "@/app/components/JoinRoomForm";

export default async function GameLandingPage({
  params,
}: {
  params: Promise<{ game: string }>;
}) {
  const { game } = await params;
  const config = getGameConfig(game);

  // TODO(seo-phase): notFound() when config is undefined once games exist;
  // TODO(seo-phase): generateMetadata() driven by `config` per §4.
  return (
    <main className="page">
      <h1>{config?.displayName ?? game}</h1>
      {config ? (
        <>
          <p className="lede">{config.description}</p>
          <p className="muted">
            {config.minPlayers}–{config.maxPlayers} players
          </p>
          <div className="two-up">
            <CreateRoomForm games={[toGameSummary(config)]} fixedGameId={config.id} />
            <JoinRoomForm />
          </div>
        </>
      ) : (
        <p>Game landing page placeholder — Phase 0 scaffolding.</p>
      )}
    </main>
  );
}
