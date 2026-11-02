import { NavLink, Outlet } from "react-router";
import { ChartPreview } from "./evaluation/ChartPreview";
import { RepoRunsProvider } from "./evaluation/RepoRuns";
import { useEvaluationScope } from "./evaluation/useEvaluationScope";
import { pageContainer, pageGutter } from "./layout";
import { cn } from "./primitives/cn";
import { useOrg } from "./SiteLayout";
import { Breadcrumbs } from "./ui";

/** A tab beside the Dataset, Run, and Results tabs every scope has, at `pages` plus `path`. */
export interface ScopeTab {
  path: string;
  label: string;
}

/**
 * The frame of a repository's or benchmark's pages: breadcrumbs, the section tabs, and the page
 * below them, with the scope's runs shared by the Results page and the chart preview. Both get the
 * same Dataset, Run, and Results tabs; a repository adds the tabs that edit and publish its tasks.
 */
export function ScopeLayout({
  afterDataset = [],
  afterResults = [],
}: {
  afterDataset?: readonly ScopeTab[];
  afterResults?: readonly ScopeTab[];
}) {
  const context = useOrg();
  const { url, pages, label, parent, repo, kind } = useEvaluationScope();
  const tabs = [
    ...afterDataset,
    { path: "/run", label: "Run" },
    { path: "/results", label: "Results" },
    ...afterResults,
  ];
  return (
    <RepoRunsProvider key={url} org={context.org.login} url={url} {...(repo ? { repo } : {})}>
      <main className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        {/* Both parts reserve the scrollbar's slot, so the tabs and the page below them line up
            whether or not the page is tall enough to scroll. */}
        <div
          className={cn("shrink-0 overflow-y-hidden pt-8 [scrollbar-gutter:stable]", pageGutter)}
        >
          <div className={cn(pageContainer, "relative")}>
            {/* The model comparison, in the corner on the Results page; it opens to the full chart. */}
            <div className="absolute top-0 right-0 hidden md:block">
              <ChartPreview pages={pages} />
            </div>
            <Breadcrumbs items={[parent, { label, mono: true }]} />
            <nav
              className="flex gap-6 overflow-x-auto border-b border-border [&_a]:shrink-0 [&_a]:border-b-2 [&_a]:border-transparent [&_a]:py-3 [&_a]:text-sm [&_a]:font-medium [&_a]:text-muted-foreground [&_a:hover]:text-foreground [&_a.active]:border-foreground [&_a.active]:text-foreground"
              aria-label={kind === "repository" ? "Repository Sections" : "Benchmark Sections"}
            >
              <NavLink to={pages} end>
                Dataset
              </NavLink>
              {tabs.map((tab) => (
                <NavLink key={tab.path} to={`${pages}${tab.path}`} end={tab.path === "/settings"}>
                  {tab.label}
                </NavLink>
              ))}
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
