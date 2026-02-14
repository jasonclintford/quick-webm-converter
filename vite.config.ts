import { defineConfig } from "vite";

export default defineConfig({
  // Important for GitHub Pages (sub-path hosting)
  base: "./",
  optimizeDeps: {
    // FFmpeg spins up its own worker via import.meta.url; prebundling breaks this path.
    exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"]
  }
});
