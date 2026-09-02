export function printHelp(): void {
  console.log(`SelfBench creates durable tiered Harbor evaluations.

Usage:
  self-bench setup vercel [--profile NAME] [--verbose]
  self-bench setup e2b --name NAME[:TAG] [--cpus N] [--memory-mib N]
  self-bench up [--backend docker|modal|vercel|e2b] [--harbor-environment docker|modal]
                [--modal-config PATH] [--vercel-profile NAME]
  self-bench down
  self-bench associate --repo PATH --list-sessions
  self-bench associate --repo PATH --pr NUMBER --session TYPE:SESSION_ID [...]
                       --output ASSOCIATION.json
  self-bench run --repo PATH [--easy-count N] [--medium-count N] [--hard-count N]
                  [--model MODEL] [--association ASSOCIATION.json ...]
                  [--run-id ID] [--wait] [--output OUTPUT.tar.gz]
  self-bench replay --source-run RUN_ID --candidate ID [--candidate ID ...]
                     [--model MODEL] [--run-id ID] [--wait] [--output OUTPUT.tar.gz]
  self-bench status RUN_ID
  self-bench cancel RUN_ID
  self-bench download RUN_ID OUTPUT.tar.gz
  self-bench list

The up command starts the local stack. Docker and Modal default Harbor to the matching backend; Vercel
and E2B require --harbor-environment because Harbor supports neither. Modal generation or Harbor uses
~/.modal.toml unless --modal-config overrides it. Run self-bench setup vercel once to create or select a
project, publish the pinned runtime image, verify access, and save an owner-only local profile. E2B setup
is noninteractive: with E2B_API_KEY set, it builds Dockerfile.sandbox under the requested versioned name;
set SELFBENCH_E2B_TEMPLATE to the printed template before starting the stack.

The associate command runs locally. --list-sessions prints selectors, counts, local paths, and modification
times, but never request text. Association writes a create-only, text-free manifest; it never uploads or
starts a run. Pass the manifest to run with --association (repeatable). No LLM participates in association.

The tier counts are accepted-task targets. A rejected candidate is replaced from the leftover discovery
pool until each tier is filled or the pool is exhausted, and the export contains only accepted tasks. The
run command performs only repository metadata and sanitized provenance upload locally; discovery, authoring
rounds, mechanical verification, and independent verification rounds run remotely. --output implies --wait,
blocks until completion, and downloads the SHA-256-verified export.

The replay command skips discovery: the worker rebuilds the named candidates from the source run's stored
provenance, discovery reports, and authored definitions, then runs authoring and verification fresh.`);
}
