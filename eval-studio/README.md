# Eval Studio

A standalone workspace for inspecting model evaluation results. Import a CSV or JSON export through the API, then compare models, providers, harnesses, thinking levels, and the actual cost of every task in the browser.

Eval Studio is a single self-contained app: a Go HTTP API with an embedded SQLite store that also serves a view-only React frontend. The frontend displays evaluations; all imports and deletes happen through the API.

## Stack

- API: Go 1.26+, `net/http`, SQLite via `modernc.org/sqlite` (pure Go, no CGO)
- Frontend: Vite + React 19 + TypeScript, `lucide-react` icons
- Storage: single SQLite file (default `eval-studio.db`)

## Layout

```
eval-studio/
  cmd/server/        HTTP server entrypoint
  internal/eval/     domain models and summary math
  internal/importer/ CSV/JSON parsing + validation
  internal/store/    SQLite persistence
  internal/api/      HTTP handlers and SPA static serving
  web/               Vite + React frontend (built into web/dist)
  sample-data/       example.csv demo export
  Dockerfile         multi-stage build (web + API)
  compose.yaml       local container run
```

## Run locally

API + dev frontend (hot reload):

```bash
# terminal 1 — API on :8080
cd eval-studio
go run ./cmd/server

# terminal 2 — Vite dev server on :5173, proxies /api to :8080
cd eval-studio/web
npm install
npm run dev
```

Open the Vite URL printed in terminal 2.

Single-binary production-style run (API serves the built frontend):

```bash
cd eval-studio/web && npm install && npm run build
cd ..
go run ./cmd/server
# open http://127.0.0.1:8080
```

Seed an evaluation from the sample export (API only — the frontend has no upload UI):

```bash
curl -F 'file=@eval-studio/sample-data/example.csv' http://127.0.0.1:8080/api/evaluations
# or with an admin token configured:
curl -H 'Authorization: Bearer <token>' -F 'file=@eval-studio/sample-data/example.csv' http://127.0.0.1:8080/api/evaluations
```

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `EVAL_STUDIO_ADDR` | `:8080` | Listen address |
| `EVAL_STUDIO_DB` | `eval-studio.db` | SQLite database path |
| `EVAL_STUDIO_STATIC` | `web/dist` | Built frontend directory; omitted logs a warning and serves API only |
| `EVAL_STUDIO_ADMIN_TOKEN` | unset | If set, write endpoints require `Authorization: Bearer <token>` |

When `EVAL_STUDIO_ADMIN_TOKEN` is set, `POST /api/evaluations`, `POST /api/evaluations/preview`, and `DELETE /api/evaluations/{id}` require the bearer token. The frontend is view-only and never sends a token. Leaving the token unset is intended only for local development; the server logs a warning because writes are then open to anyone who can reach the listener. Read endpoints remain unauthenticated, so keep the app behind a private network or authenticated reverse proxy when eval data is confidential.

## API

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/health` | no | Liveness probe |
| `GET` | `/api/evaluations` | no | List evaluation summaries |
| `GET` | `/api/evaluations/{id}` | no | Full evaluation with runs and task results |
| `POST` | `/api/evaluations/preview` | admin | Validate an upload without storing it |
| `POST` | `/api/evaluations` | admin | Import an evaluation |
| `DELETE` | `/api/evaluations/{id}` | admin | Delete an evaluation |
| `GET` | `/api/template.csv` | no | Download a CSV template with a sample row |

Uploads are `multipart/form-data` with a `file` field. Max upload size is 25 MiB.

## Upload formats

### CSV

One row per task result. Rows are grouped into runs by `run_name` + `model` + `provider` + `harness` + `thinking_level`. Required columns:

```
evaluation_name,benchmark,run_name,model,provider,harness,thinking_level,task_id,passed,score,cost_usd
```

Optional columns: `description`, `task_name`, `duration_ms`, `input_tokens`, `output_tokens`, `error`.

`passed` is `true`/`false`. `score` is a number in `[0,1]`. `cost_usd` is a non-negative USD amount. Download a template from `GET /api/template.csv`.

### JSON

A single `Evaluation` object:

```json
{
  "name": "Terminal-Bench 2.1 · August",
  "description": "Full-suite agent comparison.",
  "benchmark": "Terminal-Bench 2.1",
  "runs": [
    {
      "name": "Dari Router",
      "model": "dari/routing",
      "provider": "Dari",
      "harness": "mini-SWE-agent",
      "thinking_level": "adaptive",
      "results": [
        { "task_id": "git-multibranch", "task_name": "Repair multibranch history", "passed": true, "score": 1, "cost_usd": 0.094, "duration_ms": 88520, "input_tokens": 38720, "output_tokens": 6850 }
      ]
    }
  ]
}
```

`id` and `uploaded_at` are generated if omitted.

## Docker

```bash
export EVAL_STUDIO_ADMIN_TOKEN="replace-with-a-long-random-value"
docker compose up --build
# open http://127.0.0.1:8080
```

## Validate

```bash
cd eval-studio
go test ./...
go vet ./...
cd web && npm run typecheck && npm run build
```
