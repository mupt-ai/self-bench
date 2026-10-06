import { Layers } from "lucide-react";
import { Link } from "react-router";
import type { PublicGroupSummary } from "../contract";
import { ago, publisherName } from "../format";
import { PANEL } from "../frame";
import { Avatar } from "./Avatar";
import { CardPicks } from "./RepoCard";

/** How many member avatars a card stacks before it counts the rest. */
const AVATARS = 4;

/**
 * A group's card: its name and how many repositories it pools, their names where a repository's
 * card has its description, then the same two picks and footer as a repository's card.
 */
export function GroupCard({
  card,
  onOpen,
}: {
  card: PublicGroupSummary;
  /** Called as the card is opened, before navigating. */
  onOpen?: () => void;
}) {
  const { members } = card.group;
  return (
    <Link
      to={`/groups/${card.group.slug}`}
      onClick={onOpen}
      className={`group relative flex flex-col gap-3 px-4 pt-4 pb-2.5 transition-[border-color,box-shadow] hover:border-foreground/30 hover:shadow-[0_2px_4px_rgb(0_0_0/0.06),0_10px_24px_-8px_rgb(0_0_0/0.14)] focus-visible:border-foreground/40 ${PANEL}`}
    >
      <div className="flex items-center gap-2.5">
        <span className="flex shrink-0 -space-x-1.5">
          {members.slice(0, AVATARS).map((member) => (
            <Avatar key={member.id} src={member.ownerAvatarUrl} size={20} />
          ))}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold group-hover:underline">
          {card.group.name}
        </span>
        <span className="flex shrink-0 items-center gap-1 font-mono text-xs text-muted-foreground">
          <Layers className="size-3" aria-hidden="true" />
          {members.length} {members.length === 1 ? "repo" : "repos"}
        </span>
      </div>
      <p className="line-clamp-2 min-h-10 font-mono text-xs leading-5 text-foreground/70">
        {members.map((member) => member.fullName).join(", ")}
      </p>
      <CardPicks picks={card.picks} />
      <div className="-mx-4 mt-auto flex items-center gap-3 border-t border-border px-4 pt-2.5 text-xs text-muted-foreground">
        <span className="flex min-w-0 max-w-1/2 items-center gap-1.5">
          <Avatar src={card.publisher.avatarUrl} size={14} />
          <span className="truncate font-semibold tracking-[0.015em] text-foreground/75">
            {publisherName(card.publisher)}
          </span>
        </span>
        <span className="ml-auto flex shrink-0 items-center">
          <span className="font-mono">{card.tasks} tasks</span>
          <span aria-hidden="true" className="mx-2 text-base leading-none">
            ·
          </span>
          <span>{ago(card.releasedAt)}</span>
        </span>
      </div>
    </Link>
  );
}
