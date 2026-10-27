import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createPrioritySelectorBackend, createRequestHandler } from "@mupt-ai/dari-gateway";
import { GATEWAY_PATH } from "./connection.js";
import { type SelfBenchGatewayDeps, selfBenchPlatform } from "./platform.js";
import { readTrialKey } from "./trial-key.js";

/**
 * The model gateway every trial's agent calls, served by the API under GATEWAY_PATH. Returns a
 * handler that answers the request and resolves true when the path is the gateway's.
 */
export function gatewayRoute(deps: SelfBenchGatewayDeps) {
  // A strict router never runs a selector; the priority backend is the inert one.
  const handle = createRequestHandler({
    platform: selfBenchPlatform(deps),
    selectorBackend: createPrioritySelectorBackend(),
  });
  return async (request: IncomingMessage, url: URL, response: ServerResponse): Promise<boolean> => {
    if (url.pathname !== GATEWAY_PATH && !url.pathname.startsWith(`${GATEWAY_PATH}/`)) return false;
    const target = new URL(url.pathname.slice(GATEWAY_PATH.length) || "/", url);
    target.search = url.search;
    const abort = new AbortController();
    response.on("close", () => abort.abort());
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const token = request.headers["x-api-key"] ?? request.headers.authorization?.slice(7) ?? "";
    const judge = hasBody ? readTrialKey(String(token), deps.secret)?.judge : undefined;
    const answer = await handle(
      new Request(target, {
        method: request.method,
        headers: Object.entries(request.headers).flatMap(([name, value]) =>
          value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((v) => [name, v]),
        ) as [string, string][],
        ...(hasBody
          ? {
              body: judge
                ? judgeBody(Buffer.concat(await request.toArray()), judge.provider)
                : (Readable.toWeb(request) as unknown as ReadableStream),
              duplex: "half",
            }
          : {}),
        signal: abort.signal,
      } as RequestInit),
    );
    response.writeHead(answer.status, Object.fromEntries(answer.headers));
    if (!answer.body) response.end();
    else await pipeline(Readable.fromWeb(answer.body as unknown as NodeReadableStream), response);
    return true;
  };
}

/**
 * A judge names its model as its provider's API would (`gpt-5-mini`, or `openai/gpt-5-mini`
 * through a library): the gateway serves the provider's models as `dari/model/<provider>/<id>`.
 */
function judgeBody(body: Buffer, provider: string): Buffer | string {
  try {
    const payload = JSON.parse(body.toString());
    const model = payload?.model;
    if (typeof model !== "string" || model.startsWith("dari/model/")) return body;
    const id = model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
    return JSON.stringify({ ...payload, model: `dari/model/${provider}/${id}` });
  } catch {
    return body;
  }
}
