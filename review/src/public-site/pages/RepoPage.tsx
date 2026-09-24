import { Star } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { Link, useLocation, useNavigate, useNavigationType, useParams } from "react-router";
import { Avatar } from "../components/Avatar";
import { ModelTable } from "../components/ModelTable";
import { Picks } from "../components/Picks";
import { ResultsChart } from "../components/ResultsChart";
import type { PublicRepoPage } from "../contract";
import { flightTo, revealFade, shownLine } from "../effects/marks";
import { plainClick } from "../effects/page-reveal";
import { ago, cleanDescription, compactNumber, publisherName } from "../format";
import { PANEL } from "../frame";
import { APP_URL } from "../PublicLayout";
import { picks } from "../picks";
import { scrollArea } from "../scroll-area";
import { useSource } from "../source-context";
import { useLoad } from "../use-load";
import { useTitle } from "../use-title";

export function RepoPage() {
  const { owner = "", name = "", publisher } = useParams();
  const source = useSource();
  const fullName = `${owner}/${name}`;
  useTitle(`${fullName} · Self-Bench · dari.dev`);
  const state = useLoad(
    `${fullName}/${publisher ?? ""}`,
    () => (publisher ? source.getLine(owner, name, publisher) : source.getRepo(owner, name)),
    // Runs of one repository share a group, so switching between them keeps the page up.
    fullName.toLowerCase(),
  );
  if (state.status === "loading") return <p className="text-muted-foreground">Loading…</p>;
  if (state.status === "error" || !state.value) return <NoResults fullName={fullName} />;
  return <Results page={state.value} />;
}

/**
 * Navigation state from an "Other Benchmarks" link: where that section sat on screen when it
 * was clicked, so the next page can scroll to keep it in the same place.
 */
interface PinnedLines {
  linesTop: number;
}

function Results({ page }: { page: PublicRepoPage }) {
  const { release } = page;
  const lines = useRef<HTMLElement>(null);
  const navigate = useNavigate();
  const state = useLocation().state as PinnedLines | null;
  // Only the click that set it: back and forward reuse the entry's state, and must not re-pin.
  const pinned = useNavigationType() === "PUSH" ? state?.linesTop : undefined;
  // Switching between benchmarks of one repo keeps that section still; the page moves around it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per release shown
  useLayoutEffect(() => {
    const section = lines.current;
    const area = scrollArea();
    if (pinned === undefined || !section || !area) return;
    area.scrollTo(area.top() + section.getBoundingClientRect().top - pinned);
  }, [release.releaseId]);
  const { repository } = release;
  const [owner, name] = repository.fullName.split("/");
  return (
    <article
      className="flex flex-col gap-8"
      {...shownLine(`${repository.fullName}/${release.publisher.login}`)}
    >
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex shrink-0" {...flightTo("avatar")}>
            <Avatar src={repository.ownerAvatarUrl} size={32} />
          </span>
          <a
            href={`https://github.com/${repository.fullName}`}
            target="_blank"
            rel="noreferrer"
            className="hit relative min-w-0 font-mono text-2xl font-medium hover:underline"
            {...flightTo("name")}
          >
            {/* A long name wraps after the owner, never inside a word. */}
            {owner}/<wbr />
            {name}
          </a>
          {repository.stars !== undefined && (
            <span
              className="flex items-center gap-1 font-mono text-sm text-muted-foreground"
              {...flightTo("stars")}
            >
              <Star className="size-3.5 fill-current" aria-hidden="true" />
              {compactNumber(repository.stars)}
            </span>
          )}
        </div>
        {repository.description && (
          <p className="line-clamp-2 max-w-3xl text-muted-foreground" {...flightTo("description")}>
            {cleanDescription(repository.description)}
          </p>
        )}
        {/* Fades in whole when the page is revealed after a card click, rather than assembling. */}
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" {...revealFade}>
          <span className="flex items-center gap-1.5">
            <Avatar src={release.publisher.avatarUrl} size={16} />
            Run by <strong className="font-medium">{publisherName(release.publisher)}</strong>
          </span>
          <span className="text-muted-foreground">· Released {ago(release.releasedAt)}</span>
          <span className="text-muted-foreground">·</span>
          <span className="font-mono">{release.tasks} tasks</span>
          <span className="text-muted-foreground">·</span>
          <span className="font-mono">{release.settings.length} settings</span>
          {page.endorsed && (
            <span className="border border-border px-1.5 py-0.5 text-xs">
              Endorsed by Maintainers
            </span>
          )}
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">On this eval set of {release.tasks} tasks</h2>
        <Picks picks={picks(release.settings)} settings={release.settings} />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium">Accuracy vs Cost per Task</h2>
          <p className="text-xs text-muted-foreground">
            Filled points are on the frontier: nothing is both cheaper and more accurate.
          </p>
        </div>
        <div className={`p-2 ${PANEL}`}>
          <ResultsChart settings={release.settings} />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">All Settings</h2>
        <ModelTable settings={release.settings} />
        <p className="text-xs text-muted-foreground">
          Every setting ran every one of the {release.tasks} tasks. Tasks come from merged pull
          requests in this repository; their tests and reference solutions stay private.
        </p>
      </section>

      {page.lines.length > 1 && (
        <section ref={lines} className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">Other Benchmarks of This Repo</h2>
          <ul className={`divide-y divide-border ${PANEL}`}>
            {page.lines.map((line) => {
              const current = line.releaseId === release.releaseId;
              return (
                <li key={line.releaseId}>
                  <Link
                    to={`/${repository.fullName}/${line.publisher.login}`}
                    aria-current={current ? "page" : undefined}
                    onClick={(event) => {
                      const linesTop = lines.current?.getBoundingClientRect().top;
                      if (linesTop === undefined || !plainClick(event)) return;
                      event.preventDefault();
                      navigate(`/${repository.fullName}/${line.publisher.login}`, {
                        state: { linesTop } satisfies PinnedLines,
                      });
                    }}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm hover:bg-muted aria-[current=page]:bg-muted touch:py-3"
                  >
                    <Avatar src={line.publisher.avatarUrl} size={16} />
                    <span className="font-medium">{publisherName(line.publisher)}</span>
                    <span className="font-mono text-muted-foreground">
                      {line.tasks} tasks · {line.settings} settings
                    </span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {current ? "Showing" : `Released ${ago(line.releasedAt)}`}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </article>
  );
}

function NoResults({ fullName }: { fullName: string }) {
  return (
    <section className="mx-auto flex max-w-xl flex-col items-center gap-3 py-16 text-center">
      <h1 className="font-mono text-2xl font-medium">{fullName}</h1>
      <p className="text-muted-foreground">No evals for this repo yet.</p>
      <a
        href={APP_URL}
        className="hit relative border border-foreground px-3 py-1.5 text-sm hover:bg-foreground hover:text-background"
      >
        Run SelfBench on It
      </a>
    </section>
  );
}
