import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The public selfbench.dev site: its own entry, bundle, and dev port, beside the app. */
export default defineConfig({
  root: "review/public-site",
  // Shares the app's static files (the dari logo, used as the favicon).
  publicDir: "../public",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../../dist/public-site",
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    strictPort: true,
  },
});
