import { Layers } from "lucide-react";
import { groupHref } from "../../../../src/public/release-groups";
import type { PublicGroupCard } from "../contract";
import { groupKey, preloadGroup } from "../page-preload";
import { useSource } from "../source-context";
import { GroupLogo } from "./GroupLogo";
import { ResultCard } from "./ResultCard";

/**
 * A repository group's card, the same card a repository has: its logo, name, members, and two
 * picks over every member's tasks, with the frontier on hover. It opens the group's page the
 * same way, its title flying there.
 */
export function GroupCard({
  card,
  onOpen,
}: {
  card: PublicGroupCard;
  /** Called with the card's element as it is opened, before navigating. */
  onOpen?: (element: HTMLElement) => void;
}) {
  const source = useSource();
  const key = groupKey(card.publisher.login, card.slug);
  const members = card.repositories.length;
  return (
    <ResultCard
      href={groupHref(card.publisher.login, card.slug)}
      marks={{ subject: key, line: key }}
      avatar={<GroupLogo logo={card.logo} size={24} />}
      title={card.name}
      monoTitle={false}
      badge={
        <>
          <Layers className="size-3" aria-hidden="true" />
          {members} repos
        </>
      }
      description={card.description || card.repositories.join(" · ")}
      picks={card.picks}
      frontier={card.frontier ?? []}
      others={card.others ?? []}
      settings={card.settings}
      publisher={card.publisher}
      tasks={card.tasks}
      releasedAt={card.updatedAt}
      readAhead={() => preloadGroup(source, card)}
      {...(onOpen ? { onOpen } : {})}
    />
  );
}
