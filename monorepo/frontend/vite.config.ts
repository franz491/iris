import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // backend dev server
      "/api": {
        target: process.env.IRIS_BACKEND_URL ?? "http://localhost:3000",
        changeOrigin: false,
        // SSE needs no buffering
        ws: false,
      },
    },
  },
});
