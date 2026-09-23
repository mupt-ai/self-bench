import { NavLink, Outlet, useParams } from "react-router";
import { BatchProvider } from "./batches/BatchProvider";
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
      <main className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <div className={cn("shrink-0 pt-8", pageGutter)}>
          <div className={pageContainer}>
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
            </nav>
          </div>
        </div>
        <div
          className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain py-8", pageGutter)}
          data-slot="repository-content"
        >
          <div className={pageContainer}>
            <Outlet context={context} />
          </div>
        </div>
      </main>
    </BatchProvider>
  );
}
