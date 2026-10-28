import { beforeEach, expect, test } from "bun:test";
import { type ReleaseServer, releaseServerPerTest } from "./support/release-server.js";

const suite = releaseServerPerTest(["sol", "terra", "luna"]);
let server: ReleaseServer;
beforeEach(() => {
  server = suite.server;
});

async function release(settings: string[], publishSummaries: boolean) {
  const view = await server.preview();
  return server.request(server.base, {
    method: "POST",
    body: JSON.stringify({
      settings,
      head: view.head?.id ?? null,
      fingerprint: view.preview.fingerprint,
      publishSummaries,
    }),
  });
}

test("a release publishes the latest model summaries on the settings it releases", async () => {
  const settings = await server.allSettings();
  expect((await server.preview()).summaries).toBeUndefined();
  const refused = await release(settings, true);
  expect(refused.status).toBe(400);
  expect((await refused.json()).error).toContain("no model summaries to publish");

  const [first = ""] = settings;
  const report = {
    overview: "They all stop early.",
    summaries: [{ configuration: first, text: "It finishes migrations.", tasks: 3, passed: 2 }],
    model: "gpt-6-luna",
    summarizedAt: "2026-10-20T12:00:00.000Z",
  };
  await server.artifacts.put(
    `model-summaries/${server.repo.id}/reports/${report.summarizedAt}-test.json`,
    Buffer.from(JSON.stringify(report)),
    "application/json",
  );
  expect((await server.preview()).summaries).toEqual({
    configurations: [first],
    model: "gpt-6-luna",
    summarizedAt: report.summarizedAt,
  });
  const published = await release(settings, true);
  expect(published.status).toBe(201);
  expect((await published.json()).release.summariesPublished).toBe(true);
  // Everyone sees them on the repository's public page.
  const shown = await (await server.request("/api/public/repos/vercel/next.js", {}, null)).text();
  expect(shown).toContain("It finishes migrations.");
  expect(shown).toContain("They all stop early.");
});
