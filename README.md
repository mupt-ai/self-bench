# SelfBench

[![CI](https://github.com/mupt-ai/self-bench/actions/workflows/ci.yml/badge.svg)](https://github.com/mupt-ai/self-bench/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/mupt-ai/self-bench?color=green)](./LICENSE)

**SelfBench builds private coding-agent benchmarks from your repository's merged pull requests, so you can compare agents and models on your own codebase.**

For each merged PR, SelfBench rebuilds the task from the commit before the change: the PR's own request becomes the instruction, and an authoring agent writes hidden tests and a reference solution. A task is accepted only if the tests fail without a solution, pass with the original implementation, pass again on a rerun, and survive an independent review. Every accepted task is a native [Harbor](https://harborframework.com/) task.

## Using SelfBench

Everything happens in the web app at [app.selfbench.dev](https://app.selfbench.dev):

1. **Sign in** with GitHub and **connect a repository**.
2. **Batch Generation**: choose how many easy, medium, and hard tasks to build, or **Add PR** to build one from a chosen pull request. A batch takes hours; it keeps running after you close the page.
3. **Dataset**: inspect each task (instruction, environment, hidden tests, reference patch, pipeline artifacts) and approve or reject it.
4. **Run**: pick models, harnesses, and a sandbox, and run them on the approved tasks.
5. **Results**: compare accuracy against cost, and open any trial's transcript and scores.
6. **Releases**: publish a public repository's results to [selfbench.dev](https://selfbench.dev).

Model and sandbox access is either managed by SelfBench (billed under **Billing**) or your organization's own keys under **Credentials**. **API Keys** gives scripts the same access over the [HTTP API](docs/api.md).

## Deploying

SelfBench runs on GCP: the API on Cloud Run, the Temporal worker as a Cloud Run worker pool, Harbor work on GKE Autopilot pods scaled by KEDA, Cloud SQL, and GCS. Terraform owns all of it, and GitHub Actions deploys `main` to dev and releases to prod. See [infra/README.md](infra/README.md).

## Development

Requires [Bun](https://bun.sh/) 1.3.14+ and Docker with Compose.

```bash
bun install --frozen-lockfile
bun run validate
```

Run the whole stack (API serving the app, worker, Temporal, Postgres, local Docker sandboxes) from a checkout:

```bash
cp .env.example .env   # GitHub OAuth app, session secret, credential key, managed keys
SELFBENCH_PUBLIC_URL=https://your-tunnel.example docker compose --profile sandbox up -d --build
docker compose port api 8080
```

Compose names the project after the checkout directory and publishes ephemeral host ports, so worktrees run side by side. Set `SELFBENCH_PUBLIC_URL` to the origin the browser opens (a tunnel or reverse proxy) before `up`, and register `<origin>/auth/github/callback` on the OAuth app.

For frontend work, `bun run dev:site` runs the API and Vite with hot reload (secrets in `.env.site`; see `scripts/dev-site.ts`).

## Documentation

- [How it works](docs/how-it-works.md): the pipeline and what makes a task valid
- [HTTP API](docs/api.md)
- [Infrastructure](infra/README.md)

## License

[MIT](LICENSE) © 2026 Mupt AI.
