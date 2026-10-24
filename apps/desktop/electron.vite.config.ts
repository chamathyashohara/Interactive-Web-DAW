import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Workspace packages ship TypeScript source, so they must be bundled, not externalised.
// "ws" must stay external: bundling it makes live collaboration hang. electron-builder packages it as a normal dependency.
const bundled = ["@daw/shared", "@daw/engine-protocol", "@daw/sounds", "@daw/collab"];

export default defineConfig({
  main: { build: { externalizeDeps: { exclude: bundled } } },
  preload: { build: { externalizeDeps: { exclude: bundled } } },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: { rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") } },
    plugins: [react(), tailwindcss()],
  },
});
