import type { Metadata, Viewport } from "next";
import { PaperBorderAuto } from "./components/PaperBorderAuto";
import { getSiteUrl } from "@/lib/site";
import "./globals.css";

// Platform-wide default metadata. Per-game landing pages override this
// via the Next.js Metadata API using each game's GameConfig (§4 of SPEC.md).
// `metadataBase` lets every route below use relative URLs in `alternates.
// canonical` / `openGraph.url` / `openGraph.images` and still resolve to
// absolute, correctly-domained tags - falls back to the real production
// origin if the env var isn't set for some reason (matches app/sitemap.ts).
export const metadata: Metadata = {
  metadataBase: new URL(getSiteUrl()),
  title: {
    default: "Party Together – Free Online Party Games to Play with Friends",
    template: "%s | Party Together",
  },
  description:
    "Play free online multiplayer party games with friends in your browser. No sign-up, no download, and no account required. Create a room and start playing instantly.",
};

// Explicit rather than relying on Next's default (SPEC.md §11 mobile-first):
// most players open a shared room link on a phone, so this needs to be
// right, not just "probably fine by default." `maximum-scale`/
// `user-scalable` are intentionally left unset - pinch-zoom must keep
// working for low-vision players (WCAG 1.4.4), so this only fixes the
// initial layout width/zoom, never disables zooming.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#d9a52f",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <PaperBorderAuto />
        {/* Visually hidden until focused (see .skip-link in globals.css) -
            SPEC.md §11 accessibility: lets a keyboard user jump past the
            repeated header controls straight to each page's <main id=
            "main-content">, instead of tabbing through them every time. */}
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
