import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../", import.meta.url)),
  poweredByHeader: false,
  reactStrictMode: true,
  // `next dev` must not write AGENTS.md/CLAUDE.md into the source tree.
  agentRules: false,
  devIndicators: false,
  experimental: {
    optimizePackageImports: ["lucide-react", "@assistant-ui/react", "radix-ui"],
  },
};
export default config;
