import { beforeEach, expect, test } from "bun:test";
import type { ConnectedRepo } from "../src/db/repos.js";
import type { EvaluationRun } from "../src/evaluation/types.js";
import { full } from "./support/release-fixture.js";
import { type ReleaseServer, releaseServerPerTest } from "./support/release-server.js";

// next.js has t1-t3, approved and run by both models (releaseServerPerTest).
const suite = releaseServerPerTest(["sol", "terra"]);
let server: ReleaseServer;
let base: string;
let commerce: ConnectedRepo;

/** A run on vercel/commerce, whose tasks come from its own generation batch. */
const onCommerce = (run: EvaluationRun): EvaluationRun => ({
  ...run,
  trials: run.trials.map((trial) => ({ ...trial, runId: "gen-commerce" })),
});

beforeEach(async () => {
  server = suite.server;
  commerce = await server.connectCommerce();
  await server.approve(["c1", "c2"], commerce, "gen-commerce");
  for (const model of ["sol", "terra"])
    await server.save(onCommerce(full(model, ["c1", "c2"])), commerce);
  const group = await server.groups.create(server.tenant.id, "Next.js Apps", [
    server.repo.id,
    commerce.id,
  ]);
  base = `/api/orgs/acme/groups/${group.id}/releases`;
});

async function release(extra: Record<string, unknown> = {}) {
  const view = await (await server.request(`${base}/preview`)).json();
  return server.request(base, {
    method: "POST",
    body: JSON.stringify({
      settings: view.preview.settings.map((setting: { key: string }) => setting.key),
      head: view.head?.id ?? null,
      fingerprint: view.preview.fingerprint,
      publishTasks: true,
      ...extra,
    }),
  });
}

test("a group releases every member's tasks as one benchmark at its own address", async () => {
  const view = await (await server.request(`${base}/preview`)).json();
  // Nothing claimed yet: the dialog offers an address from the group's name.
  expect(view).toMatchObject({ slug: null, suggestedSlug: "next-js-apps" });
  expect(view.preview.tasks.map((task: { repository: string }) => task.repository).sort()).toEqual([
    "vercel/commerce",
    "vercel/commerce",
    "vercel/next.js",
    "vercel/next.js",
    "vercel/next.js",
  ]);
  // The first release must name its address.
  expect((await release()).status).toBe(400);
  const response = await release({ slug: "nextjs-apps" });
  expect(response.status).toBe(201);
  expect((await response.json()).release).toMatchObject({ path: "/groups/nextjs-apps", tasks: 5 });
  expect(server.groupChanges).toEqual(["nextjs-apps"]);

  const served = await (await server.request("/api/public/groups/nextjs-apps", {}, null)).json();
  expect(served.release).toMatchObject({
    tasks: 5,
    tasksPublished: true,
    group: {
      slug: "nextjs-apps",
      name: "Next.js Apps",
      // In the group's order: by name.
      members: [
        { id: 4242, fullName: "vercel/commerce", stars: 12000 },
        { id: 70107786, fullName: "vercel/next.js", stars: 137842 },
      ],
    },
  });
  expect(served.release.breakdown.map((share: { tasks: number }) => share.tasks)).toEqual([2, 3]);
  // Its tasks are served like a repository release's, each naming its repository.
  const tasks = await (
    await server.request(`/api/public/releases/${served.release.releaseId}/tasks`, {}, null)
  ).json();
  expect(tasks.tasks.map((task: { repository: string }) => task.repository)).toContain(
    "vercel/commerce",
  );
  // The home page's directory lists the group beside the repositories.
  const directory = await (await server.request("/api/public/results", {}, null)).json();
  expect(directory.groups.map((card: { group: { slug: string } }) => card.group.slug)).toEqual([
    "nextjs-apps",
  ]);

  // Later releases keep the address, whatever they ask for.
  await server.save(full("luna", ["t1", "t2", "t3"]));
  await server.save(onCommerce(full("luna", ["c1", "c2"])), commerce);
  const again = await release({ slug: "something-else" });
  expect(again.status).toBe(201);
  expect((await again.json()).release.path).toBe("/groups/nextjs-apps");
});

test("every member must be public, checked live on GitHub", async () => {
  server.commerceOnGitHub.private = true;
  const response = await release({ slug: "nextjs-apps" });
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain("vercel/commerce");
  expect((await server.request("/api/public/groups/nextjs-apps", {}, null)).status).toBe(404);
});

test("another workspace's group cannot take a released address", async () => {
  expect((await release({ slug: "nextjs-apps" })).status).toBe(201);
  const other = await server.groups.create(server.tenant.id, "Other Apps", [server.repo.id]);
  base = `/api/orgs/acme/groups/${other.id}/releases`;
  const taken = await release({ slug: "nextjs-apps" });
  expect(taken.status).toBe(400);
  expect((await taken.json()).error).toBe("This address is taken. Choose another.");
});

test("withdrawing a group's release takes its page off selfbench.dev", async () => {
  const { release: released } = await (await release({ slug: "nextjs-apps" })).json();
  const withdrawn = await server.request(`${base}/${released.id}/withdraw`, { method: "POST" });
  expect(withdrawn.status).toBe(200);
  expect(server.groupChanges).toEqual(["nextjs-apps", "nextjs-apps"]);
  expect((await server.request("/api/public/groups/nextjs-apps", {}, null)).status).toBe(404);
});
