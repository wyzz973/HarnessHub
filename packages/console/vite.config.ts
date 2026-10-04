// SPDX-License-Identifier: MIT
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { themeBootScript } from "./lib/theme-script.ts";

/**
 * Serves `/theme-boot.js` in development and emits it with the build: the
 * console's CSP admits no inline script, and the boot code must run before
 * first paint (lib/theme-script.ts owns the text).
 */
function themeBoot(): Plugin {
  return {
    name: "harnesshub-theme-boot",
    configureServer(server) {
      server.middlewares.use("/theme-boot.js", (_request, response) => {
        response.setHeader("content-type", "text/javascript; charset=utf-8");
        response.end(themeBootScript);
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "theme-boot.js",
        source: themeBootScript,
      });
    },
  };
}

/**
 * The daemon the development server forwards API, gateway and health
 * requests to. The Host header is kept, so the daemon's loopback Host and
 * Origin checks see the page's own origin.
 */
const daemon = process.env.HARNESSHUB_DAEMON_URL ?? "http://127.0.0.1:3180";
const forwarded = ["/api", "/v1", "/v1beta", "/v1alpha", "/health", "/openapi.json"];

export default defineConfig({
  plugins: [react(), themeBoot()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "assets",
    // The polyfill is unnecessary for the supported browsers.
    modulePreload: { polyfill: false },
    sourcemap: false,
    // One application chunk is fine: the daemon serves it from this machine.
    chunkSizeWarningLimit: 4096,
  },
  server: {
    host: "127.0.0.1",
    port: 3330,
    strictPort: true,
    proxy: Object.fromEntries(
      forwarded.map((prefix) => [prefix, { target: daemon, changeOrigin: false }]),
    ),
  },
});
