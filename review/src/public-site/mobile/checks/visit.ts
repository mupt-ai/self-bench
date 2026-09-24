import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page, TestInfo } from "@playwright/test";

/**
 * Collects the page's uncaught errors and console errors, React's warnings among them. Errors
 * from other origins (the web fonts, when offline) are not the site's and are left out.
 */
export function watchErrors(page: Page, testInfo: TestInfo): string[] {
  const errors: string[] = [];
  const origin = String(testInfo.project.use.baseURL);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    const source = message.location().url;
    if (message.type() === "error" && (!source || source.startsWith(origin))) {
      errors.push(message.text());
    }
  });
  return errors;
}

/** Opens a path and waits until it has settled: the data shown, the fonts loaded, painted. */
export async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
}

/**
 * Where a check leaves a picture for people and agents to look at:
 * `.selfbench/phone/results/<kind>/<project>/<name>.png`, cleared at the start of every run.
 */
export function picturePath(testInfo: TestInfo, kind: string, name: string): string {
  const slug = (text: string) => text.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "home";
  return join(testInfo.project.outputDir, kind, slug(testInfo.project.name), `${slug(name)}.png`);
}

export interface Tile {
  caption: string;
  image: Buffer;
}

/** Lays pictures out in rows, each under its caption, and saves them as one picture. */
export async function contactSheet(browser: Browser, tiles: Tile[], width: number, path: string) {
  const figures = tiles
    .map(
      (tile) =>
        `<figure><figcaption>${tile.caption}</figcaption><img src="data:image/png;base64,${tile.image.toString("base64")}"></figure>`,
    )
    .join("");
  // Plain pixels: the project's phone settings would otherwise apply to this page too.
  const sheet = await browser.newPage({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  });
  await sheet.setContent(
    `<style>body{margin:8px;background:#444;display:flex;flex-wrap:wrap;gap:8px;font:12px monospace;color:#eee}figure{margin:0}img{display:block;width:${width}px;border:1px solid #888}</style>${figures}`,
  );
  await sheet.evaluate(() => Promise.all([...document.images].map((image) => image.decode())));
  mkdirSync(dirname(path), { recursive: true });
  await sheet.screenshot({ path, fullPage: true });
  await sheet.close();
}

/**
 * The page a screen at a time, top to bottom, as a visitor scrolls it: a full-page capture
 * would stretch the window, which changes the layout of a short (sideways) phone.
 */
export async function screens(page: Page, most = 6): Promise<Tile[]> {
  const tiles: Tile[] = [];
  const { scroll, height } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollHeight,
    height: window.innerHeight,
  }));
  const count = Math.min(most, Math.ceil(scroll / height));
  for (let index = 0; index < count; index += 1) {
    await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), index * height);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))));
    tiles.push({
      caption: `${index + 1} of ${count}`,
      image: await page.screenshot({ scale: "css" }),
    });
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  return tiles;
}
