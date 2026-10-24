import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Workspace packages ship TypeScript source, so they must be bundled, not externalised.
// "ws" must stay external: bundling it makes live collaboration hang. electron-builder packages it as a normal dependency.
const bundled = ["@daw/shared", "@daw/engine-protocol", "@daw/sounds", "@daw/collab", "@daw/recording"];

export default defineConfig({
  main: { build: { externalizeDeps: { exclude: bundled } } },
  preload: { build: { externalizeDeps: { exclude: bundled } } },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: {
      rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") },
      // The audio worklet must stay a real file: a data: URL is refused by the page's Content-Security-Policy (script-src 'self').
      assetsInlineLimit: (file: string) => (file.endsWith("recordingWorklets.js") ? false : undefined),
    },
    plugins: [react(), tailwindcss()],
  },
});
