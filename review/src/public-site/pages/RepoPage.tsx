import { Star } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Link, useLocation, useNavigate, useNavigationType, useParams } from "react-router";
import { Avatar } from "../components/Avatar";
import {
  LayoutToggle,
  type ResultsLayout,
  readResultsLayout,
  rememberResultsLayout,
} from "../components/LayoutToggle";
import { ModelTable } from "../components/ModelTable";
import { ResultsChart } from "../components/ResultsChart";
import type { PublicRepoPage } from "../contract";
import { flightTo, revealFade, shownLine } from "../effects/marks";
import { plainClick } from "../effects/page-reveal";
import { ago, cleanDescription, compactNumber, publisherName } from "../format";
import { PANEL } from "../frame";
import { motionOff } from "../motion";
import { APP_URL } from "../PublicLayout";
import { scrollArea } from "../scroll-area";
import { repositoryTitle } from "../seo";
import { useSource } from "../source-context";
import { loadMemory, useLoad } from "../use-load";
import { useTitle } from "../use-title";

/**
 * Repository pages read during the visit, so coming back to one draws it at once, from the
 * first frame, while it is checked in the background. The latest 50 are kept.
 */
const visited = loadMemory<PublicRepoPage | undefined>(50);

export function RepoPage() {
  const { owner = "", name = "", publisher } = useParams();
  const source = useSource();
  const fullName = `${owner}/${name}`;
  const state = useLoad(
    `${fullName}/${publisher ?? ""}`,
    () => (publisher ? source.getLine(owner, name, publisher) : source.getRepo(owner, name)),
    // Runs of one repository share a group, so switching between them keeps the page up.
    fullName.toLowerCase(),
    visited,
  );
  // The repository's own casing once it is known, as the server writes it.
  useTitle(
    repositoryTitle(
      (state.status === "ready" && state.value?.release.repository.fullName) || fullName,
    ),
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
  // The chart's pointer and vendor chips mark the same settings in the table.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<ReadonlySet<string> | null>(null);
  // Another line of this repository reuses the page with other settings: nothing stays marked
  // from the last one (the chart, keyed by release, starts afresh too).
  const [markedRelease, setMarkedRelease] = useState(release.releaseId);
  if (markedRelease !== release.releaseId) {
    setMarkedRelease(release.releaseId);
    setActiveId(null);
    setHighlighted(null);
  }
  // Chart above the table, or beside it on a wide window; remembered across visits.
  const [layout, setLayout] = useState<ResultsLayout>(readResultsLayout);
  const article = useRef<HTMLElement>(null);
  const chooseLayout = (next: ResultsLayout) => {
    if (next === layout) return;
    rememberResultsLayout(next);
    const apply = () => flushSync(() => setLayout(next));
    // The blocks glide to their new places (theme.css); with motion off, or in a browser
    // without view transitions, they move at once.
    const page = article.current;
    if (!page || motionOff() || typeof document.startViewTransition !== "function") {
      apply();
      return;
    }
    page.setAttribute("data-morphing", "");
    document
      .startViewTransition(apply)
      .finished.finally(() => page.removeAttribute("data-morphing"));
  };
  const side = layout === "side";
  return (
    <article
      ref={article}
      // Side by side, on a window wide enough for it, the page widens past its usual column to
      // the rulers (at most 110rem), so the chart and the table each have room.
      className={`flex flex-col gap-8 ${
        side
          ? "min-[90rem]:mx-[calc(50%_-_min(100vw_-_2*var(--edge)_-_2*var(--gutter),110rem)/2)]"
          : ""
      }`}
      {...shownLine(`${repository.fullName}/${release.publisher.login}`)}
    >
      <header className="flex flex-col gap-3" data-morph="title">
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
          <span className="ml-auto self-center" data-morph="toggle">
            <LayoutToggle layout={layout} onChange={chooseLayout} />
          </span>
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

      {/* Side by side, the chart stays in view while the table scrolls past it. */}
      <div
        className={`flex flex-col gap-8 ${
          side
            ? "min-[90rem]:grid min-[90rem]:grid-cols-[minmax(420px,2fr)_minmax(720px,3fr)] min-[90rem]:items-start min-[90rem]:gap-6"
            : ""
        }`}
      >
        <section
          data-morph="chart"
          // min-w-0: side by side, each column keeps to its grid track, whatever its content.
          className={`flex min-w-0 flex-col gap-3 ${side ? "min-[90rem]:sticky min-[90rem]:top-[calc(var(--bar-top)_+_1rem)]" : ""}`}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-medium">Accuracy vs Cost per Task</h2>
            <p className="text-xs text-muted-foreground">
              Filled points are on the frontier: nothing is both cheaper and more accurate.
            </p>
          </div>
          <div className={`p-2 ${PANEL}`}>
            <ResultsChart
              key={release.releaseId}
              settings={release.settings}
              onActiveChange={setActiveId}
              onHighlightChange={setHighlighted}
            />
          </div>
        </section>

        <section className="flex min-w-0 flex-col gap-3" data-morph="table">
          <h2 className="text-sm font-medium">All Settings</h2>
          <ModelTable settings={release.settings} activeId={activeId} highlighted={highlighted} />
          <p className="text-xs text-muted-foreground">
            Every setting ran every one of the {release.tasks} tasks. Tasks come from merged pull
            requests in this repository; their tests and reference solutions stay private.
          </p>
        </section>
      </div>

      {page.lines.length > 1 && (
        <section ref={lines} className="flex flex-col gap-3" data-morph="lines">
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
