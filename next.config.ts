import type { NextConfig } from "next";

// Platform-wide Next.js config.
// Game-specific config must NOT live here — see /games/<game>/config.ts instead.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  images: {
    // Supabase Storage host for character art (and any future game assets)
    // will be added here once the Supabase project URL is known.
    // remotePatterns: [{ protocol: "https", hostname: "<project-ref>.supabase.co" }],
  },
};

export default nextConfig;
