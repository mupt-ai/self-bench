# Run tasks with Harbor

Open a connected repository → **Review** to inspect and approve tasks. **Dataset** contains only human-approved tasks with accepted pipeline results. Select up to ten tasks and open the dedicated **Run** page. Its predefined model table is available even before credentials are configured. Select saved credentials, toggle compatible harnesses, choose a shared sandbox, then press **Run comparison**. Each model creates a separately tracked run on the same frozen tasks. **Results** shows runs and an accuracy/cost Pareto frontier using `@mupt-ai/dari-pareto`; select a run for its transcript, scores, and artifacts. Each task/harness pair gets one attempt, sequentially within its model run. Task generation, authoring, `nop`, and oracle verification remain separate workflows.

## Settings → Credentials

Add named credentials separately from Run. Supported providers are OpenAI, Anthropic, OpenRouter, and a custom OpenAI-compatible endpoint. Custom endpoints require HTTPS and an operator-approved hostname in `SELFBENCH_CUSTOM_MODEL_HOSTS`. Hosted sandboxes are E2B, Modal, and Daytona; E2B and Daytona use API keys, while Modal requires a token ID and secret. Docker is not offered in the hosted UI. Saving does not contact a model or allocate a sandbox. The explicit **Run comparison** action starts billable work.

OpenAI credentials may instead use an explicitly uploaded Codex sign-in file. These credentials work only with the Codex harness, never fall back to an API key, and remain subject to subscription limits and sandbox charges. The worker never imports the host's sign-in automatically.

Credentials are private to your user and reusable across your authorized repositories. PostgreSQL stores AES-256-GCM encrypted records; no separate vault service or Context Drop runtime is required. A separate deployment encryption key stays outside the database. Credentials are never returned by the API or placed in workflow inputs or browser storage. Only selected credentials enter the isolated Harbor process. Use HTTPS outside the encrypted local tailnet. Replacing a credential creates a new reference; deletion is blocked while a referencing run remains active. Database backups may retain deleted encrypted records under your backup retention policy.

Comparisons are persisted before workflow submission. A retry uses the same frozen selection and child workflow IDs, so a partial submission can be resumed without starting duplicate work. Closing the page does not cancel runs.

## Enable on the server

Set `SELFBENCH_DATABASE_URL` and `SELFBENCH_EVAL_CREDENTIAL_KEY` identically on the API and evaluation worker. The key must be a securely generated 32-byte lowercase hex encryption key, separate from session/OAuth secrets. Back it up securely; losing it makes saved credentials unreadable. Startup applies the additive `evaluation_records` migration. Changing the key does not rotate existing records: retain the current key until an explicit decrypt/re-encrypt migration is available. Install `harbor[e2b,daytona,modal]==0.20.1.dev202608040148` on the worker. Set `SELFBENCH_EVAL_TASK_QUEUE` identically on API and worker, then run `node dist/evaluation/worker-main.js`. This worker does not consume task-generation work. The normal combined worker remains supported when using its task queue.

Alternatively, operators can preconfigure profiles with these non-secret settings on the API and Temporal worker:

```sh
SELFBENCH_EVAL_MODELS='[{"id":"my-openai-model","label":"My OpenAI model","model":"openai/YOUR_MODEL_ID","harnesses":["codex","pi"],"tenants":["YOUR_GITHUB_ORG"],"credentialEnv":"SELFBENCH_EVAL_SECRET_OPENAI"}]'
SELFBENCH_EVAL_SANDBOXES='["docker"]'
```

The model name must be an actual model your provider account can use, not the example placeholder. OpenAI models support `codex` and `pi`; Anthropic models support `claude-code` and `pi`; the other supported providers use `pi`. Harbor's additional multi-field/cloud-identity authentication schemes (for example Bedrock and Vertex) are not exposed as fake single-key options. Provider access is not probed with paid calls. The worker fails closed if the selected configuration changed or its credential is missing.

For legacy operator profiles, provision the corresponding `SELFBENCH_EVAL_SECRET_*` value **only on the worker**. Never place it in frontend variables or send an operator key to the browser. Other model keys, GitHub OAuth tokens, site/database credentials, unrelated sandbox credentials, and host subscription profiles are excluded. A separate temporary HOME prevents use of the operator's CLI login state. AWS identity and arbitrary harness imports are not exposed by the current runner.

Docker requires a working worker-accessible Docker daemon and Compose. For operator profiles, Modal uses dedicated `SELFBENCH_EVAL_SECRET_MODAL_TOKEN_ID` and `SELFBENCH_EVAL_SECRET_MODAL_TOKEN_SECRET`; E2B and Daytona use `SELFBENCH_EVAL_SECRET_E2B_API_KEY` and `SELFBENCH_EVAL_SECRET_DAYTONA_API_KEY`. These are Harbor's built-in solver environments, not the separate generation executors. Generation credentials are not reused automatically.

The worker verifies Harbor **0.20.1.dev202608040148**, matching the existing Dockerfile pin. Harbor installs the selected solver CLI using its built-in harness. Installed agent version details remain in Harbor's trial result artifact. Restart/redeploy the API and worker through your normal deployment process after configuring them. This does not modify OAuth callback registration or existing preview services.

## Results and safety

E2B uses a packaged Harbor environment subclass that limits sandbox lifetime to one hour. The pinned upstream environment otherwise requests 24 hours, which Hobby accounts reject before the solver starts. All other E2B behavior, including network policy and cleanup, remains inherited from Harbor. The adapter does not retry sandbox creation automatically. Tasks exceeding the one-hour sandbox lifetime fail rather than silently extending usage.

- Session authentication, tenant membership, connected repository ownership, task membership, and runnable bundle state are checked server-side. Run requests accept setup identifiers, not credentials, bundle paths or commands. Credentials are accepted only by the scoped setup endpoint. Tasks must have an accepted pipeline result and an explicit human approval, checked again when submitting.
- Same-origin JSON is required to start a run. A request UUID is also its durable workflow identity. Retrying an unconfirmed submission with the same selection/UUID never starts a second Temporal workflow; a new explicit run gets a new UUID.
- Temporal executes a separate `selfBenchEvaluationWorkflow`. Automatic activity and Harbor trial retries are disabled. Each Harbor invocation has a two-hour limit and requests sandbox deletion. A killed worker or forced timeout can leave sandbox resources; the failure view warns that an operator may need to verify cleanup. Local tests do not prove remote cleanup.
- Runs survive page navigation and API restarts. Metadata and changing progress are append-only immutable snapshots under `evaluations/repos/<repo-id>/<uuid>/`; completed text artifacts live beside them. Unchanged poll results do not create snapshots. The worker and API must share the artifact store. Retention/garbage collection remains an operator responsibility.
- Docker's mounted agent logs can update during execution. Modal's agent logs are downloaded after the solver finishes; the UI labels that limitation rather than presenting synthetic live transcript events. The browser polls every three seconds.
- Completed views show each task/harness's verifier reward names and values, solver text, tool calls and outputs, raw logs, and sanitized text artifacts. A zero score is a legitimate completed result; missing scores and exceptions are failures, not zeroes. ATIF trajectories and Pi message events are normalized where present, with raw output as fallback.
- Only selected text log/result filenames are exported, never whole sandbox directories, auth files, or standalone config files. Known worker secret values and common token patterns are redacted before persistence. Output is untrusted text, not rendered HTML. Redaction is not protection against a deliberately malicious solver encoding a credential; sandbox workloads must be trusted to receive the dedicated evaluation model key.
- Text files are capped at 1 MiB each and 4 MiB per collection; the on-page log and transcript are bounded. Downloaded files are sanitized, potentially truncated exports, not byte-identical raw Harbor artifacts. No automatic public uploads occur.

## Cost comparisons

Estimated model cost is independent of authentication. Codex sign-in and API keys use the same token accounting: uncached input, cached input, cache writes, and output. For verified models, matching Harbor per-request token and cost records take precedence over reference rates, preserving per-request pricing tiers. Pi uses explicit reference rates: its unknown-model resolver can inherit another model's price metadata, so its dollar total alone is not trusted. A bare dollar total without matching usage is not accepted. Otherwise, dated reference rates are snapshotted with the run; aggregate usage beyond their conservative input bound is not estimated. These are token-equivalent estimates, not invoices; sandbox charges are excluded. Custom models can have a Harbor estimate even without reference pricing. Claude Code cost remains unavailable where its export cannot reliably separate cache-write usage. Missing estimates are never displayed as zero.

The catalog was researched on September 5–6, 2026 against official provider documentation, OpenRouter's live model API, and Artificial Analysis coding-agent results. It includes GPT-6 Astra, GPT-5.6 Sol/Terra/Luna, Claude Fable 5.1/Opus 5/Sonnet 5, and current OpenRouter alternatives. Catalog availability is not proof of credential entitlement or a successful SelfBench run. No older-model fallback is performed. Existing runs retain their original model and pricing snapshots. OpenRouter routes with ambiguous cache-write units have no fixed reference estimate; measured Harbor usage can still supply a cost.

The plot only compares completed runs with binary reward scores, verified model identities, and complete costs on the same frozen task/bundle snapshot. Separate dataset selections produce separate comparison groups. Missing costs are never treated as zero; those runs remain available in the results list. Failed/incomplete runs are not frontier points.

## Local validation

When developing against an older site API, `SELFBENCH_EVALUATION_PROXY` optionally sends only `/api/orgs/:org/repos/:owner/:repo/evaluations` requests to a separately running evaluation API. All other API and GitHub login requests continue through `SELFBENCH_VIEW_PROXY`. Both API processes must use the same session secret, database, public origin, and artifact store; keep these server-side. This split is a development bridge, not a replacement for deploying the integrated API and evaluation worker.

```sh
bun test tests/evaluation-routes.test.ts tests/evaluation-runner.test.ts tests/evaluation-lifecycle.test.ts review/src/web/evaluation/evaluation.test.tsx
bun run check
bun run build
```

Tests use a local artifact store, PGlite, signed test sessions, and mocked Harbor commands. They do not run models or create Docker/Modal sandboxes. Real provider access, solver installation, live evaluation, and cloud cleanup require a separately authorized smoke run.
