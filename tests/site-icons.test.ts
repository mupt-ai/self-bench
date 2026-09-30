import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { isReviewAssetPath } from "../src/api/http.js";

const repository = (path: string) => new URL(`../${path}`, import.meta.url);

/** The icons a page's head links, in order. */
const iconsOf = (page: string) =>
  [
    ...readFileSync(repository(page), "utf8").matchAll(
      /<link rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"/g,
    ),
  ].map((match) => match[1] ?? "");

test("the app and selfbench.dev link the same icons, and both can serve every one", () => {
  const icons = iconsOf("review/index.html");
  expect(iconsOf("review/public-site/index.html")).toEqual(icons);
  // Browsers and crawlers ask for these two at the root without reading the page.
  expect(icons).toContain("/favicon.ico");
  expect(icons).toContain("/apple-touch-icon.png");
  for (const icon of icons) {
    // In the static folder both builds copy, and served by the app without sign-in.
    expect(existsSync(repository(`review/public${icon}`))).toBe(true);
    expect(isReviewAssetPath(icon)).toBe(true);
  }
});
