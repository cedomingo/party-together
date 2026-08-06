import type { Metadata, Viewport } from "next";
import "./globals.css";

// Platform-wide default metadata. Per-game landing pages override this
// via the Next.js Metadata API using each game's GameConfig (§4 of SPEC.md).
export const metadata: Metadata = {
  title: {
    default: "Party Together",
    template: "%s | Party Together",
  },
  description:
    "Create a room, share the link, and play browser-based party games with friends.",
};

// Explicit rather than relying on Next's default (SPEC.md §11 mobile-first):
// most players open a shared room link on a phone, so this needs to be
// right, not just "probably fine by default." `maximum-scale`/
// `user-scalable` are intentionally left unset — pinch-zoom must keep
// working for low-vision players (WCAG 1.4.4), so this only fixes the
// initial layout width/zoom, never disables zooming.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#6c5ce7",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {/* Visually hidden until focused (see .skip-link in globals.css) —
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
