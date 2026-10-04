import type { TaskEnvironment } from "../../contracts/index.js";

/** An OCI image reference split the way a registry addresses it. */
export interface ImageReference {
  /** The name as written, without tag or digest (`node`, `ghcr.io/org/app`). */
  readonly name: string;
  /** Registry API host; Docker Hub is `registry-1.docker.io`. */
  readonly host: string;
  /** Repository path on that host (`library/node`). */
  readonly repository: string;
  readonly tag?: string;
  readonly digest?: string;
}

const reference =
  /^(?<name>(?:[a-z0-9.-]+(?::[0-9]+)?\/)?(?:[a-z0-9._-]+\/)*[a-z0-9._-]+)(?::(?<tag>[A-Za-z0-9._-]+))?(?:@(?<digest>sha256:[a-f0-9]{64}))?$/;
const digestHeader = /^sha256:[a-f0-9]{64}$/;
const manifestTypes = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const requestTimeoutMs = 15_000;

export function parseImageReference(image: string): ImageReference | undefined {
  const match = reference.exec(image);
  const name = match?.groups?.name;
  if (!name) return undefined;
  const [first, ...rest] = name.split("/");
  // Docker's rule: the first component is a registry only when it looks like a host.
  const explicitHost =
    rest.length > 0 && first !== undefined && /[.:]|^localhost$/.test(first) ? first : undefined;
  const path = explicitHost ? rest.join("/") : name;
  const dockerHub = !explicitHost || ["docker.io", "index.docker.io"].includes(explicitHost);
  const { tag, digest } = match.groups ?? {};
  return {
    name,
    host: dockerHub ? "registry-1.docker.io" : (explicitHost as string),
    repository: dockerHub && !path.includes("/") ? `library/${path}` : path,
    ...(tag ? { tag } : {}),
    ...(digest ? { digest } : {}),
  };
}

/** The registry could not answer (network, rate limit, 5xx); retrying may succeed. */
export class RegistryUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegistryUnavailableError";
  }
}

export type ImageResolution =
  | { readonly ok: true; readonly image: string }
  | { readonly ok: false; readonly problem: string };

export interface RegistryOptions {
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}

/**
 * Asks the image's registry, anonymously as the Harbor providers pull, what the reference serves.
 * A tag is pinned to the digest it serves now; a digest is kept once the registry confirms it.
 * A reference the registry does not serve is a problem for the author; a registry that cannot
 * answer throws {@link RegistryUnavailableError}.
 */
export async function resolveImage(
  image: string,
  options: RegistryOptions = {},
): Promise<ImageResolution> {
  const parsed = parseImageReference(image);
  if (!parsed) return { ok: false, problem: `${image} is not a valid image reference` };
  const target = parsed.digest ?? parsed.tag ?? "latest";
  const response = await manifestRequest(parsed, target, "HEAD", options);
  const where = `${parsed.host === "registry-1.docker.io" ? "docker.io" : parsed.host}/${parsed.repository}`;
  const missing = (what: string): ImageResolution => {
    const retry =
      parsed.digest && parsed.tag
        ? `; name the tag alone (${parsed.name}:${parsed.tag}) and the worker pins it`
        : "";
    return {
      ok: false,
      problem: `${image}: ${where} does not serve ${what}, or needs credentials task images cannot use${retry}`,
    };
  };
  if ([401, 403, 404].includes(response.status)) {
    return missing(parsed.digest ? `digest ${parsed.digest}` : `tag ${target}`);
  }
  if (!response.ok) {
    throw new RegistryUnavailableError(`${where} answered ${response.status} for ${image}`);
  }
  if (parsed.digest) return { ok: true, image };

  let digest: string | null | undefined = response.headers.get("docker-content-digest");
  if (!digest) {
    const fetched = await manifestRequest(parsed, target, "GET", options);
    if ([401, 403, 404].includes(fetched.status)) return missing(`tag ${target}`);
    if (!fetched.ok) {
      throw new RegistryUnavailableError(`${where} answered ${fetched.status} for ${image}`);
    }
    digest = await manifestDigest(fetched);
  }
  if (!digest || !digestHeader.test(digest)) {
    throw new RegistryUnavailableError(`${where} returned no sha256 digest for ${image}`);
  }
  return { ok: true, image: `${parsed.name}:${target}@${digest}` };
}

/**
 * Pins every image the environment names. Problems name the field so the author can fix it;
 * the returned environment carries a digest on every image when there are none.
 */
export async function pinEnvironmentImages(
  environment: TaskEnvironment,
  options: RegistryOptions = {},
): Promise<{ environment: TaskEnvironment; problems: string[] }> {
  const [base, ...services] = await Promise.all([
    resolveImage(environment.baseImage, options),
    ...environment.services.map((service) => resolveImage(service.image, options)),
  ]);
  const problems: string[] = [];
  const pinned = (result: ImageResolution | undefined, scope: string, fallback: string) => {
    if (result?.ok) return result.image;
    if (result) problems.push(`${scope} ${result.problem}`);
    return fallback;
  };
  return {
    environment: {
      ...environment,
      baseImage: pinned(base, "environment baseImage", environment.baseImage),
      services: environment.services.map((service, index) => ({
        ...service,
        image: pinned(services[index], `service ${service.name} image`, service.image),
      })),
    },
    problems,
  };
}

/** An image's config as its manifest names it: what a container of it starts with. */
export interface ImageConfig {
  readonly Env?: readonly string[];
  readonly User?: string;
  readonly WorkingDir?: string;
}

/**
 * The linux/amd64 config of a digest-pinned image, read anonymously from its registry as
 * {@link resolveImage} reads its manifest.
 */
export async function imageConfig(
  image: string,
  options: RegistryOptions = {},
): Promise<ImageConfig> {
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

async function manifestRequest(
  image: ImageReference,
  target: string,
  method: "HEAD" | "GET",
  options: RegistryOptions,
): Promise<Response> {
  return await registryRequest(
    image,
    `manifests/${target}`,
    method,
    { Accept: manifestTypes },
    options,
  );
}

async function registryRequest(
  image: ImageReference,
  path: string,
  method: "HEAD" | "GET",
  headers: Record<string, string>,
  options: RegistryOptions,
): Promise<Response> {
  const url = `https://${image.host}/v2/${image.repository}/${path}`;
  // Registries redirect blobs to their storage; manifests are answered in place.
  const redirect = path.startsWith("blobs/") ? "follow" : "error";
  const first = await send(url, { method, headers, redirect }, options);
  if (first.status !== 401) return first;
  const token = await bearerToken(first.headers.get("www-authenticate"), image, options);
  if (!token) return first;
  return await send(
    url,
    { method, headers: { ...headers, Authorization: `Bearer ${token}` }, redirect },
    options,
  );
}

/** An anonymous pull token from the registry's Bearer challenge. */
async function bearerToken(
  challenge: string | null,
  image: ImageReference,
  options: RegistryOptions,
): Promise<string | undefined> {
  if (!challenge || !/^Bearer\s/i.test(challenge)) return undefined;
  const parameters = Object.fromEntries(
    [...challenge.matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key, value]),
  );
  if (!parameters.realm) return undefined;
  const url = new URL(parameters.realm);
  if (url.protocol !== "https:") return undefined;
  if (parameters.service) url.searchParams.set("service", parameters.service);
  url.searchParams.set("scope", parameters.scope ?? `repository:${image.repository}:pull`);
  const response = await send(url.toString(), { method: "GET" }, options);
  if (response.status === 429 || response.status >= 500) {
    throw new RegistryUnavailableError(`${url.host} answered ${response.status} for a pull token`);
  }
  if (!response.ok) return undefined;
  const body = (await response.json().catch(() => ({}))) as {
    token?: unknown;
    access_token?: unknown;
  };
  const token = body.token ?? body.access_token;
  return typeof token === "string" && token ? token : undefined;
}

async function manifestDigest(response: Response): Promise<string | undefined> {
  const bytes = await response.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0"));
  return `sha256:${hex.join("")}`;
}

async function send(url: string, init: RequestInit, options: RegistryOptions): Promise<Response> {
  const timeout = AbortSignal.timeout(requestTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    return await (options.fetch ?? fetch)(url, { redirect: "error", ...init, signal });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new RegistryUnavailableError(`could not reach ${new URL(url).host}`, { cause: error });
  }
}
