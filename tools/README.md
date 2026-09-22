# Operator Tools

These commands build durable evaluation artifacts from completed SelfBench runs. They are not part of the application build or deployment path.

## Build a Combined Bundle

`build-combined-bundle.ts` packages one accepted task per source pull request from a GCS artifact store. It recompiles each task through the trusted compiler, writes per-task Harbor archives, and produces a manifest with source provenance and SHA-256 digests.

Run it with an explicit artifact location and source repository:

```sh
bun run build:bundle -- \
  unique.json \
  /tmp/selfbench-bundles \
  posthog-accepted \
  --bucket YOUR_ARTIFACT_BUCKET \
  --prefix selfbench/YOUR_NAMESPACE \
  --repository-url https://github.com/OWNER/REPOSITORY.git
```

For a local bare mirror, add:

```sh
--mirror /path/to/repository.git
```

The command uses `GH_TOKEN` when set, otherwise it reads the active GitHub CLI token. It requires access to the selected GCS bucket and to the source repository. The bucket, prefix, repository, and output directory are deliberately required arguments rather than repository-specific constants.

For a resumable run:

```sh
SELFBENCH_BUNDLE_RESUME=1 bun run build:bundle -- ...
```

Set `SELFBENCH_BUNDLE_TARBALL=0` to keep the per-task archives and manifest without creating the additional combined tarball.
