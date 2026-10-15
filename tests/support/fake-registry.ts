import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const sha256 = (data: Uint8Array) =>
  `sha256:${createHash("sha256").update(data).digest("hex")}`;

/**
 * Registry stand-in for the export's pushes: chunked and monolithic blob uploads, manifests. The
 * worker refreshes the push token while the layer streams, so the token in `tokenFile` changes
 * after the layer upload and every later request must carry the new one. The server joins
 * `servers` for the caller to close.
 */
export async function fakeRegistry(
  tokenFile: string,
  servers: Server[],
): Promise<{
  api: string;
  blobs: Map<string, Buffer>;
  manifests: Map<string, Buffer>;
  /** Blob uploads opened, finished or not. */
  uploads: Map<string, Buffer[]>;
}> {
  const blobs = new Map<string, Buffer>();
  const manifests = new Map<string, Buffer>();
  const uploads = new Map<string, Buffer[]>();
  let token = "push-token";
  await writeFile(tokenFile, token);
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(request.url ?? "/", "http://localhost");
    expect(request.headers.authorization).toBe(
      `Basic ${Buffer.from(`oauth2accesstoken:${token}`).toString("base64")}`,
    );
    if (request.method === "POST" && url.pathname.endsWith("/blobs/uploads/")) {
      const id = String(uploads.size);
      uploads.set(id, []);
      response.writeHead(202, { location: `/upload/${id}?state=x` }).end();
    } else if (request.method === "PATCH" && url.pathname.startsWith("/upload/")) {
      uploads.get(url.pathname.slice(8))?.push(body);
      token = "fresh-token";
      await writeFile(tokenFile, token);
      response.writeHead(202, { location: `${url.pathname}?state=y` }).end();
    } else if (request.method === "PUT" && url.pathname.startsWith("/upload/")) {
      const data = Buffer.concat([...(uploads.get(url.pathname.slice(8)) ?? []), body]);
      expect(sha256(data)).toBe(url.searchParams.get("digest") ?? "");
      blobs.set(url.searchParams.get("digest") ?? "", data);
      response.writeHead(201).end();
    } else if (request.method === "PUT" && url.pathname.includes("/manifests/")) {
      expect(request.headers["content-type"]).toBe("application/vnd.oci.image.manifest.v1+json");
      manifests.set(url.pathname, body);
      response.writeHead(201).end();
    } else response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    api: `http://127.0.0.1:${port}/v2/selfbench-test/selfbench-tasks`,
    blobs,
    manifests,
    uploads,
  };
}
