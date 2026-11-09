import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigationType, useSearchParams } from "react-router";
import { GroupCard } from "../components/GroupCard";
import { RepoCard } from "../components/RepoCard";
import { SearchBox } from "../components/SearchBox";
import type { PublicGroupCard, PublicRepoSummary } from "../contract";
import { select } from "../effects/marks";
import { publisherName } from "../format";
import { homeView, onSaveHome, saveHomeView, startJourney } from "../home-view";
import { APP_URL } from "../PublicLayout";
import { groupKey } from "../page-preload";
import { scrollArea } from "../scroll-area";
import { DIRECTORY_VIEWS, type DirectoryView, listedIn } from "../seo";
import type { PublicSource } from "../source";
import { useSource } from "../source-context";
import { useTitle } from "../use-title";

/** The directory shows at most this many cards; finding anything else is what search is for. */
const HOME_LIMIT = 100;

interface HomeData {
  repos: PublicRepoSummary[];
  lines: PublicRepoSummary[];
  groups: PublicGroupCard[];
}

/**
 * The directory, kept in memory for the visit, so coming back renders it at once, in the same
 * order, and the scroll position lands exactly. Each visit also refreshes it in the
 * background and only updates if something changed.
 */
let kept: HomeData | undefined;

function useHomeData(source: PublicSource) {
  const [data, setData] = useState(kept);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.all([source.listRepos(), source.listLines(), source.listGroups()]).then(
      ([repos, lines, groups]) => {
        const next = { repos, lines, groups };
        if (!live || JSON.stringify(next) === JSON.stringify(kept)) return;
        kept = next;
        setData(next);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [source]);
  return { data, failed: failed && !data };
}

/**
 * The directory: one of its views (seo.ts `DIRECTORY_VIEWS`), repositories with their groups at
 * `/` or evals at `/evals`, each a tab of the same page, with the same grid, search, and cards.
 */
export function HomePage({ view }: { view: DirectoryView }) {
  const shown = DIRECTORY_VIEWS[view];
  useTitle(shown.title);
  const { data, failed } = useHomeData(useSource());
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  // The search lives in the address, so back, reload, and links all keep it.
  const setQuery = (next: string) =>
    setParams(next ? { q: next } : {}, { replace: true, state: location.state });
  const needle = query.trim().toLowerCase();

  // Back to where the visitor left this page, before the first frame is drawn: to the card
  // they opened, placed where it was on screen, or else the same scroll offset. This entry's
  // own view comes first; a fresh return from a repository page via the logo instead names
  // the home entry the trip started from.
  const restoreFrom = (location.state as { restoreFrom?: string } | null)?.restoreFrom;
  const restored = useRef<string>(undefined);
  // Typing a search replaces the entry, which gives it a new key; that is not an arrival.
  const replaced = useNavigationType() === "REPLACE";
  useLayoutEffect(() => {
    const area = scrollArea();
    if (!data || !area || restored.current === location.key) return;
    restored.current = location.key;
    if (replaced) return;
    const view = homeView(location.key) ?? homeView(restoreFrom);
    area.scrollTo(view?.scrollTop ?? 0);
    const card = view?.anchor && select.cardFor(area.content, view.anchor.line);
    if (card && view?.anchor)
      area.scrollTo(area.top() + card.getBoundingClientRect().top - view.anchor.top);
  }, [data, restoreFrom, location.key, replaced]);

  // Records the view when history leaves this page.
  const save = useCallback(
    (leavingFor?: string) => {
      saveHomeView(location.key, {
        path: location.pathname,
        scrollTop: window.scrollY,
        query,
        anchor: undefined,
      });
      if (leavingFor) startJourney(location.key, leavingFor);
    },
    [location.key, location.pathname, query],
  );
  useEffect(() => {
    onSaveHome(save);
    return () => onSaveHome(undefined);
  }, [save]);

  // Records the view, and which card was opened, when a card is clicked: the run it shows,
  // and what its page shows (home-view.ts `repositoryOf`), for the trip back.
  const opened = (line: string, subject: string, element: HTMLElement) => {
    saveHomeView(location.key, {
      path: location.pathname,
      scrollTop: window.scrollY,
      query,
      anchor: { line, top: element.getBoundingClientRect().top },
    });
    startJourney(location.key, subject);
  };

  return (
    <div className="flex flex-col gap-10">
      <Tabs view={view} query={query} />
      {/*
        The heading stays on one line on any screen: the line is just under 16em wide, so its
        size follows the section's width (cqi), up to 1.5rem.
      */}
      <section className="@container mx-auto flex w-full max-w-2xl flex-col items-center gap-4 text-center">
        <h1 className="text-[length:min(1.5rem,100cqi/16)] leading-[calc(2/1.5)] font-semibold tracking-tight">
          {shown.heading}
        </h1>
        <SearchBox query={query} label={shown.search} onChange={setQuery} />
      </section>

      {!data && !failed && <p className="text-center text-muted-foreground">Loading…</p>}
      {failed && <p className="text-center text-muted-foreground">Results could not be loaded.</p>}
      {data && <Directory data={data} view={view} needle={needle} query={query} onOpen={opened} />}
    </div>
  );
}

/**
 * The directory's views as tabs along the top of the page, quiet beside the heading and search:
 * each its own address, and a search goes along to the other. A fixed set (seo.ts
 * `DIRECTORY_VIEWS`): a new view is one entry there.
 */
function Tabs({ view, query }: { view: DirectoryView; query: string }) {
  return (
    <nav aria-label="Directory" className="-mb-4 flex gap-5 border-b border-border text-sm">
      {(Object.keys(DIRECTORY_VIEWS) as DirectoryView[]).map((each) => (
        <Link
          key={each}
          to={{
            pathname: DIRECTORY_VIEWS[each].path,
            search: query ? `?q=${encodeURIComponent(query)}` : "",
          }}
          aria-current={each === view ? "page" : undefined}
          className={`hit relative -mb-px border-b-[1.5px] pb-2 transition-colors ${
            each === view
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          {DIRECTORY_VIEWS[each].tab}
        </Link>
      ))}
    </nav>
  );
}

/**
 * One grid of the view's cards, every card alike: for repositories, the repository groups, then
 * each repository's default line; for evals, each eval's. With a search, every line and group
 * that matches it.
 */
function Directory({
  data,
  view,
  needle,
  query,
  onOpen,
}: {
  data: HomeData;
  view: DirectoryView;
  needle: string;
  query: string;
  onOpen: (line: string, subject: string, element: HTMLElement) => void;
}) {
  const groups =
    view !== "repositories"
      ? []
      : needle
        ? data.groups.filter((card) => groupMatches(card, needle))
        : data.groups;
  const cards = (needle ? data.lines.filter((card) => matches(card, needle)) : data.repos)
    .filter((card) => listedIn(view, card.repository.fullName))
    .slice(0, needle ? undefined : HOME_LIMIT);
  if (groups.length === 0 && cards.length === 0)
    return <NoMatch query={needle ? query.trim() : undefined} />;
  // One grid for both: a group is a card like any repository.
  // One column on a phone, sized to the screen: without a template, the column would stretch
  // to fit the longest line any card holds, even one the card truncates.
  return (
    <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {groups.map((card) => {
        const key = groupKey(card.publisher.login, card.slug);
        return <GroupCard key={key} card={card} onOpen={(element) => onOpen(key, key, element)} />;
      })}
      {cards.map((card) => (
        <RepoCard
          key={card.releaseId}
          card={card}
          byLine={!!needle}
          onOpen={(element) =>
            onOpen(
              `${card.repository.fullName}/${card.publisher.login}`,
              card.repository.fullName,
              element,
            )
          }
        />
      ))}
    </section>
  );
}

/** A group matches on its name, address, publisher, or any member repository. */
function groupMatches(card: PublicGroupCard, needle: string): boolean {
  return [card.name, card.slug, card.publisher.login, publisherName(card.publisher)]
    .concat(card.repositories)
    .some((text) => text.toLowerCase().includes(needle));
}

/** A card matches on its repository, its publisher's login, or the name the card shows. */
function matches(card: PublicRepoSummary, needle: string): boolean {
  return [card.repository.fullName, card.publisher.login, publisherName(card.publisher)].some(
    (text) => text.toLowerCase().includes(needle),
  );
}

function NoMatch({ query }: { query?: string }) {
  return (
    <section className="mx-auto flex max-w-md flex-col items-center gap-3 py-8 text-center">
      <p className="text-muted-foreground">
        {query ? (
          <>
            No evals for <span className="font-mono text-foreground">{query}</span> yet.
          </>
        ) : (
          "No evals yet."
        )}
      </p>
      <a
        href={APP_URL}
        className="border border-foreground px-3 py-1.5 text-sm hover:bg-foreground hover:text-background"
      >
        Run SelfBench on It
      </a>
    </section>
  );
}
