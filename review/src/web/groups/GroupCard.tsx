import { GroupLogo } from "../../public-site/components/GroupLogo";
import { formatAgo } from "../api";
import { ScopeCard } from "../ScopeCard";
import type { GroupView } from "./api";

/** A repository group as a card on the Mined Repos page, opening its own pages. */
export function GroupCard({ group, onRemove }: { group: GroupView; onRemove(): void }) {
  return (
    <ScopeCard
      name={group.name}
      to={`/groups/${group.slug}`}
      icon={<GroupLogo logo={group.logo} size={20} />}
      details={[
        group.repositories.map((member) => member.fullName).join(", "),
        `Updated ${formatAgo(group.updatedAt)}`,
      ]}
      stats={[
        { label: "Repositories", value: group.repositories.length },
        { label: "Tasks", value: group.tasks },
        {
          label: "Disconnected",
          value: group.repositories.filter((member) => !member.connected).length,
          attention: group.repositories.some((member) => !member.connected),
        },
      ]}
      removeLabel="Delete"
      onRemove={onRemove}
    />
  );
}
