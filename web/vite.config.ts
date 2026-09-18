import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    // The server serves this directory in production.
    outDir: "dist",
  },
  server: {
    // During development the frontend runs on its own port and forwards API
    // calls to the backend, so both can reload independently.
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
