import { NavLink, Outlet } from "react-router";
import { ChartPreview } from "../evaluation/ChartPreview";
import { RepoRunsProvider } from "../evaluation/RepoRuns";
import { BenchmarkScope, useEvaluationScope } from "../evaluation/useEvaluationScope";
import { pageContainer, pageGutter } from "../layout";
import { cn } from "../primitives/cn";
import { useOrg } from "../SiteLayout";
import { Breadcrumbs } from "../ui";

/**
 * One benchmark: models run on a Harbor registry dataset the org added, apart from any
 * repository, with the same Dataset, Run, and Results pages a repository has.
 */
export function BenchmarkLayout() {
  return (
    <BenchmarkScope>
      <BenchmarkFrame />
    </BenchmarkScope>
  );
}

function BenchmarkFrame() {
  const context = useOrg();
  const { url, pages, label } = useEvaluationScope();
  return (
    <RepoRunsProvider key={url} org={context.org.login} url={url}>
      <main className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <div
          className={cn("shrink-0 overflow-y-hidden pt-8 [scrollbar-gutter:stable]", pageGutter)}
        >
          <div className={cn(pageContainer, "relative")}>
            <div className="absolute top-0 right-0 hidden md:block">
              <ChartPreview pages={pages} />
            </div>
            <Breadcrumbs
              items={[
                { label: "Benchmarks", to: "/benchmarks" },
                { label, mono: true },
              ]}
            />
            <nav
              className="flex gap-6 overflow-x-auto border-b border-border [&_a]:shrink-0 [&_a]:border-b-2 [&_a]:border-transparent [&_a]:py-3 [&_a]:text-sm [&_a]:font-medium [&_a]:text-muted-foreground [&_a:hover]:text-foreground [&_a.active]:border-foreground [&_a.active]:text-foreground"
              aria-label="Benchmark Sections"
            >
              <NavLink to={pages} end>
                Dataset
              </NavLink>
              <NavLink to={`${pages}/run`}>Run</NavLink>
              <NavLink to={`${pages}/results`}>Results</NavLink>
            </nav>
          </div>
        </div>
        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto overscroll-contain py-8 [scrollbar-gutter:stable]",
            pageGutter,
          )}
          data-slot="repository-content"
        >
          <div className={pageContainer}>
            <Outlet context={context} />
          </div>
        </div>
      </main>
    </RepoRunsProvider>
  );
}
