import { createHmac, timingSafeEqual } from "node:crypto";

/** The registry username every pull grant is presented with; the grant itself is the password. */
export const REGISTRY_USERNAME = "selfbench";

/**
 * Lets a sandbox provider pull a few task images through the API's registry endpoint and nothing
 * else. Each image is `<name>@sha256:<digest>` inside SelfBench's task image repository. Signed
 * with the sandbox secret, so nothing is stored server-side; it lasts long enough for a provider
 * to pull a large image, and a provider that caches the image never presents it again.
 */
export interface RegistryGrant {
  readonly images: readonly string[];
  readonly expiresAt: number;
}

export const REGISTRY_GRANT_TTL_MS = 3 * 60 * 60 * 1000;

/** `<repository>/<name>@sha256:…` as the `<name>@sha256:…` a grant and the API use. */
export function repositoryImage(repository: string, image: string): string {
  if (!image.startsWith(`${repository}/`) || !image.includes("@sha256:"))
    throw new Error(`${image} is not an image in ${repository}`);
  return image.slice(repository.length + 1);
}

/**
 * The reference a sandbox provider pulls `image` (`<name>@sha256:…`) by through the API's
 * registry endpoint at `origin`, the public URL sandboxes call back to.
 */
export function proxiedImage(origin: string, image: string): string {
  return `${new URL(origin).host}/${image}`;
}

export function signRegistryGrant(grant: RegistryGrant, secret: string): string {
  const payload = Buffer.from(JSON.stringify([grant.images, grant.expiresAt])).toString(
    "base64url",
  );
  return `${payload}.${signature(payload, secret)}`;
}

/** The grant a password carries; undefined when it is malformed, forged, or expired. */
export function readRegistryGrant(
  token: string,
  secret: string,
  now = Date.now(),
): RegistryGrant | undefined {
  const [payload, mac, ...rest] = token.split(".");
  if (!payload || !mac || rest.length > 0) return undefined;
  const expected = Buffer.from(signature(payload, secret));
  const actual = Buffer.from(mac);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
  try {
    const [images, expiresAt] = JSON.parse(
      Buffer.from(payload, "base64url").toString(),
    ) as unknown[];
    if (!Array.isArray(images) || !images.every((image) => typeof image === "string"))
      return undefined;
    if (typeof expiresAt !== "number" || expiresAt <= now) return undefined;
    return { images, expiresAt };
  } catch {
    return undefined;
  }
}

// Scoped so a pull grant can never pass for a sandbox grant or snapshot link signed with the
// same secret.
function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`registry:${payload}`).digest("base64url");
}
