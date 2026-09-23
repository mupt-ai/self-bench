# Pick Benchmark Candidates

You are choosing which merged pull requests from this repository ({{repositoryUrl}}) can become benchmark tasks. Return at most easy={{easy}}, medium={{medium}}, hard={{hard}} candidates. Fewer, or none, is fine when the PRs don't fit.

/work/provenance.jsonl holds {{count}} merged pull requests, one JSON record per line: the PR's title and body as `content`, plus `sourceType`, `sessionId`, `messageIndex`, `sourcePr`, and `sourceUrl`.

# Choosing

- Inspect each PR's diff with gh and git. Resolve the exact 40-character base and completed commits.
- Tier by the implementation core only (no tests, generated code, formatting, or unrelated cleanup): {{tiers}}. Use the highest tier the PR honestly meets.
- Prefer focused public behavior with tests that can be held out, a deterministic setup, and a request that describes the change.
- Skip PRs whose implementation lives in paths the repository marks `export-ignore` in .gitattributes; the task snapshot won't contain them.
- Skip PRs listed in /work/excluded-source-prs.json (check a number with jq; don't read the whole list).
- Only PRs from {{repositoryUrl}}. Use each record only for its own sourcePr and sourceUrl, and copy its sourceType, sessionId, and messageIndex exactly. Never invent request text. Don't modify the repository.

Call submit_discovery exactly once, then stop.
