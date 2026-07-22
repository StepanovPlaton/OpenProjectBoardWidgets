import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

const browser = process.env.BROWSER === "firefox" ? "firefox" : "chrome";

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: `dist/${browser}`,
    emptyOutDir: true,
    sourcemap: true,
  },
});
