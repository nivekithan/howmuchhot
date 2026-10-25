import { defineConfig } from "vite-plus";
export default defineConfig({
  server: {
    proxy: { "/api": { target: "https://howmuchhot.nivekithan.workers.dev", changeOrigin: true } },
  },
});
