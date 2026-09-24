import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, devices, type Project, webkit } from "@playwright/test";

/**
 * The phone checks for selfbench.dev (review/src/public-site/AGENTS.md): the public site on
 * emulated phones, over the synthetic repositories, from a dev server of its own. Chrome
 * always; WebKit, the engine of every iPhone browser, as well where it is installed
 * (`bunx playwright install webkit`). `bun run test:phone`, `bun run record:transitions`.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const output = `${root}.selfbench/phone`;
// A port per worktree, so checks running in two worktrees at once do not collide.
const port =
  Number(process.env.PHONE_PORT) ||
  5300 + (createHash("sha1").update(root).digest().readUInt16BE(0) % 600);
const recording = Boolean(process.env.PHONE_RECORD);

/** The narrowest phone, a common one in dark mode, an Android phone, and one held sideways. */
const phones: Record<string, Project["use"]> = {
  "iPhone SE": devices["iPhone SE"],
  "iPhone 15 Dark": { ...devices["iPhone 15"], colorScheme: "dark" },
  "Pixel 7": devices["Pixel 7"],
  "iPhone 15 Landscape": devices["iPhone 15 landscape"],
};

const chrome = Object.entries(phones).map(([name, use]) => ({
  name: `Chrome ${name}`,
  use: { ...use, browserName: "chromium" as const, channel: "chrome" },
}));
const safari = existsSync(webkit.executablePath())
  ? Object.entries(phones)
      .filter(([name]) => name.startsWith("iPhone"))
      .map(([name, use]) => ({
        name: `WebKit ${name}`,
        use: { ...use, browserName: "webkit" as const },
      }))
  : [];

export default defineConfig({
  testDir: "src/public-site/mobile/checks",
  testMatch: "*.phone.ts",
  // The recordings run only when asked for; the checks, every other time.
  grep: recording ? /@record/ : undefined,
  grepInvert: recording ? undefined : /@record/,
  outputDir: `${output}/results`,
  reporter: [
    [process.env.CI ? "github" : "list"],
    ["html", { outputFolder: `${output}/report`, open: "never" }],
  ],
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  use: { baseURL: `http://127.0.0.1:${port}` },
  projects: [...chrome, ...safari],
  webServer: {
    command: `bun run dev:public --port ${port} --host 127.0.0.1`,
    cwd: root,
    env: { VITE_PUBLIC_DATA: "synthetic" },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
