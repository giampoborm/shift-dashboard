/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// PWA: makes the app installable on the phone and work offline for post-shift entry.
// Data is already 100% local (Dexie/IndexedDB), so once the app shell is cached the
// whole thing works with no network. Icons are generated separately from a source PNG
// via `npm run generate-pwa-assets` (see pwa-assets.config.ts) into public/ — the
// manifest below references the filenames that generator emits.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate", // a rebuild silently refreshes the installed app
      includeAssets: ["apple-touch-icon-180x180.png", "favicon.ico"],
      manifest: {
        name: "Shift Dashboard",
        short_name: "Shifts",
        description: "Local-first shift, tip & earnings tracker",
        lang: "en",
        theme_color: "#0f172a",
        background_color: "#0f172a",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "pwa-64x64.png", sizes: "64x64", type: "image/png" },
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          { src: "maskable-icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Precache the app shell so it opens offline. Data lives in IndexedDB, not here.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
      },
    }),
  ],
  test: {
    globals: true,
    environment: "node",
  },
});
