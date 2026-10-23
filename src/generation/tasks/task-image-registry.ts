import { googleAccessToken } from "../../lib/google-access-token.js";
import { parseImageReference } from "../task/image-registry.js";

/**
 * Deletes one exported image version from Artifact Registry. An image already gone is not an
 * error, so a retried removal finishes.
 */
export async function removeRegistryImage(
  image: string,
  token: () => Promise<string> = googleAccessToken,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(`${registryVersionUrl(image)}?force=true`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${await token()}` },
  });
  if (!response.ok && response.status !== 404)
    throw new Error(`Artifact Registry answered ${response.status} deleting a task image`);
}

/** Whether the registry holds this image by digest; any other answer is an error. */
export async function registryImageExists(
  image: string,
  token: () => Promise<string> = googleAccessToken,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const response = await fetcher(registryVersionUrl(image), {
    headers: { authorization: `Bearer ${await token()}` },
  });
  if (response.status === 404) return false;
  if (!response.ok)
    throw new Error(`Artifact Registry answered ${response.status} checking a task image`);
  return true;
}

function registryVersionUrl(image: string): string {
  const parsed = parseImageReference(image);
  const [project, repository, ...name] = parsed?.repository.split("/") ?? [];
  const location = parsed?.host.replace(/-docker\.pkg\.dev$/, "");
  if (!parsed?.digest || !project || !repository || !name.length || location === parsed.host)
    throw new Error("Not an Artifact Registry image by digest");
  return (
    `https://artifactregistry.googleapis.com/v1/projects/${project}/locations/${location}` +
    `/repositories/${repository}/packages/${encodeURIComponent(name.join("/"))}` +
    `/versions/${parsed.digest}`
  );
}
