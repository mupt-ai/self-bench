import { NavLink, Outlet, useParams } from "react-router";
import { BatchProvider } from "./batches/BatchProvider";
import { ChartPreview } from "./evaluation/ChartPreview";
import { RepoRunsProvider } from "./evaluation/RepoRuns";
import { pageContainer, pageGutter } from "./layout";
import { cn } from "./primitives/cn";
import { useOrg } from "./SiteLayout";
import { Breadcrumbs } from "./ui";

export function RepoLayout() {
  const { owner, name } = useParams();
  const context = useOrg();
  const repo = `${owner}/${name}`;
  const base = `/repos/${repo}`;
  return (
    <BatchProvider
      key={`${context.org.login}/${repo}`}
      repoId={{ org: context.org.login, fullName: repo }}
    >
      <RepoRunsProvider org={context.org.login} repo={repo}>
        <main className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
          {/* Both parts reserve the scrollbar's slot, so the tabs and the page below them line up
            whether or not the page is tall enough to scroll. */}
          <div
            className={cn("shrink-0 overflow-y-hidden pt-8 [scrollbar-gutter:stable]", pageGutter)}
          >
            <div className={cn(pageContainer, "relative")}>
              {/* The model comparison, in the corner on the Results page; it opens to the full chart. */}
              <div className="absolute top-0 right-0 hidden md:block">
                <ChartPreview repo={repo} />
              </div>
              <Breadcrumbs
                items={[
                  { label: "Repositories", to: "/" },
                  { label: repo, mono: true },
                ]}
              />
              <nav
                className="flex gap-6 overflow-x-auto border-b border-border [&_a]:shrink-0 [&_a]:border-b-2 [&_a]:border-transparent [&_a]:py-3 [&_a]:text-sm [&_a]:font-medium [&_a]:text-muted-foreground [&_a:hover]:text-foreground [&_a.active]:border-foreground [&_a.active]:text-foreground"
                aria-label="Repository Sections"
              >
                <NavLink to={base} end>
                  Dataset
                </NavLink>
                <NavLink to={`${base}/batches`}>Batch Generation</NavLink>
                <NavLink to={`${base}/run`}>Run</NavLink>
                <NavLink to={`${base}/results`}>Results</NavLink>
                <NavLink to={`${base}/releases`}>Releases</NavLink>
                <NavLink to={`${base}/settings`} end>
                  Settings
                </NavLink>
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
    </BatchProvider>
  );
}
