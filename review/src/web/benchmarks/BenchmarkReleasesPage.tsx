import { useParams } from "react-router";
import { BENCHMARKS } from "../../../../src/public/paths";
import { publicPageUrl } from "../releases/api";
import { Releases } from "../releases/ReleasesPage";
import { useOrg } from "../SiteLayout";

/**
 * A public benchmark's Releases tab: the repository's, over the benchmark's runs, publishing
 * scores only. selfbench.dev lists it under Public Benchmarks, at /evals/<org>/<name>, beside any
 * other workspace's release of the same benchmark.
 */
export function BenchmarkReleasesPage() {
  const { org } = useOrg();
  const { owner = "", name = "" } = useParams();
  const benchmark = `${owner}/${name}`;
  return (
    <Releases
      target={{
        url: `/api/orgs/${encodeURIComponent(org.login)}/benchmarks/${benchmark}/releases`,
        label: benchmark,
        pageUrl: (site, release) =>
          publicPageUrl(site, `${BENCHMARKS}/${release.fullName}`, release.publisher),
        releaseSummary:
          "Publish this benchmark's results on selfbench.dev, where anyone can see them: each setting's accuracy and cost. The tasks are the registry's, so they are not published.",
        description:
          "Publish this benchmark's results on selfbench.dev, under Public Benchmarks. Each release is kept.",
        empty: `Nothing from this workspace is public for ${benchmark}. Release Results publishes accuracy and cost for the settings you choose.`,
      }}
    />
  );
}
