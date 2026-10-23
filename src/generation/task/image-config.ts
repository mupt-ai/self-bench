import {
  manifestRequest,
  parseImageReference,
  type RegistryOptions,
  RegistryUnavailableError,
  registryRequest,
} from "./image-registry.js";

/** An image's config as its manifest names it: what a container of it starts with. */
export interface ImageConfig {
  readonly Env?: readonly string[];
  readonly User?: string;
  readonly WorkingDir?: string;
}

/**
 * The linux/amd64 config of a digest-pinned image, read anonymously from its registry as
 * `resolveImage` reads its manifest.
 */
async function imageConfig(image: string, options: RegistryOptions = {}): Promise<ImageConfig> {
  const parsed = parseImageReference(image);
  if (!parsed?.digest) throw new Error(`${image} is not pinned to a digest`);
  const json = async (response: Response) => {
    if (!response.ok) {
      throw new RegistryUnavailableError(`${parsed.host} answered ${response.status} for ${image}`);
    }
    return (await response.json()) as Record<string, unknown>;
  };
  let manifest = await json(await manifestRequest(parsed, parsed.digest, "GET", options));
  if (Array.isArray(manifest.manifests)) {
    const platform = (
      manifest.manifests as { digest: string; platform?: Record<string, string> }[]
    ).find((child) => child.platform?.os === "linux" && child.platform.architecture === "amd64");
    if (!platform) throw new Error(`${image} has no linux/amd64 image`);
    manifest = await json(await manifestRequest(parsed, platform.digest, "GET", options));
  }
  const config = (manifest.config as { digest?: string } | undefined)?.digest;
  if (!config) throw new Error(`${image} names no config`);
  const blob = await json(await registryRequest(parsed, `blobs/${config}`, "GET", {}, options));
  return (blob.config as ImageConfig | undefined) ?? {};
}

const CACHED_CONFIGS = 256;
const configs = new Map<string, Promise<ImageConfig>>();

/**
 * {@link imageConfig}, asked once per digest for the life of the process. A digest's config never
 * changes, and tasks share a handful of base images, so exporting many tasks stays well inside
 * Docker Hub's anonymous pull limit. A failed lookup is forgotten so a later one asks again.
 */
export function cachedImageConfig(image: string): Promise<ImageConfig> {
  const cached = configs.get(image);
  if (cached) return cached;
  const lookup = imageConfig(image);
  lookup.catch(() => configs.delete(image));
  if (configs.size >= CACHED_CONFIGS) configs.delete(configs.keys().next().value as string);
  configs.set(image, lookup);
  return lookup;
}
