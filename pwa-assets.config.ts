// PWA icon generation. Run `npm run generate-pwa-assets` after dropping a square
// source image at public/icon-source.png (>=512x512). It emits the 192/512/maskable
// + apple-touch icons that the manifest (in vite.config.ts) references, so the app
// is installable on the phone. This file is NOT imported by the Vite build — only
// the @vite-pwa/assets-generator CLI reads it.

import {
  defineConfig,
  minimal2023Preset,
} from "@vite-pwa/assets-generator/config";

export default defineConfig({
  preset: minimal2023Preset,
  images: ["public/icon-source.png"],
});
