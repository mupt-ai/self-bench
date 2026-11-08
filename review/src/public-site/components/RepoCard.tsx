import { Star } from "lucide-react";
import type { PublicRepoSummary } from "../contract";
import { cleanDescription, compactNumber } from "../format";
import { preloadPage } from "../page-preload";
import { useSource } from "../source-context";
import { Avatar } from "./Avatar";
import { ResultCard } from "./ResultCard";

/** A repository's (or an eval's) card: one line of its results, opening its page. */
export function RepoCard({
  card,
  byLine = false,
  onOpen,
}: {
  card: PublicRepoSummary;
  byLine?: boolean;
  /** Called with the card's element as it is opened, before navigating. */
  onOpen?: (element: HTMLElement) => void;
}) {
  const source = useSource();
  const { repository } = card;
  return (
    <ResultCard
      href={byLine ? `/${repository.fullName}/${card.publisher.login}` : `/${repository.fullName}`}
      marks={{
        subject: repository.fullName,
        line: `${repository.fullName}/${card.publisher.login}`,
      }}
      avatar={<Avatar src={repository.ownerAvatarUrl} size={24} />}
      title={repository.fullName}
      monoTitle
      {...(repository.stars === undefined
        ? {}
        : {
            badge: (
              <>
                <Star className="size-3 fill-current" aria-hidden="true" />
                {compactNumber(repository.stars)}
              </>
            ),
          })}
      description={repository.description ? cleanDescription(repository.description) : ""}
      picks={card.picks}
      frontier={card.frontier}
      {...(card.others ? { others: card.others } : {})}
      settings={card.settings}
      publisher={card.publisher}
      endorsed={card.endorsed}
      tasks={card.tasks}
      releasedAt={card.releasedAt}
      // The page is read as the card is pressed (or rested on, or focused), not when it is
      // clicked: by the time its title has flown, its data is usually in.
      readAhead={() => preloadPage(source, card, byLine)}
      {...(onOpen ? { onOpen } : {})}
    />
  );
}
