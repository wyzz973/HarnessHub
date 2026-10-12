import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  // React's runtime and the Base UI primitives are their own chunks: they change only with their dependency versions,
  // and the app chunk stays under the 500 kB warning. Markdown and code highlighting load on demand and stay out of them.
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false,
    rolldownOptions: { output: { codeSplitting: { groups: [
      { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
      { name: "base-ui", test: /node_modules[\\/]@base-ui[\\/]/ },
    ] } } } },
});
