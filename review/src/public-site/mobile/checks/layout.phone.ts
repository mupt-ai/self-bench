import { expect, test } from "@playwright/test";
import { FIXES, pageProblems, type Rule } from "./page-rules";
import { syntheticRoutes } from "./synthetic";
import { contactSheet, open, picturePath, screens, watchErrors } from "./visit";

// Pages as they settle: the entrance effects are skipped, as for a visitor who asks for less
// motion. Their measurements are the same either way.
test.use({ contextOptions: { reducedMotion: "reduce" } });

for (const path of syntheticRoutes()) {
  test(`${path} fits the screen`, async ({ page, browser }, testInfo) => {
    const errors = watchErrors(page, testInfo);
    await open(page, path);
    const problems = await page.evaluate(pageProblems);

    // Every route, a screen at a time, to look at when a change is visual.
    const picture = picturePath(testInfo, "pages", path);
    const width = page.viewportSize()?.width ?? 400;
    await contactSheet(browser, await screens(page), width, picture);
    await testInfo.attach("screens", { path: picture, contentType: "image/png" });

    for (const rule of Object.keys(FIXES) as Rule[]) {
      const broken = problems
        .filter((problem) => problem.rule === rule)
        .map((problem) => `${problem.element}: ${problem.detail}`);
      expect.soft(broken, FIXES[rule]).toEqual([]);
    }
    expect.soft(errors, "Errors thrown in the page or logged to its console.").toEqual([]);
  });
}
