import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    // Server Actions are the primary mutation path (CLAUDE.md §2).
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
};

export default nextConfig;
