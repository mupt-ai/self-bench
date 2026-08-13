import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "review",
  plugins: [react()],
  build: {
    outDir: "../dist/review",
    emptyOutDir: true,
  },
  server: {
    allowedHosts: ["avyays-mac-mini.tailf3cee5.ts.net"],
    proxy: {
      "/v1": "http://127.0.0.1:8080",
    },
  },
  preview: {
    allowedHosts: ["avyays-mac-mini.tailf3cee5.ts.net"],
  },
});
