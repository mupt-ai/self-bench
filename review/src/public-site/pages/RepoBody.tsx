import type { RefObject } from "react";
import { Link, useNavigate } from "react-router";
import { Avatar } from "../components/Avatar";
import { SettingsResults } from "../components/SettingsResults";
import { TaskList } from "../components/TaskList";
import type { PublicRepoPage } from "../contract";
import { revealGroup } from "../effects/marks";
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
      <SettingsResults
        releaseId={release.releaseId}
        settings={release.settings}
        side={side}
        activeId={activeId}
        rowId={rowId}
        highlighted={highlighted}
        onActiveChange={onActiveChange}
        onHighlightChange={onHighlightChange}
        onRowHover={onRowHover}
      />

      {release.tasksPublished && <TaskList release={release} />}

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
