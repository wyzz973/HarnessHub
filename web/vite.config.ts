import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  // React's runtime is its own chunk: it changes only with the dependency version, and the app chunk stays under the
  // 500 kB warning. Markdown rendering is already loaded on demand and stays out of this group.
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false,
    rolldownOptions: { output: { codeSplitting: { groups: [{ name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ }] } } } },
});
