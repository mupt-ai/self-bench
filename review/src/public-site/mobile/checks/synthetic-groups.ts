import type { PublicGroupRecord } from "../../contract";

/**
 * Repository groups over the synthetic pages: one whose members share settings, with a name long
 * enough to wrap, and one whose members share none, which shows its empty state.
 */
export function syntheticGroups(): PublicGroupRecord[] {
  return [
    {
      publisherLogin: "acme-labs",
      slug: "widget-toolkits",
      name: "Widget Toolkits and Every Model Vendor Worth Comparing on Them",
      description:
        "Two repositories evaluated with the same settings, pooled into one leaderboard.",
      repositoryIds: [1001, 1005],
      updatedAt: "2026-09-21T10:00:00Z",
    },
    {
      publisherLogin: "acme-labs",
      slug: "nothing-shared",
      name: "Nothing Shared",
      description: "",
      repositoryIds: [1002, 1003],
      updatedAt: "2026-09-15T10:00:00Z",
    },
  ];
}

/** Each group's page, and the address of one that does not exist. */
export function syntheticGroupRoutes(): string[] {
  return [
    ...syntheticGroups().map((group) => `/groups/${group.publisherLogin}/${group.slug}`),
    "/groups/acme-labs/no-such-group",
  ];
}
