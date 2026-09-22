# HTTP API reference

Everything the selfbench.dev site can do is available over HTTP. This document lists every route, how to authenticate, and what each call expects. The CLI-facing run routes under `/v1` are shared with the site and are also listed at the end.

All responses are JSON unless noted. Errors carry `{ "error": "message" }` and sometimes a `code`. Paths that contain a repository take the connected repository's `owner/name` as two segments, so `/api/orgs/mupt-ai/repos/mupt-ai/self-bench/tasks` lists the tasks of `mupt-ai/self-bench` inside the `mupt-ai` organization. `:org` is a GitHub organization login, or your own login for the personal account; it is matched case-insensitively.

## Authentication

There are three ways to authenticate. Every `/api` and `/v1` route requires one of them; only `/healthz`, `/v1/viewer`, and `POST /api/stripe/webhook` are open.

| Method | Header | Reaches |
| --- | --- | --- |
| API key | `Authorization: Bearer sbk_…` or `X-API-Key: sbk_…` | Every `/api` and `/v1` route, as the key's owner |
| Browser session | `selfbench_session` cookie set by GitHub sign-in | Every `/api` and `/v1` route |
| Operator token | `Authorization: Bearer $SELFBENCH_API_TOKEN` | `/v1` run routes only (no user identity) |

### API keys

Create keys under **Settings → API Keys** in the site. A key acts as the user who created it: it sees every organization that user belongs to, and organization roles still apply (only organization admins can change credentials, for example). The secret starts with `sbk_` and is shown exactly once; the server stores only a SHA-256 hash of it.

Each key has a scope:

- `write` (default) may call anything the user can.
- `read` may only send `GET` requests. Any other method is refused with `403 {"error":"this API key is read-only"}`.

Revoke a key from the same page, or with `DELETE /api/api-keys/:id`. A revoked or unknown key answers `401 {"error":"invalid API key","code":"invalid_api_key"}`. Creating and revoking keys requires a browser session; a key cannot mint further keys.

Browser sessions are protected against cross-site requests: state-changing calls from a cookie session must be same-origin JSON requests. API-key requests are exempt, so scripts do not need to send an `Origin` header.

```bash
export SELFBENCH_API_KEY=sbk_…
curl -H "Authorization: Bearer $SELFBENCH_API_KEY" https://selfbench.dev/api/me
curl -H "X-API-Key: $SELFBENCH_API_KEY" \
  -H "content-type: application/json" \
  -d '{"fullName":"mupt-ai/self-bench"}' \
  https://selfbench.dev/api/orgs/mupt-ai/repos
```

## Account and keys

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/me` | The caller: `user`, `orgs` (with `kind` and `role`), `auth` (`session` or `api-key`), and `apiKey` (`name`, `scope`) when a key was used |
| `GET` | `/api/api-keys` | Active keys of the caller: `id`, `name`, `prefix`, `scope`, `createdAt`, `lastUsedAt` |
| `POST` | `/api/api-keys` | Body `{ "name": "CI", "scope": "read" \| "write" }`. Answers `201 { key, secret }`; the secret is never returned again. Browser session only |
| `DELETE` | `/api/api-keys/:id` | Revokes a key. Browser session only |

## GitHub discovery

These call GitHub with the user's stored OAuth token.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/orgs/:org/github-repos` | Repositories the user can see in that tenant, most recently pushed first (`repos`) |
| `GET` | `/api/github-repos/:owner/:name` | One repository plus `mergedPullRequests` in the last year and the `since` date |

## Connected repositories

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/orgs/:org/repos` | Connected repositories (`repos`), newest first |
| `POST` | `/api/orgs/:org/repos` | Body `{ "fullName": "owner/name" }`. Connects a repository; `201` when new, `200` when already connected. Organizations may connect any public repository but only their own private ones |
| `GET` | `/api/orgs/:org/repos/:owner/:name` | One connected repository (`repo`) |
| `PATCH` | `/api/orgs/:org/repos/:owner/:name` | Body `{ "continuous": true \| false }`. Toggles building tasks as pull requests merge |
| `DELETE` | `/api/orgs/:org/repos/:owner/:name` | Disconnects the repository |
| `GET` | `/api/orgs/:org/task-counts` | Per-repository `total`, `accepted`, `needsReview`, `rejected`, and `lastPr`, keyed by full name |

A repository object has `fullName`, `defaultBranch`, `private`, `continuous`, `connectedBy`, and `connectedAt`.

## Pull requests and tasks

All paths below are relative to `/api/orgs/:org/repos/:owner/:name`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/pull-requests?page=N` | Merged pull requests from GitHub, twenty per page: `pullRequests`, `nextPage`, `incomplete` |
| `GET` | `/generation-options` | What a generation run may use: `models`, `sandboxes` (hosted providers only, never `docker`), `credentials`, and whether generation is `available` |
| `POST` | `/tasks/from-pr` | Body `{ "pr": 123 \| "https://github.com/owner/name/pull/123", "generation"?: GenerationSettings }`. Builds one task from a merged pull request; `201 { task }` |
| `GET` | `/tasks` | Every task of the repository (`tasks`), refreshed against running workflows |
| `GET` | `/tasks/:runId/:taskId` | One task, by task id or candidate id (`task`) |
| `DELETE` | `/tasks/:runId/:taskId` | Removes a finished task; `409` while it is still generating |
| `PUT` | `/tasks/:runId/:taskId/review` | Body `{ "decision": "approve" \| "reject", "note": "…" }`. Records the human verdict (`task`) |
| `DELETE` | `/tasks/:runId/:taskId/review` | Clears the human verdict (`task`) |
| `GET` | `/tasks/:runId/:taskId/artifacts` | Pipeline artifact keys grouped by stage plus the task's bundles; read them with the `/v1/runs/:runId/artifacts` and `/bundle` routes |

A task object carries `runId`, `taskId`, `candidateId`, `difficulty`, `stage`, `pipelineStatus`, the derived `state` (`needs_review`, `accepted`, `rejected`, `failed`, `in_progress`), `reason`, `sourcePr`, `sourceUrl`, `review`, `round`, `workflowId`, `startedBy`, `startedAt`, and `syncedAt`.

`GenerationSettings` is `{ authorModel, verifierModel, reasoning: "low" | "medium" | "high", sandbox: "modal" | "vercel" | "e2b", modelCredentialId, sandboxCredentialId, sandboxImage?, harborEnvironment?: "modal" | "vercel" | "e2b" | "daytona", harborCredentialId? }`; the credential ids come from the organization credentials routes. `sandboxImage` is required for `vercel`, optional for `e2b` (the worker builds the managed template on first use when omitted), and rejected for `modal`; every non-managed sandbox requires a separate `harborEnvironment` and `harborCredentialId`. The full schema is `generationSettingsSchema` in `src/site/generation-settings.ts`.

## Batches

Relative to `/api/orgs/:org/repos/:owner/:name`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/batches` | Batch runs attached to the repository (`batches`: `runId`, `attachedBy`, `attachedAt`) |
| `POST` | `/batches` | Body `{ "candidateCounts": { "easy": n, "medium": n, "hard": n }, "generation"?: GenerationSettings }`, 1–300 candidates in total. Starts a batch; `202 { run, runId }` |
| `GET` | `/batches/:batchId` | Live status of the batch: phase, counts, candidates, and task progress |
| `POST` | `/batches/:batchId/cancel` | Requests cancellation; `202` |

## Evaluations

Relative to `/api/orgs/:org/repos/:owner/:name`. Single-model evaluation runs use the operator-configured model list; model comparisons (below) use organization credentials.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/evaluations` | Past and running evaluations (`runs`), trial logs omitted |
| `GET` | `/evaluations/options` | Configured `models` (each with its `harnesses`), `sandboxes`, `harborVersion`, whether personal setups are `configurable`, and the approved `tasks` that may be evaluated |
| `POST` | `/evaluations` | Body `{ "id": uuid, "model", "harnesses": [...], "sandbox", "tasks": [{ "runId", "taskId" }] }`. Starts an evaluation; `202` with the run. Repeating the same `id` and selection resumes rather than duplicates; a different selection under a known `id` answers `409` |
| `GET` | `/evaluations/:id` | One evaluation with every trial's log, steps, and artifact names |
| `GET` | `/evaluations/:id/artifacts?name=…` | Downloads one trial artifact as text |
| `POST` | `/evaluations/profiles` | Body per `setupSchema` in `src/evaluation/profiles.ts` (`provider`, `model`, `modelApiKey`, `sandbox`, sandbox credentials, optional `pricing`). Saves a personal model setup; `201` |

## Model comparisons

Relative to `/api/orgs/:org/repos/:owner/:name/evaluations`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/catalog` | The model catalog with reference pricing: `version`, `models`, `sandboxes`, `customHosts` |
| `GET` | `/comparisons` | Comparisons of this repository with live status (`comparisons`) |
| `POST` | `/comparisons` | Body per `comparisonSchema` in `src/evaluation/comparisons.ts`: `id` (uuid), `tasks`, `models` (`catalogId`, `credentialId`, `harnesses`, optional `customModel` and `thinking`), `sandbox`, and the sandbox credential. Creates and dispatches the comparison; `202`. A `submissionError` field means some runs were not confirmed and should be resumed |
| `GET` | `/comparisons/:id` | One comparison with per-model run status |
| `POST` | `/comparisons/:id/resume` | Re-dispatches unconfirmed runs with the same run ids; `202` |
| `*` | `/credentials…` | Alias of the organization credential routes below |

## Organization credentials

Credentials are shared by everyone in the organization and encrypted at rest. Reads need membership; writes need the `admin` role.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/orgs/:org/credentials` | Stored credentials without their secrets (`credentials`) and whether the caller `canManage` them |
| `POST` | `/api/orgs/:org/credentials` | Body per `credentialSchema` in `src/evaluation/credentials.ts`: `name`, `kind` (`openai`, `anthropic`, `openrouter`, `custom`, `e2b`, `modal`, `daytona`, `vercel`), `value`, and kind-specific fields such as `endpoint`, `tokenId`, or `teamId`. `201` with the stored credential |
| `POST` | `/api/orgs/:org/credentials/:id/delete` | Deletes a credential; `400` while a comparison still references it |
| `POST` | `/api/orgs/:org/credentials/codex-login` | Body `{ "name": "Codex" }`. Starts a ChatGPT device sign-in for Codex; `202` with the session id and instructions |
| `GET` | `/api/orgs/:org/credentials/codex-login/:id` | Sign-in status |
| `POST` | `/api/orgs/:org/credentials/codex-login/:id/complete` | Stores the resulting credential once the browser side has approved |
| `POST` | `/api/orgs/:org/credentials/codex-login/:id/cancel` | Abandons the sign-in |

## Billing

Metered Stripe billing applies only to managed model and sandbox usage. Organization credentials are never invoiced by SelfBench. When the three Stripe env vars are unset, billing is disabled and managed runs stay available. Reads need membership; Checkout and the Customer Portal need the `admin` role and a browser session.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/orgs/:org/billing` | Subscription status: `configured`, `eligible`, `status`, `canManage`, and optional customer/period fields |
| `POST` | `/api/orgs/:org/billing/checkout` | Creates a Stripe Checkout session; `200 { url }`. Browser session, admin only |
| `POST` | `/api/orgs/:org/billing/portal` | Creates a Stripe Customer Portal session; `200 { url }`. Browser session, admin only |
| `POST` | `/api/stripe/webhook` | Stripe webhook (unauthenticated, `Stripe-Signature` verified) |

`GET …/generation-options` also includes `billing` (`configured`, `eligible`, `status`, `canManage`). Starting a managed batch or PR task without an eligible subscription answers `403 {"error":"Set up billing to use managed models or sandboxes.","code":"billing_required"}`.

## Run artifacts and CLI routes

The site's task pages read bundles and raw artifacts through the run routes that the CLI also uses. With a session or API key they are scoped to the caller like every other route; with `SELFBENCH_API_TOKEN` they are the operator's Harbor Ledger API. See [Operations](operations.md#http-api) for run submission details.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Liveness check (unauthenticated) |
| `GET` | `/v1/viewer` | Viewer capabilities (unauthenticated) |
| `GET` | `/v1/runs` | Every run Temporal knows plus archived runs |
| `POST` | `/v1/runs` | Start a candidate workflow or a replay |
| `GET` | `/v1/runs/:runId` | Run status |
| `POST` | `/v1/runs/:runId/cancel` | Request cancellation |
| `GET` | `/v1/runs/:runId/export` | Download the export archive |
| `POST` | `/v1/provenance?runId=…` | Store provenance JSONL for a run |
| `GET` | `/v1/runs/:runId/candidates` | Every candidate of a run |
| `GET` | `/v1/runs/:runId/candidates/:taskId/artifacts` | Artifact keys for one candidate |
| `GET` | `/v1/runs/:runId/artifacts?key=…&start=…` | Stream one artifact, optionally from a byte offset |
| `GET` | `/v1/runs/:runId/bundle?key=…` | Expand a Harbor task bundle into its text files |

## Sign-in routes

Used by the browser only; scripts should use API keys.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/auth/github` | Redirect to GitHub |
| `GET` | `/auth/github/callback` | Finish sign-in and set the session cookie |
| `POST` | `/auth/logout` | Clear the session cookie |
