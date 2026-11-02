export type {
  GroupCandidate,
  GroupList,
  GroupSummary,
} from "../../../../src/public/release-group-views";

/** A workspace's repository groups, and the address of one of them. */
export function groupsUrl(org: string, id?: string): string {
  return `/api/orgs/${encodeURIComponent(org)}/release-groups${id ? `/${id}` : ""}`;
}

/** What a save sends: the group's name, address, description and members, in order. */
export interface GroupInput {
  name: string;
  slug: string;
  description: string;
  repositoryIds: number[];
}

export async function groupRequest<Result>(
  url: string,
  init?: { method: "POST" | "PUT" | "DELETE"; body?: object },
): Promise<Result> {
  const response = await fetch(
    url,
    init
      ? {
          method: init.method,
          ...(init.body
            ? {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(init.body),
              }
            : {}),
        }
      : undefined,
  );
  if (response.status === 401) {
    window.location.assign("/login");
    throw new Error("Session expired. Please sign in again.");
  }
  const value = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
  return value as Result;
}

/** How many tasks the chosen members hold, and how many settings every one of them released. */
export function pooledCounts(
  candidates: readonly { id: number; tasks: number; settingIds: readonly string[] }[],
  chosen: readonly number[],
): { tasks: number; settings: number } {
  const members = chosen.flatMap((id) => candidates.find((candidate) => candidate.id === id) ?? []);
  const [first, ...rest] = members;
  return {
    tasks: members.reduce((sum, member) => sum + member.tasks, 0),
    settings: first
      ? first.settingIds.filter((id) => rest.every((member) => member.settingIds.includes(id)))
          .length
      : 0,
  };
}
