import { z } from "zod";
import { apiHeaders, GitHubOAuthError } from "./oauth.js";
import type { ProvenanceMessage } from "./provenance.js";
import { extractGitHubPullRequestProvenance } from "./provenance.js";
import { githubRepository } from "./repository.js";

const query = `query BatchPullRequests($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first, after: $after, states: [MERGED], orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { number title body url isDraft additions deletions changedFiles author { login __typename } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
const pageSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequests: z.object({
        nodes: z.array(
          z.object({
            number: z.number().int().positive(),
            title: z.string(),
            body: z
              .string()
              .nullish()
              .transform((value) => value ?? ""),
            url: z.string().url(),
            isDraft: z.boolean(),
            additions: z
              .number()
              .nonnegative()
              .nullish()
              .transform((value) => value ?? 0),
            deletions: z
              .number()
              .nonnegative()
              .nullish()
              .transform((value) => value ?? 0),
            changedFiles: z
              .number()
              .int()
              .nonnegative()
              .nullish()
              .transform((value) => value ?? 0),
            author: z.object({ login: z.string(), __typename: z.string() }).nullable(),
          }),
        ),
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
      }),
    }),
  }),
});

/** Server-side metadata fetch; never launches gh or a Temporal activity. Limit is before filtering. */
export async function fetchBatchPullRequests(options: {
  repositoryUrl: string;
  token: string;
  limit?: number;
  endpoint?: string;
  signal?: AbortSignal;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<ProvenanceMessage[]> {
  const limit = options.limit ?? 500;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000)
    throw new Error("Invalid PR fetch limit");
  const [owner, name] = githubRepository(options.repositoryUrl).split("/");
  const rows: unknown[] = [];
  const cursors = new Set<string>();
  let after: string | null = null;
  while (rows.length < limit) {
    options.signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(30_000);
    const response = await (options.fetchImpl ?? fetch)(
      options.endpoint ?? "https://api.github.com/graphql",
      {
        method: "POST",
        redirect: "error",
        headers: { ...apiHeaders(options.token), "content-type": "application/json" },
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
        body: JSON.stringify({
          query,
          variables: { owner, name, first: Math.min(100, limit - rows.length), after },
        }),
      },
    );
    if (!response.ok)
      throw new GitHubOAuthError(`GitHub PR fetch failed (${response.status})`, response.status);
    const raw: unknown = await response.json();
    if (raw && typeof raw === "object" && "errors" in raw)
      throw new Error("GitHub PR query failed; no partial batch was created");
    const page = pageSchema.parse(raw).data.repository.pullRequests;
    if (page.nodes.length > Math.min(100, limit - rows.length))
      throw new Error("GitHub returned an oversized PR page");
    rows.push(
      ...page.nodes.map((pr) => ({
        ...pr,
        author: pr.author ? { ...pr.author, is_bot: pr.author.__typename === "Bot" } : null,
      })),
    );
    if (!page.pageInfo.hasNextPage || rows.length === limit) break;
    if (!page.nodes.length || !page.pageInfo.endCursor || cursors.has(page.pageInfo.endCursor))
      throw new Error("GitHub PR pagination did not advance");
    after = page.pageInfo.endCursor;
    cursors.add(after);
  }
  return extractGitHubPullRequestProvenance(JSON.stringify(rows), options.repositoryUrl);
}
