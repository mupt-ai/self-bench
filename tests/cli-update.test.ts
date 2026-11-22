import { expect, test } from "bun:test";
import { helpText } from "../src/api/cli/help.js";
import { compareVersions, latestVersion } from "../src/api/cli/update.js";

test("versions compare numerically, not as text", () => {
  expect(compareVersions("0.3.10", "0.3.9")).toBeGreaterThan(0);
  expect(compareVersions("0.3.15", "0.3.15")).toBe(0);
  expect(compareVersions("0.3", "0.3.1")).toBeLessThan(0);
});

test("the newest CLI release is found past pages of deploy releases", async () => {
  const pages: Record<string, unknown[]> = {
    "1": [{ tag_name: "v2026.11.20" }, { tag_name: "cli-v9.9.9", draft: true }],
    "2": [{ tag_name: "v2026.11.01" }, { tag_name: "cli-v0.3.16" }, { tag_name: "cli-v0.3.15" }],
  };
  const fetcher = (async (url: string) =>
    Response.json(pages[new URL(url).searchParams.get("page") ?? ""] ?? [])) as typeof fetch;
  expect(await latestVersion(fetcher)).toBe("0.3.16");
});

test("help lists update", () => {
  expect(helpText([])).toContain("update");
  expect(helpText(["update"])).toContain("--check");
});
