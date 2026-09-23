import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { JobDone } from "../jobs.js";

/** The sandbox side of the callback API: uploads and events, authenticated by the job's grant. */
export class CallbackClient {
  constructor(
    private readonly base: string,
    private readonly token: string,
  ) {}

  post<T = unknown>(body: unknown, path = "events"): Promise<T> {
    return this.#json<T>(`/api/sandbox/${path}`, body);
  }

  /** Uploads one file under `name` and returns what `done` declares for it. */
  async upload(name: string, body: Buffer, contentType: string): Promise<JobDone["files"][string]> {
    const declared = {
      sha256: createHash("sha256").update(body).digest("hex"),
      sizeBytes: body.byteLength,
      contentType,
    };
    const target = await this.post<{ url: string; headers: Record<string, string> }>(
      { ...declared, name },
      "uploads",
    );
    const url = new URL(target.url, this.base);
    // Only our own API gets the grant; a signed storage URL carries its own authorization.
    const headers =
      url.origin === new URL(this.base).origin
        ? { ...target.headers, authorization: `Bearer ${this.token}` }
        : target.headers;
    const response = await withRetries(() =>
      fetch(url, { method: "PUT", headers, body: new Uint8Array(body) }),
    );
    // 412: an earlier try already created the object; `done` checks it holds these bytes.
    if (!response.ok && response.status !== 412) {
      throw new Error(`upload of ${name} failed: ${response.status}`);
    }
    return declared;
  }

  async uploadFile(name: string, path: string, contentType: string) {
    return await this.upload(name, await readFile(path), contentType);
  }

  async #json<T>(path: string, body: unknown): Promise<T> {
    const response = await withRetries(() =>
      fetch(new URL(path, this.base), {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    if (!response.ok)
      throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  }
}

/** Retries network errors and 5xx responses; a 4xx answer is final. */
async function withRetries(send: () => Promise<Response>): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await send();
      if (response.status < 500 || attempt >= 5) return response;
    } catch (error) {
      if (attempt >= 5) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1_000));
  }
}
