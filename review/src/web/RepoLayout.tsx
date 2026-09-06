import { Link, NavLink, Outlet, useParams } from "react-router";
import { useOrg } from "./SiteLayout";

export function RepoLayout() {
  const { owner, name } = useParams();
  const context = useOrg();
  const repo = `${owner}/${name}`;
  const base = `/repos/${repo}`;
  return (
    <main className="w-full min-w-0 flex-1 px-4 pt-8 pb-12 sm:px-[var(--site-gutter)]">
      <nav
        className="mb-4 flex min-w-0 items-center gap-3 font-mono text-xs text-dim"
        aria-label="Breadcrumb"
      >
        <Link className="shrink-0 text-muted hover:text-mint" to="/">
          Repositories
        </Link>
        <span aria-hidden="true">/</span>
        <span className="truncate">{repo}</span>
      </nav>
      <nav
        className="mb-7 flex gap-7 overflow-x-auto border-b border-line [&_a]:border-b-2 [&_a]:border-transparent [&_a]:py-3 [&_a]:font-mono [&_a]:text-xs [&_a]:text-dim [&_a.active]:border-mint [&_a.active]:text-mint"
        aria-label="Repository sections"
      >
        <NavLink to={base} end>
          Review
        </NavLink>
        <NavLink to={`${base}/dataset`}>Dataset</NavLink>
        <NavLink to={`${base}/run`}>Run</NavLink>
        <NavLink to={`${base}/results`}>Results</NavLink>
        <NavLink to={`${base}/settings/credentials`}>Settings</NavLink>
      </nav>
      <Outlet context={context} />
    </main>
  );
}
