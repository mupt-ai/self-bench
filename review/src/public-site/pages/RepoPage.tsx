import { Star } from "lucide-react";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { useLocation, useNavigationType, useParams } from "react-router";
import { Avatar } from "../components/Avatar";
import {
  LayoutToggle,
  type ResultsLayout,
  readResultsLayout,
  rememberResultsLayout,
} from "../components/LayoutToggle";
import { OpenTask } from "../components/OpenTask";
import { OpenTrace } from "../components/OpenTrace";
import type { PublicPublisher, PublicRepoPage, PublicRepoSummary } from "../contract";
import { flightTo, pageBody, revealFade, shownLine } from "../effects/marks";
import { bodyHeld, watchBodyHold } from "../effects/transition-run";
import { ago, cleanDescription, compactNumber, publisherName } from "../format";
import { motionOff } from "../motion";
import { APP_URL } from "../PublicLayout";
import { cardOf, pageKey, takeRead, visitedPages } from "../page-preload";
import { scrollArea } from "../scroll-area";
import { repositoryTitle } from "../seo";
import { useSource } from "../source-context";
import { useLoad } from "../use-load";
import { useTitle } from "../use-title";
import { type PinnedLines, RepoBody } from "./RepoBody";

/**
 * What a repository page's title block shows. A page opened from a card draws it from the card
 * at once, so the opening flight never waits for the page's data; the data takes over when in.
 */
interface PageHead {
  repository: Pick<PublicRepoSummary["repository"], "fullName" | "description" | "stars">;
  ownerAvatarUrl?: string;
  publisher: PublicPublisher;
  releasedAt: string;
  tasks: number;
  settings: number;
  endorsed: boolean;
}

const headOf = (page: PublicRepoPage): PageHead => ({
  repository: page.release.repository,
  ownerAvatarUrl: page.release.repository.ownerAvatarUrl,
  publisher: page.release.publisher,
  releasedAt: page.release.releasedAt,
  tasks: page.release.tasks,
  settings: page.release.settings.length,
  endorsed: page.endorsed,
});

const headOfCard = (card: PublicRepoSummary): PageHead => ({
  repository: card.repository,
  ownerAvatarUrl: card.repository.ownerAvatarUrl,
  publisher: card.publisher,
  releasedAt: card.releasedAt,
  tasks: card.tasks,
  settings: card.settings,
  endorsed: card.endorsed,
});

export function RepoPage() {
  const { owner = "", name = "", publisher } = useParams();
  const source = useSource();
  const fullName = `${owner}/${name}`;
  const key = pageKey(fullName, publisher);
  const state = useLoad(
    key,
    // A read its card started as it was pressed, if there is one (page-preload.ts).
    () =>
      takeRead(key) ??
      (publisher ? source.getLine(owner, name, publisher) : source.getRepo(owner, name)),
    // Runs of one repository share a group, so switching between them keeps the page up.
    fullName.toLowerCase(),
    visitedPages,
  );
  // While an opening flight is in the air, the body waits (transition-run.ts `holdBody`).
  const held = useSyncExternalStore(watchBodyHold, bodyHeld, () => false);
  // The repository's own casing once it is known, as the server writes it.
  useTitle(
    repositoryTitle(
      (state.status === "ready" && state.value?.release.repository.fullName) || fullName,
    ),
  );
  const page = state.status === "ready" ? state.value : undefined;
  if (state.status === "error" || (state.status === "ready" && !page))
    return <NoResults fullName={fullName} />;
  const card = cardOf(key);
  const head = page ? headOf(page) : card ? headOfCard(card) : undefined;
  if (!head) return <p className="text-muted-foreground">Loading…</p>;
  return <Results head={head} page={held ? undefined : page} />;
}

/** The page: its title block from `head`, and the rest once `page` is given. */
function Results({ head, page }: { head: PageHead; page?: PublicRepoPage }) {
  const release = page?.release;
  const lines = useRef<HTMLElement>(null);
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
  }, [release?.releaseId]);
  const { repository } = head;
  const [owner, name] = repository.fullName.split("/");
  // The chart's pointer and vendor chips mark the same settings in the table, and the table
  // row under the pointer lights up its point.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<ReadonlySet<string> | null>(null);
  const [rowId, setRowId] = useState<string | null>(null);
  // Another line of this repository reuses the page with other settings: nothing stays marked
  // from the last one (the chart, keyed by release, starts afresh too).
  const [markedRelease, setMarkedRelease] = useState(release?.releaseId);
  if (markedRelease !== release?.releaseId) {
    setMarkedRelease(release?.releaseId);
    setActiveId(null);
    setHighlighted(null);
    setRowId(null);
  }
  // Chart above the table, or beside it on a wide window; remembered across visits.
  const [layout, setLayout] = useState<ResultsLayout>(readResultsLayout);
  const article = useRef<HTMLElement>(null);
  const glide = useRef<ViewTransition | null>(null);
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
    // The root says which way it goes: the transition's pictures hang off the root element.
    const root = document.documentElement;
    page.setAttribute("data-morphing", "");
    root.dataset.morphTo = next;
    // A switch made mid-glide cuts the last one short; only the latest one clears up, or the
    // earlier one would clear the marks the new one is using.
    const transition = document.startViewTransition(apply);
    glide.current = transition;
    transition.finished.finally(() => {
      if (glide.current !== transition) return;
      glide.current = null;
      page.removeAttribute("data-morphing");
      delete root.dataset.morphTo;
    });
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
      {...shownLine(`${repository.fullName}/${head.publisher.login}`)}
    >
      <header className="flex flex-col gap-3" data-morph="title">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex shrink-0" {...flightTo("avatar")}>
            <Avatar src={head.ownerAvatarUrl} size={32} />
          </span>
          {/* The page's heading, as in the page text the server writes (src/api/site-body.ts):
              without it, a crawler that runs the page finds no h1 once this replaces that text. */}
          <h1 className="min-w-0 font-mono text-2xl font-medium" {...flightTo("name")}>
            <a
              href={`https://github.com/${repository.fullName}`}
              target="_blank"
              rel="noreferrer"
              className="hit relative block hover:underline"
            >
              {/* A long name wraps after the owner, never inside a word. */}
              {owner}/<wbr />
              {name}
            </a>
          </h1>
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
            <Avatar src={head.publisher.avatarUrl} size={16} />
            Run by <strong className="font-medium">{publisherName(head.publisher)}</strong>
          </span>
          <span className="text-muted-foreground">· Released {ago(head.releasedAt)}</span>
          <span className="text-muted-foreground">·</span>
          <span className="font-mono">{head.tasks} tasks</span>
          <span className="text-muted-foreground">·</span>
          <span className="font-mono">{head.settings} settings</span>
          {head.endorsed && (
            <span className="border border-border px-1.5 py-0.5 text-xs">
              Endorsed by Maintainers
            </span>
          )}
        </p>
      </header>

      {page && (
        <RepoBody
          page={page}
          side={side}
          lines={lines}
          activeId={activeId}
          rowId={rowId}
          highlighted={highlighted}
          onActiveChange={setActiveId}
          onHighlightChange={setHighlighted}
          onRowHover={setRowId}
        />
      )}
      {release?.tasksPublished && <OpenTask release={release} />}
      {release?.trialsPublished && <OpenTrace release={release} />}
    </article>
  );
}

function NoResults({ fullName }: { fullName: string }) {
  return (
    // The whole page, with no title to fly to: an opening assembles it as it is.
    <section
      {...pageBody}
      className="mx-auto flex max-w-xl flex-col items-center gap-3 py-16 text-center"
    >
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
