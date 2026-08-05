# Authoring evals

Selfbench evals reproduce one completed software change from the repository state before the implementation. Prefer `selfbench create`; author a task manually only when you already know the change, tests, and authentic source request.

```bash
selfbench create --repo ~/code/my-project --count 1 --print
```

`--count 1` requests one complete eval. `--print` runs the authoring agent non-interactively; it still writes the task under `tasks/` and may stay quiet until the agent finishes.

## Choose a suitable change

A good eval has:

- a focused behavioral requirement;
- an available base commit;
- implementation and tests separable by file;
- deterministic setup and test commands;
- an authentic pre-implementation request;
- tests that accept any correct implementation, not only the original one.

Reject changes that depend on unavailable production services, secrets, nondeterministic external state, manual-only verification, or private implementation names that were never part of the request.

## Directory layout

```text
tasks/example-fix/
├── task.json
├── inputs/session.jsonl  # preferred
├── test.patch
└── gold.patch
```

Use exactly one eval prompt source:

- `prompt_source` in `task.json`, pointing to the original Codex, Claude Code, Pi, or generic JSON/JSONL session; or
- a standalone `prompt.md` containing an authentic pre-implementation request.

If a source session needs to be reconstructed into a standalone prompt, keep the session under `inputs/`, reference it with `trace_source`, and put the eval request in `prompt.md`.

## Minimal task definition

```json
{
  "task_id": "example-fix",
  "repo": "example/project",
  "base_commit": "0123456789abcdef",
  "workdir": ".",
  "setup_cmd": "npm ci",
  "test_cmd": "npm test -- {tests}",
  "fail_to_pass": ["tests/regression.test.ts"],
  "pass_to_pass": ["tests/unit.test.ts", "tests/api.test.ts"],
  "test_paths": ["tests"],
  "prompt_source": {
    "path": "inputs/session.jsonl",
    "format": "auto",
    "message_index": 0
  }
}
```

| Field | Required | Description |
| --- | --- | --- |
| `task_id` | yes | Path-safe identifier used for generated task and result directories. |
| `repo` | yes | Informational project slug. Supply the actual clone to `--repo`. |
| `base_commit` | yes | Full commit SHA before the implementation. |
| `workdir` | yes | Repository-relative directory where setup and tests run. |
| `setup_cmd` | yes | Shell command that prepares the repository. |
| `test_cmd` | yes | Shell command containing `{tests}` for the selected test IDs. |
| `fail_to_pass` | yes | Tests that fail at the base and pass with the gold patch. |
| `pass_to_pass` | yes | Existing tests that pass at the base and guard regressions. |
| `test_paths` | yes | Repository-relative files or directories owned by `test.patch`. |
| `prompt_source` | no* | Source session path, format, and zero-based user-message index. |
| `trace_source` | no | Source session retained for provenance review when using `prompt.md`. |
| `source_pr` | no | Original pull request number. |
| `source_url` | no | Original change URL. |
| `timeout_setup` | no | Setup timeout in seconds; default `900`. |
| `timeout_agent` | no | Agent timeout in seconds; default `2400`. |
| `timeout_tests` | no | Test timeout in seconds; default `900`. |
| `toolchains` | no | Image tools selected from `uv`, `bun`, `go`, `node`, `python`, and `rust`; defaults to `uv`, `bun`, `go`, and `node`. |
| `network_mode` | no | `public`, `no-network`, or `allowlist`; default `public`. |
| `agent_network_mode` | no | Network policy while the coding agent works; default `allowlist`. |
| `agent_allowed_hosts` | no | Extra hosts available during the coding-agent phase. |
| `verifier_network_mode` | no | Network policy for held-out grading; default `no-network`. |
| `cpus` | no | Container CPU count; default `4`. |
| `memory_mb` | no | Container memory in MB; default `8192`. |
| `storage_mb` | no | Container storage in MB; default `20480`. |

`prompt_source` is required unless `prompt.md` exists. Exactly one of them must define the eval prompt.

Set `toolchains` when the default image does not fit the project, for example `"toolchains": ["python"]`. Selfbench includes dependencies such as `uv` automatically. Selecting only what the eval needs reduces image build time.

### Native JavaScript setup

At compilation Selfbench inspects the exact base snapshot at `workdir`. A JS project with package metadata must have exactly one native lockfile plus an exact `package.json#packageManager` pin. Supported profiles are npm (`package-lock.json` or `npm-shrinkwrap.json`), pnpm (`pnpm-lock.yaml`), Yarn (`yarn.lock`), and Bun (`bun.lock` or `bun.lockb`). The generated manifest records the resolved manager, version, and package/lockfile hashes; changing that profile makes an existing generated task stale.

Choose the matching toolchain: `node` for npm, pnpm, and Yarn; `bun` for Bun. Use immutable setup commands: `npm ci`, `pnpm install --frozen-lockfile`, `yarn install --immutable`, or `bun install --frozen-lockfile`, followed by any repository-specific build or generation commands. Exact pnpm/Yarn versions use Corepack; exact npm versions are independently installed under a SelfBench prefix; exact Bun releases are checksum-verified official release assets. Corepack is not used to manage npm or Bun.

Selfbench rejects conflicting/multiple lockfiles, absent or non-exact declarations, declaration/lockfile mismatch, incompatible selected toolchains, a plainly different manager in `setup_cmd`, and obvious mutable install forms. A checkout with no manager declaration and no recognized lockfile remains compatible with legacy explicit setup. Preflight the generated Docker images before remote Modal validation; `validate-batch` does this for its local canaries by default.

## Split the change

Generate both patches from the same base and completed commit. The patches must not touch the same files.

Set `BASE_SHA` and `COMPLETED_SHA` to the relevant commits, then generate both patches:

```bash
git -C ~/code/my-project diff --binary "$BASE_SHA" "$COMPLETED_SHA" \
  -- tests/regression.test.ts > tasks/example-fix/test.patch

git -C ~/code/my-project diff --binary "$BASE_SHA" "$COMPLETED_SHA" \
  -- src/feature.ts > tasks/example-fix/gold.patch
```

Every file owned by `test.patch` must fall below a `test_paths` entry. Before grading, the verifier terminates processes left by solver-controlled setup, removes agent edits to those paths, applies the held-out test patch, and makes those paths root-owned and non-writable. Tests still execute code under test in the same process/filesystem, so this prevents background persistence and default egress rather than claiming impossible runtime secrecy.

## Select tests

`fail_to_pass` should cover the requested behavior. `pass_to_pass` should contain focused existing regressions—at least three meaningful entries when available.

Avoid tests coupled to helpers, fields, constants, archive bytes, payload keys, or control flow introduced only by the gold patch. Ask whether a different correct implementation of the human request would pass. If not, fix the test or reject the candidate.

## Generate a standalone prompt

When `trace_source` points to an original coding session, selfbench can generate a redacted user-voice request:

```bash
selfbench generate-prompt tasks/example-fix \
  --provider openai \
  --model YOUR_MODEL \
  --confirm-source-upload \
  --write
```

This sends the redacted source conversation to the selected model provider. It does not send the gold patch, test patch, or held-out test names. Review the generated prompt against the original session before accepting it.

## Validate and audit

```bash
selfbench validate tasks/example-fix --repo ~/code/my-project --env docker
selfbench audit tasks/example-fix --results results --strict
```

Validation generates `harbor-tasks/example-fix/` and runs Harbor's `nop` and `oracle` agents in separate environments. The command above runs locally with Docker; omit `--env docker` after installing and authenticating Modal. The static audit checks prompt provenance, patch separation, protected test paths, likely solution leakage, validation freshness, and test coupling.

Once both pass, use the `harbor run` command printed by validation. Harbor—not selfbench—owns coding-agent execution and result artifacts.
