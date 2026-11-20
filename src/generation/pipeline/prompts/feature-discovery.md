# Find Features to Benchmark

You are choosing features of this repository ({{repositoryUrl}}) to become benchmark tasks. A feature is one capability its users or callers gained, usually built over several merged pull requests: a new command with its options, an API resource with its endpoints and its UI, a plugin system with its first plugins, an integration with another tool. Each task asks a coding agent to build the whole feature from the commit before its first PR landed, and end-to-end tests grade what it built. Return at most easy={{easy}}, medium={{medium}}, hard={{hard}} features. Fewer, or none, is fine when nothing fits.

/work/provenance.jsonl indexes {{count}} merged pull requests, one JSON record per line: the PR's title and body as `content`, plus `sourcePr` and `sourceUrl`. {{scope}}

# Choosing

- Group PRs by the capability they build: follow-ups that extend, wire up, or finish the same thing (shared names and paths, a common tracking issue, "part 2", "follow-up to #N"). Skim titles first (jq over the index), then confirm a group with `gh pr view`, `gh pr diff`, and `git log` over the paths it touches.
- A feature is {{minimum}}, all merged into the default branch, that together deliver something a user or caller can exercise end to end once the last one lands. Leave out PRs of the group that are only refactors, docs, or tests, unless the feature needs them.
- Prefer features whose finished behavior can be tested from outside: a command, an HTTP endpoint, a rendered page, a public API, a stored record. Skip features that need live third-party accounts, hardware, or a production deploy to observe.
- Keep each feature buildable from one base. Skip one whose PRs are interleaved with so much unrelated rework of the same code that its PRs no longer apply to the commit before the first of them.
- A feature's tier is how many PRs built it: {{tiers}}. Count only PRs that carry the feature's implementation; don't pad a feature with refactors, docs, or tests to reach a tier, or split one to fit another.
- Skip PRs whose implementation lives in paths the repository marks `export-ignore` in .gitattributes; the task snapshot won't contain them.
- Skip any feature with a PR listed in /work/excluded-source-prs.json (check a number with jq; don't read the whole list).
- A PR belongs to at most one feature. Only PRs from {{repositoryUrl}}. Never invent PRs or request text. Don't modify the repository.

# Resolving Commits

`gh pr view <number> --json mergeCommit,mergedAt,title,url` gives the commit each PR landed as on the default branch. List a feature's PRs in merge order, each with that commit as `mergeCommit`. The feature's `baseCommit` is the first parent of its first PR's landed commit (`git rev-parse <commit>^1`), and its `completedCommit` is its last PR's landed commit. All are 40-character SHAs.

# Describing

For each feature give a `title`, the capability's short name ("Saved searches", "Webhook retries"), and a `summary`: what the feature does once complete, how a user or caller exercises it, and its notable behavior and edge cases, drawn from the PRs' own titles, bodies, and code. A few paragraphs at most; add no requirements the PRs don't show.

{{focus}}

Call submit_features exactly once, then stop.
