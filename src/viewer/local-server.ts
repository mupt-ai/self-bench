import { createServer } from "node:http";
import { resolve } from "node:path";
import { sendApiError, sendJson, sendReviewAsset } from "../api/http.js";
import { readTaskDirectory, resolveTaskDirectory, scanHarborTasks } from "./task-files.js";
import type { ViewerInfo } from "./types.js";

export interface ViewServerOptions {
  readonly root: string;
  readonly host: string;
  readonly port: number;
}

export interface ViewServer {
  readonly url: string;
  readonly stop: () => Promise<void>;
}

export async function startViewServer(options: ViewServerOptions): Promise<ViewServer> {
  const root = resolve(options.root);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method !== "GET") {
        sendJson(response, 405, { error: "method not allowed" });
        return;
      }
      if (url.pathname === "/" || url.pathname.startsWith("/assets/")) {
        await sendReviewAsset(response, url.pathname);
        return;
      }
      if (url.pathname === "/healthz") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (url.pathname === "/v1/viewer") {
        sendJson(response, 200, { modes: ["local"], root } satisfies ViewerInfo);
        return;
      }
      if (url.pathname === "/v1/local/tasks") {
        sendJson(response, 200, await scanHarborTasks(root));
        return;
      }
      if (url.pathname === "/v1/local/task") {
        const taskId = url.searchParams.get("id") ?? "";
        let directory: string;
        try {
          directory = resolveTaskDirectory(root, taskId);
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : "bad id" });
          return;
        }
        sendJson(response, 200, await readTaskDirectory(directory, taskId));
        return;
      }
      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      sendApiError(response, error);
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://${options.host}:${port}`,
    stop: () =>
      new Promise<void>((resolveStop, reject) =>
        server.close((error) => (error ? reject(error) : resolveStop())),
      ),
  };
}
