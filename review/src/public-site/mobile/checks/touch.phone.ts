import { expect, test } from "@playwright/test";
import { pinnedShare } from "./page-rules";
import { open } from "./visit";

// A repository in the synthetic data (synthetic.ts), with a card on home and a full chart.
const REPOSITORY = "/example-org/widgets";

test("pinned bars leave most of the screen to the page", async ({ page }) => {
  await open(page, REPOSITORY);
  expect(
    await page.evaluate(pinnedShare),
    "The pinned header and footer cover over a fifth of the screen. Shrink them on `compact:` screens, or let them scroll with the page (as the footer does).",
  ).toBeLessThanOrEqual(0.2);
});

test("a tapped card opens its repository without taking on its hover look", async ({ page }) => {
  await open(page, "/");
  // The opening transition may hold a card in its hover look (data-active, effects/marks.ts)
  // only where the visitor could have hovered it.
  await page.evaluate(() => {
    const held = { seen: false };
    Object.assign(window, { held });
    new MutationObserver(() => {
      if (document.querySelector("[data-active]")) held.seen = true;
    }).observe(document.body, {
      attributes: true,
      subtree: true,
      attributeFilter: ["data-active"],
    });
  });
  await page.locator(`a[href="${REPOSITORY}"]`).first().tap();
  await expect(page).toHaveURL(REPOSITORY);
  await expect(page.getByRole("main")).toContainText("example-org/widgets");
  expect(
    await page.evaluate(() => (window as unknown as { held: { seen: boolean } }).held.seen),
    "A tap forced a card into its hover look. Hold hover only when canHover() (mobile/device.ts).",
  ).toBe(false);
});

test("back plays no transition of its own; the browser's swipe animates it", async ({ page }) => {
  await open(page, "/");
  await page.locator(`a[href="${REPOSITORY}"]`).first().tap();
  await expect(page).toHaveURL(REPOSITORY);
  await page.evaluate(() => {
    const sheets = { seen: 0 };
    Object.assign(window, { sheets });
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && node.matches("[inert]")) sheets.seen += 1;
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.goBack();
  await expect(page).toHaveURL("/");
  await page.waitForTimeout(400);
  expect(
    await page.evaluate(() => (window as unknown as { sheets: { seen: number } }).sheets.seen),
    "A transition played on back. On touch, history-transitions.ts leaves back to the browser (touchInput()).",
  ).toBe(0);
});

test("a tap on a chart point shows its details, and a tap away hides them", async ({ page }) => {
  await open(page, REPOSITORY);
  // The first point, centred on the screen, and the spot in the chart farthest from every
  // point that is in view and clear of the header.
  const { point, away } = await page
    .locator('svg[role="img"]')
    .first()
    .evaluate((svg) => {
      svg.querySelector("circle")?.scrollIntoView({ block: "center", behavior: "instant" });
      const centres = [...svg.querySelectorAll("circle")].map((circle) => {
        const box = circle.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      });
      const frame = svg.getBoundingClientRect();
      const top = Math.max(
        frame.top,
        document.querySelector("header")?.getBoundingClientRect().bottom ?? 0,
      );
      const bottom = Math.min(frame.bottom, window.innerHeight);
      let best = { x: 0, y: 0, gap: -1 };
      for (let x = frame.left + 10; x < frame.right - 10; x += 10) {
        for (let y = top + 10; y < bottom - 10; y += 10) {
          const gap = Math.min(...centres.map((centre) => Math.hypot(centre.x - x, centre.y - y)));
          if (gap > best.gap) best = { x, y, gap };
        }
      }
      return { point: centres[0], away: best };
    });
  expect(point, "The chart has no points to tap.").toBeDefined();
  if (!point) return;
  const text = () => page.getByRole("main").innerText();
  const before = await text();
  await page.touchscreen.tap(point.x, point.y);
  await expect
    .poll(text, {
      message:
        "A tap on a point showed nothing. On touch, the chart inspects on the tap's pointerup.",
    })
    .not.toBe(before);
  await page.touchscreen.tap(away.x, away.y);
  await expect
    .poll(text, { message: "A tap away from every point left the details open." })
    .toBe(before);
});
