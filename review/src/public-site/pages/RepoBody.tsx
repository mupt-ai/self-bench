import type { RefObject } from "react";
import { Link, useNavigate } from "react-router";
import { Avatar } from "../components/Avatar";
import { ModelTable } from "../components/ModelTable";
import { ResultsChart } from "../components/ResultsChart";
import type { PublicRepoPage } from "../contract";
import { pageBody, revealGroup } from "../effects/marks";
import { plainClick } from "../effects/page-reveal";
import { ago, publisherName } from "../format";
import { PANEL } from "../frame";

/**
 * Navigation state from an "Other Benchmarks" link: where that section sat on screen when it
 * was clicked, so the next page can scroll to keep it in the same place.
 */
export interface PinnedLines {
  linesTop: number;
}

/**
 * Everything on a repository page below its title: the chart, the settings table, and the
 * repository's other benchmarks. It needs the page's data, and is the heaviest thing the page
 * draws, so an opening transition holds it back until the title has landed (RepoPage.tsx).
 */
export function RepoBody({
  page,
  side,
  lines,
  activeId,
  rowId,
  highlighted,
  onActiveChange,
  onHighlightChange,
  onRowHover,
}: {
  page: PublicRepoPage;
  /** The chart beside the table, on a wide window, rather than above it. */
  side: boolean;
  lines: RefObject<HTMLElement | null>;
  activeId: string | null;
  rowId: string | null;
  highlighted: ReadonlySet<string> | null;
  onActiveChange: (id: string | null) => void;
  onHighlightChange: (ids: ReadonlySet<string> | null) => void;
  onRowHover: (id: string | null) => void;
}) {
  const { release } = page;
  const { repository } = release;
  const navigate = useNavigate();
  return (
    <>
      {/* Side by side, the chart stays in view while the table scrolls past it. */}
      <div
        {...pageBody}
        className={`flex flex-col gap-8 ${
          side
            ? "min-[90rem]:grid min-[90rem]:grid-cols-[minmax(420px,2fr)_minmax(720px,3fr)] min-[90rem]:items-start min-[90rem]:gap-6"
            : ""
        }`}
      >
        <section
          {...revealGroup}
          data-morph="chart"
          // min-w-0: side by side, each column keeps to its grid track, whatever its content.
          className={`flex min-w-0 flex-col gap-3 ${side ? "min-[90rem]:sticky min-[90rem]:top-[calc(var(--bar-top)_+_1rem)]" : ""}`}
        >
          <h2 className="text-sm font-medium">Accuracy vs Cost per Task</h2>
          <div className={`p-2 ${PANEL}`}>
            <ResultsChart
              key={release.releaseId}
              settings={release.settings}
              onActiveChange={onActiveChange}
              onHighlightChange={onHighlightChange}
              selectedId={rowId}
            />
          </div>
        </section>

        <section className="flex min-w-0 flex-col gap-3" data-morph="table" {...revealGroup}>
          <h2 className="text-sm font-medium">All Settings</h2>
          <ModelTable
            settings={release.settings}
            activeId={activeId ?? rowId}
            highlighted={highlighted}
            onRowHover={onRowHover}
          />
        </section>
      </div>

      {page.lines.length > 1 && (
        <section ref={lines} className="flex flex-col gap-3" data-morph="lines" {...revealGroup}>
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
    </>
  );
}
