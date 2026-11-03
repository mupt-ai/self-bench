import type { PublicGroup, PublicGroupMember, PublicSetting } from "../../contract";
import { setting } from "../../test-fixture";

type Repository = PublicGroupMember["repository"];

/**
 * A released group of `members` (each with its task count), scored by `settings`. Each member's
 * own score sits a little off the group's, alternately above and below, so the Repositories table
 * shows real differences.
 */
function group(
  slug: string,
  name: string,
  description: string,
  members: readonly [Repository, number][],
  settings: PublicSetting[],
): PublicGroup {
  const tasks = members.reduce((sum, [, count]) => sum + count, 0);
  return {
    releaseId: `synthetic-group-${slug}`,
    updatedAt: "2026-09-21T10:00:00Z",
    publisher: { login: "acme-labs", kind: "org" },
    slug,
    name,
    ...(description ? { description } : {}),
    tasks,
    settings,
    frontier: settings.filter((each) => each.onFrontier).map((each) => each.id),
    members: members.map(([repository, count], index) => ({
      repository,
      tasks: count,
      scores: Object.fromEntries(
        settings.map((each, position) => {
          const shift = ((index + position) % 2 === 0 ? 1 : -1) * 6;
          const accuracy = Math.max(0, Math.min(100, each.accuracy + shift));
          return [
            each.id,
            {
              passed: Math.round((accuracy / 100) * count),
              tasks: count,
              accuracy,
              costPerTaskUsd: each.costPerTaskUsd,
              costedTasks: count,
            },
          ];
        }),
      ),
    })),
  };
}

/**
 * Released repository groups: one with many settings and a name long enough to wrap, and one
 * with a single setting and a member whose name is hard to break.
 */
export function syntheticGroups(): PublicGroup[] {
  const vendor = (id: string, label: string, vendorName: string) => ({
    catalogId: id,
    name: `${vendorName}/${id}`,
    label,
  });
  return [
    group(
      "widget-toolkits",
      "Widget Toolkits and Every Model Vendor Worth Comparing on Them",
      "Two widget toolkits evaluated together as one dataset.",
      [
        [{ id: 1001, fullName: "example-org/widgets", stars: 48_200 }, 36],
        [{ id: 1005, fullName: "example-org/many-models", stars: 12_400 }, 40],
      ],
      [
        setting({
          id: "alpha",
          model: vendor("alpha", "Alpha 5", "openai"),
          accuracy: 92,
          costPerTaskUsd: 3.1,
        }),
        setting({
          id: "beta",
          model: vendor("beta", "Beta Sonnet", "anthropic"),
          harness: "claude-code",
          provider: "anthropic",
          accuracy: 84,
          costPerTaskUsd: 1.7,
        }),
        setting({
          id: "gamma",
          model: vendor("gamma", "Gamma Flash", "google"),
          harness: "pi",
          provider: "openrouter",
          accuracy: 61,
          costPerTaskUsd: 0.2,
        }),
        setting({
          id: "delta",
          model: vendor("delta", "Delta V4", "deepseek"),
          harness: "pi",
          provider: "openrouter",
          accuracy: 66,
          costPerTaskUsd: 0.9,
          onFrontier: false,
        }),
      ],
    ),
    group(
      "solo-setting",
      "One Setting",
      "",
      [
        [{ id: 1003, fullName: "solo/tiny" }, 3],
        [
          {
            id: 1002,
            fullName: "an-organisation-with-a-long-name/a-repository-with-an-unusually-long-name",
          },
          10,
        ],
      ],
      [setting({ id: "only", model: vendor("only", "Only", "openai") })],
    ),
  ];
}

/** Each group's page, and the address of one that does not exist. */
export function syntheticGroupRoutes(): string[] {
  return [
    ...syntheticGroups().map((each) => `/groups/${each.publisher.login}/${each.slug}`),
    "/groups/acme-labs/no-such-group",
  ];
}
