import { expect, test } from "bun:test";
import {
  candidateImageNames,
  discardCandidateImages,
  type RegistryAccess,
  removeRegistryImage,
} from "../../src/generation/images/registry.js";

const REPOSITORY = "us-central1-docker.pkg.dev/p/selfbench-tasks";
const API =
  "https://artifactregistry.googleapis.com/v1/projects/p/locations/us-central1/repositories/selfbench-tasks/packages";
const digest = (fill: string) => `sha256:${fill.repeat(64)}`;

/** A registry that serves `versions` per package and records every request. */
function registry(versions: Record<string, string[]>, status = 200) {
  const requests: { url: string; method: string }[] = [];
  const access: RegistryAccess = {
    token: async () => "token",
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? "GET" });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
      if (status !== 200) return new Response(null, { status });
      const listed = /packages\/([^/]+)\/versions\?/.exec(url);
      if (!listed?.[1]) return new Response(null, { status: 200 });
      const name = decodeURIComponent(listed[1]);
      const found = versions[name];
      if (!found) return new Response(null, { status: 404 });
      return Response.json({
        versions: found.map((version) => ({ name: `${API}/x/versions/${version}` })),
      });
    },
  };
  return { access, requests };
}

test("a candidate's images are named by run and candidate, as a registry path allows", () => {
  expect(candidateImageNames("batch-1A", "w0s1_Alpha")).toEqual({
    agent: "batch-1a/w0s1-alpha/agent",
    verifier: "batch-1a/w0s1-alpha/verifier",
  });
});

test("a finished candidate keeps only its accepted pair", async () => {
  const names = candidateImageNames("run", "cand");
  const { access, requests } = registry({
    [names.agent]: [digest("a"), digest("b")],
    [names.verifier]: [digest("c"), digest("d")],
  });
  const keep = [
    `${REPOSITORY}/${names.agent}@${digest("b")}`,
    `${REPOSITORY}/${names.verifier}@${digest("d")}`,
  ];
  expect(await discardCandidateImages(REPOSITORY, "run", "cand", keep, access)).toBe(2);
  expect(requests.filter((request) => request.method === "DELETE").map((r) => r.url)).toEqual([
    `${API}/${encodeURIComponent(names.agent)}/versions/${digest("a")}?force=true`,
    `${API}/${encodeURIComponent(names.verifier)}/versions/${digest("c")}?force=true`,
  ]);
  // A candidate that never built (or whose images are gone) has nothing to list.
  expect(await discardCandidateImages(REPOSITORY, "run", "other", [], registry({}).access)).toBe(0);
});

test("image removal deletes the version, tolerates a missing one, and refuses other registries", async () => {
  const image = `${REPOSITORY}/run/cand/agent@${digest("b")}`;
  await removeRegistryImage(image, registry({}).access);
  await removeRegistryImage(image, registry({}, 404).access);
  await expect(removeRegistryImage(image, registry({}, 403).access)).rejects.toThrow(
    "answered 403",
  );
  await expect(removeRegistryImage(`docker.io/library/rust@${digest("d")}`)).rejects.toThrow(
    "Not an Artifact Registry image",
  );
});

test("a rebuild's cleanup asks about every version, so a lone pushed agent goes too", async () => {
  const names = candidateImageNames("run", "cand");
  const { access, requests } = registry({ [names.agent]: [digest("a"), digest("b")] });
  // `b` is pinned elsewhere; `a` was pushed by a build that failed before reporting its pair.
  const pinned = async (version: string) => version === digest("b");
  expect(await discardCandidateImages(REPOSITORY, "run", "cand", pinned, access)).toBe(1);
  expect(requests.filter((request) => request.method === "DELETE").map((r) => r.url)).toEqual([
    `${API}/${encodeURIComponent(names.agent)}/versions/${digest("a")}?force=true`,
  ]);
});
