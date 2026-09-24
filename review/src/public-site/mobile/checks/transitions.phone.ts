import { type Page, test } from "@playwright/test";
import { contactSheet, open, picturePath, type Tile } from "./visit";

/**
 * Recordings of the page transitions on a phone, as timelines of frames to look at, not a
 * pass-or-fail check: `bun run record:transitions`, after a change under effects/. Chrome
 * records every frame it paints. WebKit has no such recorder, so it is sampled with
 * screenshots as fast as it takes them, and can miss a frame that flashes briefly.
 */

const REPOSITORY = "/example-org/widgets";
const RECORD_MS = 3000;
const MOST_FRAMES = 48;

async function record(page: Page, browserName: string, act: () => Promise<void>) {
  const frames: { ms: number; image: Buffer }[] = [];
  let start = 0;
  if (browserName === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
      frames.push({ ms: (metadata.timestamp ?? 0) * 1000, image: Buffer.from(data, "base64") });
      cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    });
    const { width, height } = page.viewportSize() ?? { width: 400, height: 900 };
    await cdp.send("Page.startScreencast", { format: "png", maxWidth: width, maxHeight: height });
    await page.waitForTimeout(300);
    start = Date.now();
    await act();
    await page.waitForTimeout(RECORD_MS);
    await cdp.send("Page.stopScreencast");
  } else {
    start = Date.now();
    const acting = act();
    while (Date.now() < start + RECORD_MS) {
      frames.push({ ms: Date.now(), image: await page.screenshot({ scale: "css" }) });
    }
    await acting;
  }
  // From the last frame before the tap, at most MOST_FRAMES, evenly spaced, each captioned
  // with its time since the tap.
  const kept = frames.slice(Math.max(0, frames.findIndex((frame) => frame.ms >= start) - 1));
  const step = Math.max(1, Math.ceil(kept.length / MOST_FRAMES));
  return kept
    .filter((_, index) => index % step === 0)
    .map((frame): Tile => ({ caption: `${Math.round(frame.ms - start)} ms`, image: frame.image }));
}

const scenarios = {
  /** Home to a repository: the card's title flies to the heading and the page assembles. */
  open: async (page: Page) => {
    await open(page, "/");
    return () => page.locator(`a[href="${REPOSITORY}"]`).first().tap();
  },
  /** A repository back to home by the logo: the page comes apart and home comes back. */
  return: async (page: Page) => {
    await open(page, "/");
    await page.locator(`a[href="${REPOSITORY}"]`).first().tap();
    await page.waitForURL(`**${REPOSITORY}`);
    await page.waitForTimeout(RECORD_MS);
    return () => page.getByRole("link", { name: "SELF-BENCH Home" }).tap();
  },
};

for (const [name, prepare] of Object.entries(scenarios)) {
  test(
    `record the ${name} transition`,
    { tag: "@record" },
    async ({ page, browser, browserName }, testInfo) => {
      test.setTimeout(60_000);
      const frames = await record(page, browserName, await prepare(page));
      const path = picturePath(testInfo, "transitions", name);
      await contactSheet(browser, frames, 190, path);
      await testInfo.attach(`${name} timeline`, { path, contentType: "image/png" });
      console.log(`${testInfo.project.name}, ${name}: ${frames.length} frames, ${path}`);
    },
  );
}
