import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const additionalAllowedHosts = (process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  root: "review",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../dist/review",
    emptyOutDir: true,
    chunkSizeWarningLimit: 850,
  },
  server: {
    ...(additionalAllowedHosts.length > 0 ? { allowedHosts: additionalAllowedHosts } : {}),
    proxy: {
      "^/api/orgs/[^/]+/repos/[^/]+/[^/]+/evaluations/(comparisons|credentials)(?:/|$)":
        process.env.SELFBENCH_VIEW_PROXY ?? "http://127.0.0.1:8080",
      ...(process.env.SELFBENCH_EVALUATION_PROXY
        ? {
            "^/api/orgs/[^/]+/repos/[^/]+/[^/]+/evaluations(?:/|$)":
              process.env.SELFBENCH_EVALUATION_PROXY,
          }
        : {}),
      "/v1": process.env.SELFBENCH_VIEW_PROXY ?? "http://127.0.0.1:8080",
      "/api": process.env.SELFBENCH_VIEW_PROXY ?? "http://127.0.0.1:8080",
      "/auth": process.env.SELFBENCH_VIEW_PROXY ?? "http://127.0.0.1:8080",
    },
  },
  preview: {
    ...(additionalAllowedHosts.length > 0 ? { allowedHosts: additionalAllowedHosts } : {}),
  },
});
