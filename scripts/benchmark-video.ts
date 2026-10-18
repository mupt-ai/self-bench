/**
 * A social video of one model across selfbench.dev benchmarks: each repository's full results
 * chart in turn, the model highlighted, the Pareto frontier named, morphing from repository to
 * repository. The look is the site's own chart (review/src/benchmark-video).
 *
 *   bun run video --model deepseek/deepseek-v4.1-flash-1017 \
 *     --repos getsentry/sentry,vercel/next.js,PostHog/posthog \
 *     --also deepseek/deepseek-v4.1-flash=old
 *
 * --model    catalog id of the highlighted model (a setting id's first part); required
 * --repos    comma-separated repositories, in order; the model must be on each one's release
 * --also     another model to name on the chart even off the frontier; "=note" replaces its
 *            reasoning level in the label. Repeatable
 * --title    the words after the model name in the heading (default "on Real Repos")
 * --out      output directory (default video-out); writes <model>.mp4 and <model>.gif
 * --stills   comma-separated seconds: write PNG stills there instead of the video, to check
 * --api      the site to read releases from (default https://selfbench.dev)
 *
 * Needs ffmpeg and a Playwright Chromium (bunx playwright install chromium) or Google Chrome.
 */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Browser, chromium } from "@playwright/test";

// The page's window.VIDEO (review/src/benchmark-video/motion.ts, VideoConfig); the review
// bundle's types stay out of the server's TypeScript project.
interface VideoRepo {
  name: string;
  avatar: string;
  tasks: number;
  settings: { id: string; costPerTaskUsd: number; costIncomplete?: true }[];
}

const FPS = 25;
const root = resolve(import.meta.dir, "..");
const source = join(root, "review/src/benchmark-video");

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    repos: { type: "string" },
    also: { type: "string", multiple: true, default: [] },
    title: { type: "string", default: "on Real Repos" },
    out: { type: "string", default: "video-out" },
    stills: { type: "string" },
    api: { type: "string", default: "https://selfbench.dev" },
  },
});
const model = values.model;
const repoNames =
  values.repos
    ?.split(",")
    .map((name) => name.trim())
    .filter(Boolean) ?? [];
if (!model || repoNames.length === 0) {
  console.error(
    "usage: bun run video --model <catalog id> --repos <owner/repo,...> [--also <model>[=note]]",
  );
  process.exit(1);
}

async function release(name: string): Promise<VideoRepo> {
  const response = await fetch(`${values.api}/api/public/repos/${name}`);
  if (!response.ok) throw new Error(`${name}: ${response.status} from ${values.api}`);
  const { lines } = (await response.json()) as { lines: { release: Record<string, never> }[] };
  const shown = lines[0]?.release as unknown as {
    repository: { fullName: string; ownerAvatarUrl: string };
    tasks: number;
    settings: VideoRepo["settings"];
  };
  if (!shown) throw new Error(`${name} has no release`);
  // The page charts only settings with a complete, nonzero cost (motion.ts, chartable).
  const charted = (setting: VideoRepo["settings"][number]) =>
    !setting.costIncomplete && setting.costPerTaskUsd > 0;
  if (!shown.settings.some((setting) => setting.id.split("|")[0] === model && charted(setting)))
    throw new Error(`${model} has no setting with a complete cost on ${name}'s current release`);
  return {
    name: shown.repository.fullName,
    avatar: shown.repository.ownerAvatarUrl,
    tasks: shown.tasks,
    settings: shown.settings,
  };
}

const config = {
  title: values.title,
  model,
  extras: values.also.map((entry) => {
    const [extra = "", note] = entry.split("=");
    return note ? { model: extra, note } : { model: extra };
  }),
  repos: await Promise.all(repoNames.map(release)),
};

// The page: the site's fonts, palette and mark beside the bundled video and its data.
const site = mkdtempSync(join(tmpdir(), "benchmark-video-"));
cpSync(join(root, "review/src/public-site/fonts"), join(site, "fonts"), { recursive: true });
cpSync(join(root, "review/src/public-site/palette.css"), join(site, "palette.css"));
cpSync(join(root, "review/public/dari-logo.svg"), join(site, "dari-logo.svg"));
cpSync(join(source, "index.html"), join(site, "index.html"));
writeFileSync(join(site, "video-config.js"), `window.VIDEO=${JSON.stringify(config)};`);
const built = await Bun.build({
  entrypoints: [join(source, "video.tsx")],
  outdir: site,
  target: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!built.success) throw new AggregateError(built.logs, "the video page did not build");

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const file = Bun.file(join(site, new URL(request.url).pathname));
    return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
  },
});

async function launch(): Promise<Browser> {
  try {
    return await chromium.launch();
  } catch {
    return chromium.launch({ channel: "chrome" });
  }
}

const out = resolve(values.out);
mkdirSync(out, { recursive: true });
const slug = model.replace(/[^a-z0-9.]+/gi, "-");
const browser = await launch();
try {
  const page = await browser.newPage({
    viewport: { width: 960, height: 640 },
    deviceScaleFactor: 2,
  });
  let pageError: Error | undefined;
  page.on("pageerror", (error) => {
    pageError ??= error;
  });
  await page.goto(`http://127.0.0.1:${server.port}/index.html`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const duration = await page.evaluate(() => (window as unknown as { DURATION: number }).DURATION);

  const frame = async (t: number) => {
    await page.evaluate(
      (at) => (window as unknown as { renderAt(t: number): void }).renderAt(at),
      t,
    );
    // A repository's avatar loads when its header first shows; the frame waits for it.
    await page.evaluate(() =>
      Promise.all(
        [...document.images].map(
          (image) => image.complete || new Promise((done) => (image.onload = image.onerror = done)),
        ),
      ),
    );
    if (pageError) throw pageError;
    return page.screenshot({ type: "png" });
  };

  if (values.stills) {
    for (const t of values.stills.split(",").map(Number)) {
      writeFileSync(join(out, `${slug}-${t}s.png`), await frame(t));
    }
    console.log(`stills in ${out}`);
  } else {
    const mp4 = join(out, `${slug}.mp4`);
    const encoder = spawn(
      "ffmpeg",
      [
        "-loglevel",
        "error",
        "-y",
        "-f",
        "image2pipe",
        "-framerate",
        String(FPS),
        "-c:v",
        "png",
        "-i",
        "-",
        "-vf",
        "format=yuv420p",
        "-c:v",
        "libx264",
        "-crf",
        "16",
        "-movflags",
        "+faststart",
        mp4,
      ],
      { stdio: ["pipe", "inherit", "inherit"] },
    );
    const done = new Promise((resolveExit) => encoder.once("close", resolveExit));
    for (let i = 0; i < Math.round(duration * FPS); i++) {
      if (!encoder.stdin.write(await frame(i / FPS))) {
        await new Promise((drained) => encoder.stdin.once("drain", drained));
      }
    }
    encoder.stdin.end();
    if ((await done) !== 0) throw new Error("ffmpeg failed to encode the video");
    await run("ffmpeg", [
      "-loglevel",
      "error",
      "-y",
      "-i",
      mp4,
      "-vf",
      "scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle",
      "-loop",
      "0",
      join(out, `${slug}.gif`),
    ]);
    console.log(`wrote ${mp4} and ${slug}.gif (${duration.toFixed(1)}s)`);
  }
} finally {
  await browser.close();
  server.stop();
  rmSync(site, { recursive: true, force: true });
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((done, fail) =>
    spawn(command, args, { stdio: "inherit" }).once("close", (code) =>
      code === 0 ? done() : fail(new Error(`${command} exited with ${code}`)),
    ),
  );
}
