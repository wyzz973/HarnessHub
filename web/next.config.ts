import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    optimizePackageImports: ["lucide-react", "@assistant-ui/react", "radix-ui"],
  },
};
export default config;
