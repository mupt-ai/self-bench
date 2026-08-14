import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://127.0.0.1:8080" },
    allowedHosts: ["avyays-mac-mini.tailf3cee5.ts.net"],
  },
  preview: {
    allowedHosts: ["avyays-mac-mini.tailf3cee5.ts.net"],
  },
});
