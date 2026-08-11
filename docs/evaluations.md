# Running SelfBench evaluations

A SelfBench export contains a manifest and one archive per accepted Harbor task:

```text
manifest.json
tasks/
└── TASK_ID.tar.gz
    └── harbor-task/
        ├── task.toml
        ├── instruction.md
        ├── environment/
        ├── tests/
        └── solution/
```

Exports include repository snapshots, held-out tests, and reference solutions. They are sensitive and unencrypted; keep them private.

## Run one task

Extract the export and select a task:

```bash
mkdir -p ./export ./selected-task
tar -xzf ./my-evals.tar.gz -C ./export

TASK_ID="$(jq -r '.tasks[0].taskId' ./export/manifest.json)"
tar -xzf "./export/tasks/$TASK_ID.tar.gz" -C ./selected-task
```

Install Harbor and run Codex against it:

```bash
uv tool install --python 3.12 'harbor[modal]==0.20.1.dev202608040148'

export CODEX_FORCE_AUTH_JSON=1
export CODEX_AUTH_JSON_PATH="$HOME/.codex/auth.json"
env -u OPENAI_API_KEY harbor run \
  --path ./selected-task/harbor-task \
  --agent codex \
  --model gpt-5.6-sol \
  --ak version=0.146.1 \
  --ak reasoning_effort=high \
  --env modal \
  --jobs-dir ./harbor-jobs \
  --yes
```

The `solution/` directory is used only for explicit oracle validation and is never mounted for coding-agent trials.

## Run the model matrix

The included matrix runner evaluates every exported task with `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`. It reuses completed Harbor jobs after a restart.

From the SelfBench checkout:

```bash
env -u OPENAI_API_KEY node dist/eval-main.js \
  --export ./my-evals.tar.gz \
  --jobs ./matrix-jobs \
  --harbor harbor \
  --environment modal \
  --concurrency 20 \
  --auth "$HOME/.codex/auth.json"
```

The harness requires ChatGPT-backed Codex authentication and does not forward `OPENAI_API_KEY`.
