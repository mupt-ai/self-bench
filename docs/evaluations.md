# Running self-bench evaluations

A self-bench export contains a manifest and one archive per accepted Harbor task:

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

The provider that generated an export does not constrain where Harbor runs it. Every task has the same provider-neutral Harbor layout, and `manifest.json` records the generation backend and the Harbor environment used for self-bench's nop/oracle gates. For later coding-agent trials, independently choose `--environment docker` or `--environment modal`. Harbor does not currently provide a Vercel environment; Vercel Sandbox is used only during benchmark generation.

## Run one task

Extract the export and select a task:

```bash
mkdir -p ./export ./selected-task
tar -xzf ./my-evals.tar.gz -C ./export

TASK_ID="$(jq -r '.tasks[0].taskId' ./export/manifest.json)"
tar -xzf "./export/tasks/$TASK_ID.tar.gz" -C ./selected-task
```

Install Harbor and run Codex against it with API-key authentication:

```bash
uv tool install --python 3.12 'harbor[modal]==0.20.1.dev202608040148'

export OPENAI_API_KEY=...
harbor run \
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

## Run multiple tasks or models

Use Harbor directly for batch and model-comparison runs. Extract each task into a directory containing its `harbor-task` contents:

```bash
mkdir -p ./self-bench-tasks
for archive in ./export/tasks/*.tar.gz; do
  task_id="$(basename "$archive" .tar.gz)"
  mkdir -p "./self-bench-tasks/$task_id"
  tar -xzf "$archive" --strip-components=1 -C "./self-bench-tasks/$task_id"
done
```

Then pass the directory and desired models to `harbor run`:

```bash
harbor run \
  --path ./self-bench-tasks \
  --agent codex \
  --model gpt-5.6-luna \
  --model gpt-5.6-terra \
  --model gpt-5.6-sol \
  --ak version=0.146.1 \
  --ak reasoning_effort=high \
  --env modal \
  --jobs-dir ./harbor-jobs \
  --n-concurrent 20 \
  --yes
```

Harbor owns agent authentication, concurrency, retries, result persistence, and reporting. Consult Harbor's agent documentation when using Codex subscription authentication or a different agent adapter.
