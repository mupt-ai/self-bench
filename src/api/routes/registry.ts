import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type RegistryGrant, readRegistryGrant } from "../../sandbox/registry-grant.js";

// The OCI distribution grammar for repository names; never `..` or an empty segment.
const COMPONENT = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const ROUTE = new RegExp(
  `^/v2/(${COMPONENT}(?:/${COMPONENT})*)/(manifests|blobs)/(sha256:[0-9a-f]{64})$`,
);
const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const PASSED_HEADERS = ["content-type", "content-length", "docker-content-digest", "etag"];
const CLOSURE_CACHE = 256;

/** Artifact Registry repository the endpoint serves from, with the API's own credentials. */
export interface TaskImageUpstream {
  /** `<region>-docker.pkg.dev/<project>/<repository>` */
  readonly repository: string;
  readonly token: () => Promise<string>;
  readonly fetch?: typeof fetch;
}

/**
 * A read-only registry for task images, so a sandbox provider in a user's own account can pull a
 * task's verified image without holding a credential for the whole repository. The provider logs
 * in with a pull grant (see registry-grant.ts) and may fetch only the manifests and blobs of the
 * images it names, by digest. Blob requests are redirected to Artifact Registry's own one-blob
 * download URLs, so image layers never stream through the API.
 */
export function taskImageRegistry(upstream: TaskImageUpstream) {
  const call = upstream.fetch ?? fetch;
  const [host, ...path] = upstream.repository.split("/");
  const base = `https://${host}/v2/${path.join("/")}`;
  // Every digest an image's manifest names, so a grant reaches exactly that image's content.
  const closures = new Map<string, Promise<Set<string>>>();

  async function get(name: string, kind: string, digest: string, init: RequestInit = {}) {
    const token = await upstream.token();
    return await call(`${base}/${name}/${kind}/${digest}`, {
      ...init,
      headers: {
        authorization: `Basic ${Buffer.from(`oauth2accesstoken:${token}`).toString("base64")}`,
        ...(kind === "manifests" ? { accept: MANIFEST_TYPES } : {}),
        ...init.headers,
      },
    });
  }

  async function resolve(name: string, digest: string): Promise<Set<string>> {
    const found = new Set<string>([digest]);
    const pending = [digest];
    for (let next = pending.pop(); next; next = pending.pop()) {
      const response = await get(name, "manifests", next);
      if (!response.ok) throw new Error(`manifest ${name}@${next}: HTTP ${response.status}`);
      const manifest = (await response.json()) as {
        manifests?: { digest: string }[];
        config?: { digest: string };
        layers?: { digest: string }[];
      };
      for (const child of manifest.manifests ?? []) {
        if (!found.has(child.digest)) pending.push(child.digest);
        found.add(child.digest);
      }
      for (const blob of [manifest.config, ...(manifest.layers ?? [])])
        if (blob) found.add(blob.digest);
    }
    return found;
  }

  function closure(name: string, digest: string): Promise<Set<string>> {
    const key = `${name}@${digest}`;
    let cached = closures.get(key);
    if (!cached) {
      cached = resolve(name, digest);
      cached.catch(() => closures.delete(key));
      if (closures.size >= CLOSURE_CACHE) {
        const oldest = closures.keys().next().value;
        if (oldest) closures.delete(oldest);
      }
      closures.set(key, cached);
    }
    return cached;
  }

  async function permits(grant: RegistryGrant, name: string, digest: string): Promise<boolean> {
    for (const image of grant.images) {
      const [granted, root] = image.split("@");
      if (granted === name && root && (await closure(name, root)).has(digest)) return true;
    }
    return false;
  }

  return async function handle(
    request: IncomingMessage,
    url: URL,
    response: ServerResponse,
    secret: string,
  ): Promise<boolean> {
    if (url.pathname !== "/v2" && !url.pathname.startsWith("/v2/")) return false;
    const headers = { "docker-distribution-api-version": "registry/2.0" };
    if (request.method !== "GET" && request.method !== "HEAD") {
      registryError(response, 405, "UNSUPPORTED", "read-only registry", headers);
      return true;
    }
    const grant = presentedGrant(request, secret);
    if (!grant) {
      registryError(response, 401, "UNAUTHORIZED", "authentication required", {
        ...headers,
        "www-authenticate": 'Basic realm="SelfBench"',
      });
      return true;
    }
    if (url.pathname === "/v2" || url.pathname === "/v2/") {
      response.writeHead(200, { ...headers, "content-type": "application/json" }).end("{}");
      return true;
    }
    const match = ROUTE.exec(url.pathname);
    const [, name, kind, digest] = match ?? [];
    let permitted = false;
    try {
      permitted = !!name && !!kind && !!digest && (await permits(grant, name, digest));
    } catch (error) {
      // The granted image's manifests are unreadable upstream; a pull may retry this.
      registryError(response, 502, "UNAVAILABLE", String(error), headers);
      return true;
    }
    if (!name || !kind || !digest || !permitted) {
      const code = kind === "blobs" ? "BLOB_UNKNOWN" : "MANIFEST_UNKNOWN";
      registryError(response, 404, code, "not found", headers);
      return true;
    }
    const upstreamResponse = await get(name, kind, digest, {
      method: request.method,
      redirect: "manual",
    });
    const location = upstreamResponse.headers.get("location");
    if (kind === "blobs" && location && upstreamResponse.status >= 300) {
      // Artifact Registry's download URL is a capability for this one blob.
      const target = new URL(location, `https://${host}/`).href;
      response.writeHead(307, { ...headers, location: target, "cache-control": "no-store" }).end();
      return true;
    }
    if (!upstreamResponse.ok) {
      registryError(
        response,
        502,
        "UNAVAILABLE",
        `upstream HTTP ${upstreamResponse.status}`,
        headers,
      );
      return true;
    }
    const passed: Record<string, string> = { ...headers };
    for (const header of PASSED_HEADERS) {
      const value = upstreamResponse.headers.get(header);
      if (value) passed[header] = value;
    }
    response.writeHead(200, passed);
    if (request.method === "HEAD" || !upstreamResponse.body) {
      response.end();
      return true;
    }
    await pipeline(Readable.fromWeb(upstreamResponse.body as never), response);
    return true;
  };
}

function presentedGrant(request: IncomingMessage, secret: string): RegistryGrant | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString();
  const password = decoded.slice(decoded.indexOf(":") + 1);
  return readRegistryGrant(password, secret);
}

function registryError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  headers: Record<string, string>,
): void {
  response
    .writeHead(status, { ...headers, "content-type": "application/json" })
    .end(JSON.stringify({ errors: [{ code, message }] }));
}
