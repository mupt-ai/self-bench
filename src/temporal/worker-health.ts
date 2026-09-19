import { createServer } from "node:http";

/** Container-local readiness; a busy worker need not have recent task-queue polls. */
export function createWorkerHealthServer(getState: () => string) {
  return createServer((request, response) => {
    response.statusCode = request.url !== "/healthz" ? 404 : getState() === "RUNNING" ? 200 : 503;
    response.end();
  });
}
