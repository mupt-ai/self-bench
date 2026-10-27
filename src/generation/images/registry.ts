import { googleAccessToken } from "../../lib/google-access-token.js";
import { parseImageReference } from "../task/image-registry.js";

/** How the worker reaches Artifact Registry; tests replace both. */
export interface RegistryAccess {
  readonly token: () => Promise<string>;
  readonly fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

const GOOGLE: RegistryAccess = {
  token: googleAccessToken,
  fetch: (input, init) => fetch(input, init),
};

/** The repository path of a run's candidate's images: `<runId>/<candidateId>/{agent,verifier}`. */
export function candidateImageNames(
  runId: string,
  candidateId: string,
): { readonly agent: string; readonly verifier: string } {
  const path = [runId, candidateId].map(imageComponent).join("/");
  return { agent: `${path}/agent`, verifier: `${path}/verifier` };
}

/** Lowercase letters and digits joined by single separators, as a registry path component. */
function imageComponent(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 100)
      .replace(/^-+|-+$/g, "") || "x"
  );
}

/**
 * Deletes one image version from Artifact Registry. An image already gone is not an error, so a
 * retried removal finishes.
 */
export async function removeRegistryImage(
  image: string,
  access: RegistryAccess = GOOGLE,
): Promise<void> {
  const response = await access.fetch(`${versionUrl(image)}?force=true`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${await access.token()}` },
  });
  if (!response.ok && response.status !== 404)
    throw new Error(`Artifact Registry answered ${response.status} deleting a task image`);
}

/**
 * Deletes every image a candidate built except `keep` (its accepted pair, or a test of each digest):
 * the attempts verification rejected, or all of them for a candidate that was not accepted. Returns
 * how many went.
 */
export async function discardCandidateImages(
  repository: string,
  runId: string,
  candidateId: string,
  keep: readonly string[] | ((digest: string) => Promise<boolean>),
  access: RegistryAccess = GOOGLE,
): Promise<number> {
  const kept = new Set(
    typeof keep === "function" ? [] : keep.map((image) => image.slice(image.indexOf("@") + 1)),
  );
  const keeps = typeof keep === "function" ? keep : async (digest: string) => kept.has(digest);
  let removed = 0;
  for (const name of Object.values(candidateImageNames(runId, candidateId))) {
    const image = `${repository}/${name}`;
    for (const digest of await versions(image, access)) {
      if (await keeps(digest)) continue;
      await removeRegistryImage(`${image}@${digest}`, access);
      removed += 1;
    }
  }
  return removed;
}

/** The digests of every version of one image; none when the registry never had it. */
async function versions(image: string, access: RegistryAccess): Promise<string[]> {
  const digests: string[] = [];
  let page = "";
  do {
    const url = new URL(packageUrl(image, `/versions`));
    url.searchParams.set("pageSize", "1000");
    if (page) url.searchParams.set("pageToken", page);
    const response = await access.fetch(url, {
      headers: { authorization: `Bearer ${await access.token()}` },
    });
    if (response.status === 404) return digests;
    if (!response.ok)
      throw new Error(`Artifact Registry answered ${response.status} listing task images`);
    const body = (await response.json()) as {
      versions?: { name?: string }[];
      nextPageToken?: string;
    };
    for (const version of body.versions ?? []) {
      const digest = version.name?.slice(version.name.lastIndexOf("/") + 1);
      if (digest && /^sha256:[0-9a-f]{64}$/.test(digest)) digests.push(digest);
    }
    page = body.nextPageToken ?? "";
  } while (page);
  return digests;
}

function versionUrl(image: string): string {
  const parsed = parseImageReference(image);
  if (!parsed?.digest) throw new Error("Not an Artifact Registry image by digest");
  return packageUrl(image, `/versions/${parsed.digest}`);
}

/** `<package URL><suffix>` for an image (by name or digest) in an Artifact Registry repository. */
function packageUrl(image: string, suffix: string): string {
  const parsed = parseImageReference(image);
  const [project, repository, ...name] = parsed?.repository.split("/") ?? [];
  const location = parsed?.host.replace(/-docker\.pkg\.dev$/, "");
  if (!parsed || !project || !repository || !name.length || location === parsed.host)
    throw new Error("Not an Artifact Registry image");
  return (
    `https://artifactregistry.googleapis.com/v1/projects/${project}/locations/${location}` +
    `/repositories/${repository}/packages/${encodeURIComponent(name.join("/"))}${suffix}`
  );
}
