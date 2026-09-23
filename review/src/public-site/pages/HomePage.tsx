import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigationType, useSearchParams } from "react-router";
import { RepoCard } from "../components/RepoCard";
import { SearchBox } from "../components/SearchBox";
import type { PublicRepoSummary } from "../contract";
import { select } from "../effects/marks";
import { publisherName } from "../format";
import { homeView, onSaveHome, saveHomeView, startJourney } from "../home-view";
import { APP_URL } from "../PublicLayout";
import type { PublicSource } from "../source";
import { useSource } from "../source-context";
import { useTitle } from "../use-title";

/** The directory shows at most this many cards; finding anything else is what search is for. */
const HOME_LIMIT = 100;

interface HomeData {
  repos: PublicRepoSummary[];
  lines: PublicRepoSummary[];
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
    Promise.all([source.listRepos(), source.listLines()]).then(
      ([repos, lines]) => {
        const next = { repos: repos.slice(0, HOME_LIMIT), lines };
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

const scroller = () => document.querySelector<HTMLElement>(select.scrollRoot);

export function HomePage() {
  useTitle("Self-Bench · dari.dev");
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
  // own view comes first; a fresh return from a repository page (the SELF-BENCH link) instead
  // names the home entry the trip started from.
  const restoreFrom = (location.state as { restoreFrom?: string } | null)?.restoreFrom;
  const restored = useRef<string>(undefined);
  // Typing a search replaces the entry, which gives it a new key; that is not an arrival.
  const replaced = useNavigationType() === "REPLACE";
  useLayoutEffect(() => {
    const area = scroller();
    if (!data || !area || restored.current === location.key) return;
    restored.current = location.key;
    if (replaced) return;
    const view = homeView(location.key) ?? homeView(restoreFrom);
    area.scrollTop = view?.scrollTop ?? 0;
    const card = view?.anchor && select.cardFor(area, view.anchor.line);
    if (card && view?.anchor) area.scrollTop += card.getBoundingClientRect().top - view.anchor.top;
  }, [data, restoreFrom, location.key, replaced]);

  // Records the view when history leaves this page.
  const save = useCallback(
    (leavingFor?: string) => {
      saveHomeView(location.key, {
        scrollTop: scroller()?.scrollTop ?? 0,
        query,
        anchor: undefined,
      });
      if (leavingFor) startJourney(location.key, leavingFor);
    },
    [location.key, query],
  );
  useEffect(() => {
    onSaveHome(save);
    return () => onSaveHome(undefined);
  }, [save]);

  // Records the view, and which card was opened, when a card is clicked.
  const opened = (card: PublicRepoSummary, element: HTMLElement) => {
    const line = `${card.repository.fullName}/${card.publisher.login}`;
    saveHomeView(location.key, {
      scrollTop: scroller()?.scrollTop ?? 0,
      query,
      anchor: { line, top: element.getBoundingClientRect().top },
    });
    startJourney(location.key, card.repository.fullName);
  };

  return (
    <div className="flex flex-col gap-10">
      <section className="mx-auto flex w-full max-w-2xl flex-col items-center gap-4 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          Find the best models for your repo
        </h1>
        <SearchBox query={query} onChange={setQuery} />
      </section>

      {!data && !failed && <p className="text-center text-muted-foreground">Loading…</p>}
      {failed && <p className="text-center text-muted-foreground">Results could not be loaded.</p>}
      {data &&
        (needle ? (
          <Grid
            cards={data.lines.filter((card) => matches(card, needle))}
            byLine
            onOpen={opened}
            empty={<NoMatch query={query.trim()} />}
          />
        ) : (
          <Grid cards={data.repos} onOpen={opened} empty={<NoMatch />} />
        ))}
    </div>
  );
}

/** A card matches on its repository, its publisher's login, or the name the card shows. */
function matches(card: PublicRepoSummary, needle: string): boolean {
  return [card.repository.fullName, card.publisher.login, publisherName(card.publisher)].some(
    (text) => text.toLowerCase().includes(needle),
  );
}

function Grid({
  cards,
  byLine = false,
  onOpen,
  empty,
}: {
  cards: PublicRepoSummary[];
  byLine?: boolean;
  onOpen: (card: PublicRepoSummary, element: HTMLElement) => void;
  empty: React.ReactNode;
}) {
  if (cards.length === 0) return empty;
  return (
    <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((card) => (
        <RepoCard
          key={card.releaseId}
          card={card}
          byLine={byLine}
          onOpen={(element) => onOpen(card, element)}
        />
      ))}
    </section>
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
