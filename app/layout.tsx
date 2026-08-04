import type { Metadata } from "next";
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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
