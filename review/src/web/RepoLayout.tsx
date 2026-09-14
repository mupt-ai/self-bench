import { NavLink, Outlet, useParams } from "react-router";
import { BatchProvider } from "./batches/BatchProvider";
import { pageGutter } from "./layout";
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
      <main className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <div className={cn("shrink-0 pt-6", pageGutter)}>
          <Breadcrumbs items={[{ label: "Repositories", to: "/" }, { label: repo }]} />
          <nav
            className="flex gap-6 overflow-x-auto border-b border-border [&_a]:shrink-0 [&_a]:border-b-2 [&_a]:border-transparent [&_a]:py-3 [&_a]:text-sm [&_a]:text-muted-foreground [&_a:hover]:text-foreground [&_a.active]:border-brand [&_a.active]:text-foreground"
            aria-label="Repository Sections"
          >
            <NavLink to={base} end>
              Dataset
            </NavLink>
            <NavLink to={`${base}/batches`}>Batches</NavLink>
            <NavLink to={`${base}/run`}>Run</NavLink>
            <NavLink to={`${base}/results`}>Results</NavLink>
          </nav>
        </div>
        <div
          className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain py-6", pageGutter)}
          data-slot="repository-content"
        >
          <Outlet context={context} />
        </div>
      </main>
    </BatchProvider>
  );
}
