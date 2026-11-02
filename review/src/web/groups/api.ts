import type { GroupView } from "../../../../src/public/group-views";

export type {
  GroupInput,
  GroupList,
  GroupView,
} from "../../../../src/public/group-views";

/** A workspace's repository groups, or one group (`slug`) and what follows it (`rest`). */
export function groupsUrl(org: string, slug?: string, rest = ""): string {
  return `/api/orgs/${encodeURIComponent(org)}/groups${slug ? `/${encodeURIComponent(slug)}${rest}` : ""}`;
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

/** One group, for its pages. */
export async function fetchGroup(org: string, slug: string): Promise<GroupView> {
  return (await groupRequest<{ group: GroupView }>(groupsUrl(org, slug))).group;
}
