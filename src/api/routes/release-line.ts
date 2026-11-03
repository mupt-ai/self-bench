import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  type AnyLine,
  currentOf,
  headOf,
  type LinePayload,
  ReleaseConflict,
  type ReleaseRow,
  type ReleaseStore,
} from "../../db/releases.js";
import type { Org, User, UserStore } from "../../db/users.js";
import type { ModelSummaryReport } from "../../evaluation/model-summary.js";
import { previewRelease, type ReleaseInputs } from "../../public/release-build.js";
import { type ReleaseList, summaryOf, viewOf } from "../../public/release-views.js";
import { GitHubOAuthError } from "../../third_party/github/oauth.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson, trustedMutation } from "../http.js";

const releaseRequest = z
  .object({
    settings: z.array(z.string().min(1).max(4096)).min(1).max(500),
    /** The line's head as the releaser saw it; null for a first release. */
    head: z.uuid().nullable(),
    /** The fingerprint of the preview the releaser confirmed. */
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    /** Publish the tasks too, for anyone to browse and download on selfbench.dev. */
    publishTasks: z.boolean().optional(),
    /** Publish each setting's result and transcript on each task too; needs `publishTasks`. */
    publishTrials: z.boolean().optional(),
    /** Publish the latest Model Summaries report's sections on the released settings. */
    publishSummaries: z.boolean().optional(),
  })
  .strict();
export type ReleaseRequest = z.infer<typeof releaseRequest>;

/** A reply that ends a release: its status and body. */
export type Reply = readonly [status: number, body: unknown];

/** What a line's rule reads now: its inputs, and the Model Summaries report it may publish. */
interface Gathered {
  inputs: ReleaseInputs;
  report?: ModelSummaryReport;
}

/** A release ready to write: what its row stores, beyond the line, head and releaser. */
interface Built {
  fullName: string;
  hash: string;
  payload: LinePayload;
  detail: Record<string, unknown>;
}

/**
 * One kind of release line: a connected repository's, or a repository group's. The routes are
 * the same for both; a kind says only where its line is, what its rule reads, how a release of
 * it is checked and built, and what changes on selfbench.dev when it does.
 */
export interface LineKind<Subject> {
  /** `[org, key, section?, action?]` of the routes' paths. */
  readonly route: RegExp;
  readonly notFound: string;
  find(tenant: Org, key: string): Promise<Subject | undefined>;
  lineOf(tenant: Org, subject: Subject): AnyLine;
  gather(
    tenant: Org,
    subject: Subject,
    rows: readonly ReleaseRow<LinePayload>[],
  ): Promise<Gathered>;
  /** Checks the release live (GitHub, the request's options) and builds it, or refuses. */
  build(context: {
    tenant: Org;
    subject: Subject;
    user: User;
    token: string;
    body: ReleaseRequest;
    gathered: Gathered;
  }): Promise<Built | Reply>;
  /** Told after a release or withdrawal of the line, with the row it wrote or hid. */
  changed(tenant: Org, row: ReleaseRow<LinePayload>, user: User, released: boolean): void;
}

export interface LineRoutesOptions {
  readonly users: UserStore;
  readonly releases: Pick<ReleaseStore, "list" | "insert" | "withdraw">;
  readonly publicUrl: string;
  /** Origin of the results site, for links to released pages; null when there is none. */
  readonly resultsSiteUrl: string | null;
}

const isReply = (value: Built | Reply): value is Reply => Array.isArray(value);

/**
 * A line's Releases tab: its list, the preview a release must match, the release itself, and
 * withdrawals. A release names the head and preview fingerprint it was confirmed on, so a
 * teammate's release, or results that changed since, answer 409 with the fresh preview; the same
 * results released again write no row.
 */
export function createLineRoutes<Subject>(options: LineRoutesOptions, kind: LineKind<Subject>) {
  const { users, releases } = options;
  const list = (line: AnyLine) => releases.list<LinePayload>(line);
  const view = async (tenant: Org, subject: Subject, rows: readonly ReleaseRow<LinePayload>[]) => {
    const gathered = await kind.gather(tenant, subject, rows);
    return { gathered, view: viewOf(rows, previewRelease(gathered.inputs), gathered.report) };
  };

  const release = async (
    tenant: Org,
    subject: Subject,
    user: User,
    rows: readonly ReleaseRow<LinePayload>[],
    body: ReleaseRequest,
  ): Promise<Reply> => {
    const line = kind.lineOf(tenant, subject);
    const { gathered, view: fresh } = await view(tenant, subject, rows);
    const head = headOf(rows);
    // Someone released, or withdrew and released, since this person looked.
    if (body.head !== (head?.id ?? null))
      return [
        409,
        {
          error: head
            ? `${head.releasedByLogin} released at ${head.releasedAt}. Review the refreshed preview.`
            : "The release you saw is gone. Review the refreshed preview.",
          ...fresh,
        },
      ];
    // Results, tasks, or the current release changed since the preview was taken.
    if (body.fingerprint !== fresh.preview.fingerprint)
      return [
        409,
        {
          error:
            "Results, tasks, or the current release changed since you opened this. Review the refreshed preview.",
          ...fresh,
        },
      ];
    const token = await users.gitHubToken(user.githubId);
    if (!token) throw new GitHubOAuthError("no GitHub token stored for this user", 401);
    const built = await kind.build({ tenant, subject, user, token, body, gathered });
    if (isReply(built)) return built;
    // Unchanged results write no row: a double click or a retry. The line is read again after
    // the live checks, so a withdrawal meanwhile is not mistaken for "still public".
    const now = await list(line);
    const current = currentOf(now);
    if (current && current.hash === built.hash && headOf(now)?.id === head?.id)
      return [200, { unchanged: true, release: summaryOf(current, now) }];
    try {
      const row = await releases.insert<LinePayload>({
        line,
        fullName: built.fullName,
        publisherLogin: tenant.login,
        ...(head ? { predecessorId: head.id } : {}),
        releasedBy: { id: user.id, login: user.login },
        hash: built.hash,
        payload: built.payload,
        detail: built.detail,
      });
      kind.changed(tenant, row, user, true);
      return [201, { release: summaryOf(row, await list(line)) }];
    } catch (error) {
      if (!(error instanceof ReleaseConflict)) throw error;
      return [
        409,
        {
          error: "Someone else released first. Review the refreshed preview.",
          ...(await view(tenant, subject, await list(line))).view,
        },
      ];
    }
  };

  return {
    /** Answers the kind's release routes; true when the response was sent. */
    async handle(
      request: IncomingMessage,
      url: URL,
      response: ServerResponse,
      user: User,
    ): Promise<boolean> {
      const match = kind.route.exec(url.pathname);
      if (!match?.[1] || !match[2]) return false;
      response.setHeader("cache-control", "no-store");
      const [section, action] = [match[3], match[4]];
      const tenant = await tenantFor(users, user, match[1]);
      const subject = tenant ? await kind.find(tenant, match[2]) : undefined;
      if (!tenant || subject === undefined) {
        sendJson(response, 404, { error: kind.notFound });
        return true;
      }
      const mutation = request.method === "POST";
      if (mutation && !trustedMutation(request, options.publicUrl, user)) {
        sendJson(response, 403, { error: "Same-origin JSON request required" });
        return true;
      }
      const line = kind.lineOf(tenant, subject);
      const rows = await list(line);
      let reply: Reply;
      if (request.method === "GET" && !section) {
        const listed: ReleaseList = {
          releases: rows.map((row) => summaryOf(row, rows)),
          resultsSiteUrl: options.resultsSiteUrl,
        };
        reply = [200, listed];
      } else if (request.method === "GET" && section === "preview") {
        reply = [200, (await view(tenant, subject, rows)).view];
      } else if (mutation && section && section !== "preview" && action === "withdraw") {
        const withdrawn = z.uuid().safeParse(section).success
          ? await releases.withdraw<LinePayload>(line, section, user.login)
          : undefined;
        if (withdrawn) kind.changed(tenant, withdrawn, user, false);
        reply = withdrawn
          ? [200, { release: summaryOf(withdrawn, await list(line)) }]
          : [404, { error: "Release not found or already withdrawn" }];
      } else if (mutation && !section) {
        const body = releaseRequest.parse(
          JSON.parse((await readBody(request, 1024 * 1024)).toString()),
        );
        reply = await release(tenant, subject, user, rows, body);
      } else reply = [405, { error: "Method not allowed" }];
      sendJson(response, reply[0], reply[1]);
      return true;
    },
  };
}
