import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson } from "../api/http.js";
import type { ArtifactStore } from "../artifacts.js";
import type { User, UserStore } from "../auth/users.js";
import type { Database } from "../db/client.js";
import { sha256 } from "../hash.js";
import type { RepoStore } from "./repo-store.js";
import type { TaskStore, TaskUpsert } from "./task-store.js";
import { tenantFor } from "./tenant.js";
import { packageUpload, readUploadArchive, UPLOAD_LIMITS, UploadError } from "./upload-archive.js";
import { insertUploads, uploadPreview } from "./upload-store.js";
import { validateUpload } from "./upload-validate.js";

const route =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/uploads\/(preview|import|[a-z0-9-]+\/[^/]+\/(?:bundle|download))$/;
export interface UploadRoutesOptions {
  users: UserStore;
  repos: RepoStore;
  tasks: TaskStore;
  artifacts: ArtifactStore;
  db: Database;
  secret: string;
}
export interface UploadRoutes {
  handle(
    request: IncomingMessage,
    url: URL,
    response: ServerResponse,
    user: User,
  ): Promise<boolean>;
}

export function createUploadRoutes(options: UploadRoutesOptions): UploadRoutes {
  const { users, repos, tasks, artifacts, db, secret } = options;
  // Bound decompression/memory pressure across callers in this process. No staging storage to leak.
  let busy = false;
  const sign = (payload: string) =>
    createHmac("sha256", secret).update(payload).digest("base64url");
  return {
    async handle(request, url, response, user) {
      const match = route.exec(url.pathname);
      if (!match?.[1] || !match[2] || !match[3]) return false;
      const tenant = await tenantFor(users, user, match[1]);
      const repo = tenant ? await repos.find(tenant.id, match[2]) : undefined;
      if (!repo || !tenant) {
        sendJson(response, 404, { error: "repository is not connected here" });
        return true;
      }
      const action = match[3];
      if (request.method === "GET" && action.includes("/")) {
        const [runId, encodedId, leaf] = action.split("/");
        const task = await tasks.find(repo.id, runId ?? "", decodeURIComponent(encodedId ?? ""));
        if (!task?.bundleKey || task.pipelineStatus !== "uploaded") {
          sendJson(response, 404, { error: "uploaded task not found" });
          return true;
        }
        const stream = await artifacts.openReadByKey(task.bundleKey);
        if (!stream) {
          sendJson(response, 404, { error: "bundle not found" });
          return true;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > UPLOAD_LIMITS.compressed) throw new UploadError("Stored bundle exceeds limit");
          chunks.push(Buffer.from(chunk));
        }
        const bytes = Buffer.concat(chunks);
        if (leaf === "download") {
          response.writeHead(200, {
            "content-type": "application/gzip",
            "content-disposition": `attachment; filename="${task.taskId}.tar.gz"`,
            "cache-control": "no-store",
          });
          response.end(bytes);
        } else {
          const files = await readUploadArchive(bytes, { bytes: 0, entries: 0 });
          const { MAX_INLINE_TEXT_BYTES, looksLikeText } = await import("../viewer/task-files.js");
          sendJson(response, 200, {
            taskId: task.taskId,
            files: [...files].map(([path, data]) => ({
              path: path.replace(/^harbor-task\//, ""),
              sizeBytes: data.length,
              ...(data.length <= MAX_INLINE_TEXT_BYTES &&
              !/\.(gz|zip|tar|png|jpg|pdf)$/i.test(path) &&
              looksLikeText(data)
                ? { text: data.toString("utf8") }
                : {}),
            })),
          });
        }
        return true;
      }
      if (request.method !== "POST" || (action !== "preview" && action !== "import")) {
        sendJson(response, 405, { error: "method not allowed" });
        return true;
      }
      if (
        request.headers["content-type"] !== "application/octet-stream" ||
        request.headers["sec-fetch-site"] === "cross-site"
      ) {
        sendJson(response, 415, {
          error: "Send an archive as application/octet-stream from this site",
        });
        return true;
      }
      if (busy) {
        sendJson(response, 429, { error: "Another archive is being processed; retry shortly" });
        return true;
      }
      busy = true;
      try {
        const bytes = await readBody(request, UPLOAD_LIMITS.compressed);
        const digest = sha256(bytes);
        const validated = await validateUpload(bytes);
        const preview = uploadPreview(validated.tasks, await tasks.listForRepo(repo.id));
        if (action === "preview") {
          const payload = Buffer.from(
            JSON.stringify({
              repo: repo.id,
              user: user.id,
              digest,
              expires: Date.now() + 15 * 60_000,
              preview: sha256(JSON.stringify(preview)),
            }),
          ).toString("base64url");
          sendJson(response, 200, {
            tasks: preview,
            receipt: `${payload}.${sign(payload)}`,
            ...(validated.manifest ? { manifest: validated.manifest } : {}),
          });
          return true;
        }
        const receipt = request.headers["x-upload-preview"];
        const [payload, signature] = typeof receipt === "string" ? receipt.split(".") : [];
        const expected = payload ? sign(payload) : "";
        if (
          !payload ||
          !signature ||
          signature.length !== expected.length ||
          !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
        )
          throw new UploadError("Validate this file before importing");
        const claim = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
          repo: number;
          user: number;
          digest: string;
          expires: number;
          preview: string;
        };
        if (
          claim.repo !== repo.id ||
          claim.user !== user.id ||
          claim.digest !== digest ||
          claim.expires < Date.now()
        )
          throw new UploadError("Preview expired or belongs to another file or repository");
        if (claim.preview !== sha256(JSON.stringify(preview))) {
          sendJson(response, 409, {
            error: "Task conflicts changed. Validate again.",
            tasks: preview,
          });
          return true;
        }
        const eligible = validated.tasks.filter(
          (_task, i) => !preview[i]?.errors.length && !preview[i]?.conflicts.length,
        );
        if (!eligible.length) throw new UploadError("No valid non-conflicting tasks to import");
        const runId = `upload-${randomBytes(16).toString("hex")}`;
        const rows: TaskUpsert[] = [];
        for (const task of eligible) {
          const bundle = await packageUpload(task.files);
          if (bundle.length > UPLOAD_LIMITS.compressed)
            throw new UploadError("Repackaged task exceeds compressed limit");
          const key = `tenants/${tenant.id}/repos/${repo.id}/uploads/${runId}/${task.taskId}.tar.gz`;
          await artifacts.put(key, bundle, "application/gzip");
          rows.push({
            repoId: repo.id,
            runId,
            candidateId: task.taskId,
            taskId: task.taskId,
            difficulty: task.difficulty,
            pipelineStatus: "uploaded",
            stage: "uploaded",
            reason: "Uploaded / unverified. No environments, tests or solutions were executed.",
            bundleKey: key,
            definition: {
              ...task.metadata,
              uploadDigest: task.digest,
              uploadedBy: user.id,
              ...(validated.manifest ? { exportManifest: validated.manifest } : {}),
            },
          });
        }
        if (!(await insertUploads(db, repo.id, eligible, rows))) {
          sendJson(response, 409, { error: "Tasks changed during import. Validate again." });
          return true;
        }
        sendJson(response, 201, { imported: rows.length, runId });
        return true;
      } catch (error) {
        if (!(error instanceof UploadError)) throw error;
        sendJson(response, 400, { error: error.message });
        return true;
      } finally {
        busy = false;
      }
    },
  };
}
