import { defineConfig } from "vite-plus";

export default defineConfig({
  server: {
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
