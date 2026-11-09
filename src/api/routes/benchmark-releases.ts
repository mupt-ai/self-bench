import type { ArtifactStore } from "../../artifacts/index.js";
import { buildCommit } from "../../contracts/config/build-metadata.js";
import type { Benchmark, BenchmarkStore } from "../../db/benchmarks.js";
import type { Database } from "../../db/client.js";
import type { ReleaseStore } from "../../db/releases.js";
import type { UserStore } from "../../db/users.js";
import { catalogVersion } from "../../evaluation/catalog.js";
import { readModelSummaries } from "../../evaluation/model-summary.js";
import { evaluationTaskKey } from "../../evaluation/models.js";
import { track } from "../../lib/telemetry/posthog.js";
import { BENCHMARKS } from "../../public/paths.js";
import type { ReleaseTask } from "../../public/release-rule.js";
import { lineInputs } from "../../public/release-sources.js";
import {
  buildRequested,
  createLineRoutes,
  isReply,
  type LineKind,
  publisherOf,
} from "./release-line.js";

const NAME = "[A-Za-z0-9][A-Za-z0-9._-]{0,98}";
/** `[org, registry org/name, section?, action?]`. */
const route = new RegExp(
  `^/api/orgs/([A-Za-z0-9_.-]+)/benchmarks/(${NAME}/${NAME})/releases(?:/(preview|[a-f0-9-]{36}))?(?:/(withdraw))?$`,
);

export interface BenchmarkReleaseRoutesOptions {
  readonly db: Database;
  readonly artifacts: ArtifactStore;
  readonly users: UserStore;
  readonly benchmarks: BenchmarkStore;
  readonly releases: ReleaseStore;
  readonly publicUrl: string;
  readonly resultsSiteUrl: string | null;
  /** Told the paths whose public pages a release or withdrawal changed. */
  readonly onPublicChange?: (paths: string[]) => void;
}

/** A benchmark with its frozen tasks, as the release rule reads them. */
interface Subject {
  benchmark: Benchmark;
  tasks: ReleaseTask[];
}

/**
 * A public benchmark's releases (a Harbor registry dataset such as Terminal-Bench): a
 * repository's Releases tab (release-line.ts) over the benchmark's runs, on the tasks frozen when
 * it was added. Each workspace that runs it publishes its own line, and selfbench.dev shows them
 * together at /evals/<org>/<name>, as a repository's lines, with its tasks, their trials, and
 * its model summaries when the releaser publishes them.
 */
export function createBenchmarkReleaseRoutes(options: BenchmarkReleaseRoutesOptions) {
  const kind: LineKind<Subject> = {
    route,
    notFound: "Benchmark not found",
    async find(tenant, name) {
      const benchmark = await options.benchmarks.find(tenant.id, name);
      if (!benchmark || benchmark.status !== "ready") return undefined;
      const tasks = (await options.benchmarks.tasks(benchmark.id)).map(
        ({ runId, taskId, bundleKey }): ReleaseTask => ({
          key: evaluationTaskKey(runId, taskId),
          runId,
          taskId,
          bundleKey,
          // Frozen from the registry when added: every one is the benchmark's, as it stands.
          state: "accepted",
          runnable: true,
        }),
      );
      return { benchmark, tasks };
    },
    lineOf: (tenant, { benchmark }) => ({ orgId: tenant.id, benchmarkId: benchmark.id }),
    async gather(tenant, { benchmark, tasks }, rows) {
      const scope = { benchmarkId: benchmark.id };
      const [inputs, { report }] = await Promise.all([
        lineInputs(
          options.db,
          options.artifacts,
          { scopes: [scope], orgId: tenant.id, tasks: Promise.resolve(tasks) },
          rows,
        ),
        readModelSummaries(options.artifacts, scope),
      ]);
      return { inputs, ...(report ? { report } : {}) };
    },
    async build({ tenant, subject: { benchmark }, body, gathered }) {
      const built = buildRequested(gathered, body, {
        repository: { id: benchmark.id, fullName: benchmark.name },
        publisher: { login: tenant.login, kind: tenant.kind },
      });
      if (isReply(built)) return built;
      return {
        fullName: benchmark.name,
        hash: built.hash,
        payload: {
          ...built.payload,
          benchmark: { ref: benchmark.ref },
          publisher: publisherOf(tenant),
        },
        detail: {
          ...built.detail,
          provenance: { selfbenchBuild: buildCommit, catalogVersion },
        },
      };
    },
    changed(tenant, row, user, released) {
      const page = `/${BENCHMARKS}/${row.fullName}`;
      // Its page, the publisher's line, and the Public Benchmarks view; the home page lists none.
      options.onPublicChange?.([`/${BENCHMARKS}`, page, `${page}/${row.publisherLogin}`]);
      if (released) track(user, "benchmark release published", { benchmark: row.fullName }, tenant);
    },
  };
  return createLineRoutes(options, kind);
}
export type BenchmarkReleaseRoutes = ReturnType<typeof createBenchmarkReleaseRoutes>;
