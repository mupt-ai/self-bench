import { expect, test } from "bun:test";
import type { RegistryDataset } from "../src/contracts/harbor-registry.js";
import {
  fetchRegistryDatasets,
  registryCatalog,
} from "../src/harnesses/harbor/registry-catalog.js";
import { evaluationServer } from "./support/evaluation-fixture.js";

test("the registry listing reads Harbor's public dataset packages as org/name with task counts", async () => {
  const requests: { url: string; apikey: string | null }[] = [];
  const harbor = (async (input: string | URL, init?: RequestInit) => {
    requests.push({ url: String(input), apikey: new Headers(init?.headers).get("apikey") });
    // PostgREST's shape for the embedded org and newest unyanked version.
    return Response.json([
      {
        name: "terminal-bench-2",
        org: { name: "terminal-bench" },
        dataset_version: [
          { description: "  Terminal tasks. ", dataset_version_task: [{ count: 89 }] },
        ],
      },
      {
        name: "aider-polyglot",
        org: { name: "aider" },
        dataset_version: [{ description: null, dataset_version_task: [{ count: 225 }] }],
      },
      // Every version yanked: nothing to add.
      { name: "withdrawn", org: { name: "acme" }, dataset_version: [] },
    ]);
  }) as typeof fetch;

  expect(
    await fetchRegistryDatasets({ HARBOR_SUPABASE_URL: "https://registry.test" }, harbor),
  ).toEqual([
    { name: "aider/aider-polyglot", tasks: 225 },
    { name: "terminal-bench/terminal-bench-2", description: "Terminal tasks.", tasks: 89 },
  ]);
  const [request] = requests;
  expect(request?.url.startsWith("https://registry.test/rest/v1/package?")).toBe(true);
  const query = new URL(request?.url ?? "").searchParams;
  expect(query.get("type")).toBe("eq.dataset");
  expect(query.get("visibility")).toBe("eq.public");
  expect(request?.apikey).toStartWith("sb_publishable_");

  await expect(
    fetchRegistryDatasets({ HARBOR_SUPABASE_URL: "http://registry.test" }, harbor),
  ).rejects.toThrow("HTTPS");
  const down = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
  await expect(fetchRegistryDatasets({}, down)).rejects.toThrow("503");
});

test("the catalog asks Harbor once per period and keeps its last listing through an outage", async () => {
  let clock = 0;
  let calls = 0;
  let failing = false;
  const listing: RegistryDataset[] = [{ name: "harbor/hello-world", tasks: 1 }];
  const catalog = registryCatalog(
    async () => {
      calls += 1;
      await Promise.resolve();
      if (failing) throw new Error("registry down");
      return listing;
    },
    () => clock,
  );

  // Two visitors at once share one request.
  expect(await Promise.all([catalog(), catalog()])).toEqual([listing, listing]);
  expect(calls).toBe(1);
  clock += 9 * 60_000;
  await catalog();
  expect(calls).toBe(1);
  clock += 2 * 60_000;
  failing = true;
  expect(await catalog()).toEqual(listing);
  expect(calls).toBe(2);

  const empty = registryCatalog(async () => {
    throw new Error("registry down");
  });
  await expect(empty()).rejects.toThrow("registry down");
});

test("an org member gets the registry listing; an outage is a 502 and outsiders are refused", async () => {
  const datasets: RegistryDataset[] = [{ name: "harbor/hello-world", tasks: 1 }];
  let down = false;
  const fixture = await evaluationServer(undefined, {
    registryCatalog: async () => {
      if (down) throw new Error("registry down");
      return datasets;
    },
  });
  try {
    const path = `${fixture.benchmarks}/registry`;
    const listed = await fixture.request(path);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ datasets });
    expect((await fixture.request(path, {}, 2)).status).toBe(404);
    expect((await fixture.request(path, { method: "POST", body: "{}" })).status).toBe(405);
    down = true;
    const failed = await fixture.request(path);
    expect(failed.status).toBe(502);
    expect((await failed.json()).error).toBe("Harbor's registry could not be reached");
  } finally {
    await fixture.close();
  }
});
