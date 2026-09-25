import { createHmac, timingSafeEqual } from "node:crypto";

/** One stored repository snapshot, named by key and pinned to its content. */
export interface SnapshotLink {
  readonly key: string;
  readonly sha256: string;
}

export const SNAPSHOT_LINK_PATH = "/api/snapshots/";

/**
 * A link a remote image build can `ADD` to fetch one snapshot. It is signed with the sandbox
 * secret and never expires, so the Dockerfile text, and with it the provider's layer cache, is
 * the same on every check of the same snapshot. The API trades it for a short-lived signed URL.
 */
export function snapshotLinkUrl(origin: string, link: SnapshotLink, secret: string): string {
  const payload = Buffer.from(JSON.stringify([link.key, link.sha256])).toString("base64url");
  return new URL(`${SNAPSHOT_LINK_PATH}${payload}.${signature(payload, secret)}`, origin).href;
}

/** The snapshot a link path names; undefined when it is malformed or forged. */
export function readSnapshotLink(pathname: string, secret: string): SnapshotLink | undefined {
  if (!pathname.startsWith(SNAPSHOT_LINK_PATH)) return undefined;
  const [payload, mac, ...rest] = pathname.slice(SNAPSHOT_LINK_PATH.length).split(".");
  if (!payload || !mac || rest.length > 0) return undefined;
  const expected = Buffer.from(signature(payload, secret));
  const actual = Buffer.from(mac);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
  try {
    const [key, sha256] = JSON.parse(Buffer.from(payload, "base64url").toString()) as unknown[];
    if (typeof key !== "string" || typeof sha256 !== "string") return undefined;
    return { key, sha256 };
  } catch {
    return undefined;
  }
}

// Scoped so a snapshot link can never pass for a sandbox grant signed with the same secret.
function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`snapshot:${payload}`).digest("base64url");
}
