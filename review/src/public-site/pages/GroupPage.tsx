import { Layers } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useParams } from "react-router";
import { mostAccurate } from "../../../../src/public/release-groups";
import { Avatar } from "../components/Avatar";
import { GroupLogo } from "../components/GroupCard";
import { SettingsPanels, useSettingMarks } from "../components/SettingsPanels";
import type { PublicGroup, PublicGroupCard, PublicGroupMember } from "../contract";
import { flightTo, pageBody, revealFade, revealGroup, shownLine } from "../effects/marks";
import { bodyHeld, watchBodyHold } from "../effects/transition-run";
import { ago, percent, publisherName, settingLabel } from "../format";
import { AdaptiveTable, type Column } from "../mobile/AdaptiveTable";
import { APP_URL } from "../PublicLayout";
import { groupKey, openedGroupCard, takeGroupRead, visitedGroups } from "../page-preload";
import { groupTitle } from "../seo";
import { useSource } from "../source-context";
import { useLoad } from "../use-load";
import { useTitle } from "../use-title";

/** What the title block shows: from the page's data, or from the card it was opened from. */
interface GroupHead {
  name: string;
  description?: string;
  logo?: string;
  repositories: string[];
  publisher: PublicGroup["publisher"];
  updatedAt: string;
  tasks: number;
  settings: number;
}

const headOf = (group: PublicGroup): GroupHead => ({
  name: group.name,
  ...(group.description ? { description: group.description } : {}),
  ...(group.logo ? { logo: group.logo } : {}),
  repositories: group.members.map((member) => member.repository.fullName),
  publisher: group.publisher,
  updatedAt: group.updatedAt,
  tasks: group.tasks,
  settings: group.settings.length,
});

const headOfCard = (card: PublicGroupCard): GroupHead => ({
  name: card.name,
  ...(card.description ? { description: card.description } : {}),
  ...(card.logo ? { logo: card.logo } : {}),
  repositories: card.repositories,
  publisher: card.publisher,
  updatedAt: card.updatedAt,
  tasks: card.tasks,
  settings: card.settings,
});

/**
 * A repository group's release: several repositories evaluated together. Its chart and table
 * score each setting over every member's tasks; the Repositories table shows how the setting
 * under the pointer (or each member's own best) did on each one. It opens from its card as a
 * repository page does: the title is drawn from the card at once, so it can fly into place, and
 * the body follows once its data is in and the flight has landed.
 * The server writes the same headings for readers that run no scripts (src/api/site-group.ts).
 */
export function GroupPage() {
  const { publisher = "", slug = "" } = useParams();
  const source = useSource();
  const key = groupKey(publisher, slug);
  const state = useLoad(
    key,
    // A read its card started as it was pressed, if there is one (page-preload.ts).
    () => takeGroupRead(key) ?? source.getGroup(publisher, slug),
    key,
    visitedGroups,
  );
  // While an opening flight is in the air, the body waits (transition-run.ts `holdBody`).
  const held = useSyncExternalStore(watchBodyHold, bodyHeld, () => false);
  const group = state.status === "ready" ? state.value : undefined;
  const card = openedGroupCard(key);
  useTitle(groupTitle(group?.name ?? card?.name ?? slug));
  if (state.status === "error" || (state.status === "ready" && !group)) return <NoGroup />;
  const head = group ? headOf(group) : card ? headOfCard(card) : undefined;
  if (!head) return <p className="text-muted-foreground">Loading…</p>;
  return <Group key={key} line={key} head={head} group={held ? undefined : group} />;
}

function Group({ line, head, group }: { line: string; head: GroupHead; group?: PublicGroup }) {
  const marks = useSettingMarks();
  const shown = marks.activeId ?? marks.rowId;
  const repositories = head.repositories.length;
  return (
    <article className="flex flex-col gap-8" {...shownLine(line)}>
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex shrink-0" {...flightTo("avatar")}>
            <GroupLogo logo={head.logo} size={32} />
          </span>
          <h1
            className="min-w-0 text-2xl font-semibold tracking-tight wrap-anywhere"
            {...flightTo("name")}
          >
            {head.name}
          </h1>
          <span
            className="flex items-center gap-1 font-mono text-sm text-muted-foreground"
            {...flightTo("stars")}
          >
            <Layers className="size-3.5" aria-hidden="true" />
            {repositories} repos
          </span>
        </div>
        <p className="line-clamp-2 max-w-3xl text-muted-foreground" {...flightTo("description")}>
          {head.description || head.repositories.join(" · ")}
        </p>
        {/* Fades in whole when the page is revealed after a card click, rather than assembling. */}
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" {...revealFade}>
          <span className="flex items-center gap-1.5">
            <Avatar src={head.publisher.avatarUrl} size={16} />
            Run by <strong className="font-medium">{publisherName(head.publisher)}</strong>
          </span>
          <span className="text-muted-foreground">· Released {ago(head.updatedAt)}</span>
          <span className="text-muted-foreground">·</span>
          <span className="font-mono">
            {repositories} {repositories === 1 ? "repository" : "repositories"}
          </span>
          <span className="text-muted-foreground">·</span>
          <span className="font-mono">{head.tasks} tasks</span>
          <span className="text-muted-foreground">·</span>
          <span className="font-mono">{head.settings} settings</span>
        </p>
      </header>

      {group &&
        (group.settings.length > 0 ? (
          <SettingsPanels
            {...marks}
            settings={group.settings}
            chartKey={group.releaseId}
            note="Each setting scored over every repository's tasks together."
          />
        ) : (
          <p className="text-muted-foreground" {...pageBody}>
            This release has no settings.
          </p>
        ))}

      {group && (
        <section {...revealGroup} className="flex min-w-0 flex-col gap-3">
          <h2 className="text-sm font-medium">Repositories</h2>
          <Members group={group} shownId={shown} />
        </section>
      )}
    </article>
  );
}

/**
 * Each member, with the accuracy there of the setting under the pointer, or else of the
 * member's own most accurate shared setting.
 */
function Members({ group, shownId }: { group: PublicGroup; shownId: string | null }) {
  const shown = group.settings.find((setting) => setting.id === shownId);
  const columns: Column<PublicGroupMember>[] = [
    {
      header: "Repository",
      role: "title",
      cell: (member) => (
        // A member need not be released on its own, so it links to its repository.
        <a
          href={`https://github.com/${member.repository.fullName}`}
          target="_blank"
          rel="noreferrer"
          className="hit relative flex min-w-0 items-center gap-2 font-mono font-medium wrap-anywhere hover:underline"
        >
          <Avatar src={member.repository.ownerAvatarUrl} size={16} />
          {member.repository.fullName}
        </a>
      ),
    },
    {
      header: "Tasks",
      role: "metric",
      className: "w-24",
      cell: (member) => <span className="font-mono tabular-nums">{member.tasks}</span>,
    },
    {
      header: shown ? `${settingLabel(shown, group.settings)} Accuracy` : "Most Accurate Here",
      role: "metric",
      className: "w-72",
      cell: (member) => {
        if (shown) {
          const score = member.scores[shown.id];
          // No results there is not a score of zero.
          return (
            <span className="font-mono tabular-nums">
              {score && score.tasks > 0 ? percent(score.accuracy) : "—"}
            </span>
          );
        }
        const best = mostAccurate(group, member);
        if (!best) return <span className="text-muted-foreground">—</span>;
        return (
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate">{best.label}</span>
            <span className="font-mono tabular-nums">{percent(best.accuracy)}</span>
          </span>
        );
      },
    },
  ];
  return (
    <AdaptiveTable
      columns={columns}
      rows={group.members}
      rowKey={(member) => String(member.repository.id)}
    />
  );
}

function NoGroup() {
  return (
    <section
      {...pageBody}
      className="mx-auto flex max-w-xl flex-col items-center gap-3 py-16 text-center"
    >
      <h1 className="text-2xl font-semibold">Group Not Found</h1>
      <p className="text-muted-foreground">Nothing is released for this group.</p>
      <a
        href={APP_URL}
        className="hit relative border border-foreground px-3 py-1.5 text-sm hover:bg-foreground hover:text-background"
      >
        Run SelfBench on It
      </a>
    </section>
  );
}
