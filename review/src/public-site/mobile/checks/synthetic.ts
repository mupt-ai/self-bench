import type { PublicRepoPage, PublicSetting } from "../../contract";
import { memorySource, type PublicSource } from "../../source";
import { page, setting } from "../../test-fixture";

type Model = PublicSetting["model"];

const openai = (id: string, label: string): Model => ({
  catalogId: id,
  name: `openai/${id}`,
  label,
});
const anthropic = (id: string, label: string): Model => ({
  catalogId: id,
  name: `anthropic/${id}`,
  label,
});
/** An OpenRouter model, named "vendor/model" as the catalog names them. */
const routed = (name: string, label: string): Model => ({
  catalogId: name.split("/")[1] ?? name,
  name,
  label,
});

/**
 * A setting that passed `passed` of 40 tasks at `cost` per task, run the way its vendor's
 * models usually are: Codex for OpenAI, Claude Code for Anthropic, Pi through OpenRouter.
 */
function manySetting(
  id: string,
  model: Model,
  passed: number,
  cost: number,
  overrides: Partial<PublicSetting> = {},
): PublicSetting {
  const [vendor] = model.name.split("/");
  const direct = vendor === "openai" || vendor === "anthropic";
  return setting({
    id,
    model,
    harness: vendor === "openai" ? "codex" : vendor === "anthropic" ? "claude-code" : "pi",
    provider: direct ? vendor : "openrouter",
    tasks: 40,
    passed,
    accuracy: (passed / 40) * 100,
    costPerTaskUsd: cost,
    totalCostUsd: Math.round(cost * 40 * 100) / 100,
    onFrontier: false,
    ...overrides,
  });
}

/**
 * Made-up repositories for the phone checks, each one a case phones find hard. `bun run
 * dev:public` shows them with VITE_PUBLIC_DATA=synthetic. Built with the unit tests' builders,
 * so a contract change breaks the type check here instead of leaving the data stale. When the
 * site gains a new kind of content (a field, a state, a page), add it here so the checks see it.
 * Built on demand, so a production build leaves all of it out.
 */
function syntheticPages(): PublicRepoPage[] {
  const alpha = { catalogId: "alpha", name: "openai/alpha", label: "Alpha 5" };
  const shared = {
    id: 1004,
    fullName: "shared/project",
    description: "Released by two workspaces.",
    stars: 900,
  };
  return [
    // Many settings: twins (one model, several harnesses or sign-ins), a custom endpoint with a
    // long name, every provider.
    page({
      releaseId: "synthetic-crowded",
      repository: {
        id: 1001,
        fullName: "example-org/widgets",
        description: "A widget toolkit with an ordinary description that runs to about two lines.",
        stars: 48_200,
      },
      tasks: 36,
      settings: [
        setting({ id: "alpha-codex", model: alpha, accuracy: 94, costPerTaskUsd: 3.1 }),
        setting({
          id: "alpha-pi",
          model: alpha,
          harness: "pi",
          accuracy: 91,
          costPerTaskUsd: 2.8,
          onFrontier: false,
        }),
        setting({
          id: "alpha-chatgpt",
          model: alpha,
          signIn: "codex-login",
          accuracy: 89,
          costPerTaskUsd: 2.2,
          onFrontier: false,
        }),
        setting({
          id: "beta",
          model: { catalogId: "beta", name: "anthropic/beta", label: "Beta Sonnet" },
          harness: "claude-code",
          provider: "anthropic",
          accuracy: 83,
          costPerTaskUsd: 1.7,
        }),
        setting({
          id: "gamma",
          model: { catalogId: "gamma", name: "openrouter/gamma", label: "Gamma Flash" },
          harness: "pi",
          provider: "openrouter",
          reasoningLevel: "low",
          accuracy: 61,
          costPerTaskUsd: 0.2,
        }),
        setting({
          id: "custom",
          model: {
            catalogId: "custom",
            name: "an-unusually-long-custom-model-name-405b-instruct",
            label: "an-unusually-long-custom-model-name-405b-instruct",
          },
          harness: "pi",
          provider: "custom",
          custom: true,
          reasoningLevel: "default",
          accuracy: 47,
          costPerTaskUsd: 0.4,
          onFrontier: false,
        }),
        setting({
          id: "delta",
          model: { catalogId: "delta", name: "openrouter/delta", label: "Delta V4 Pro" },
          harness: "pi",
          provider: "openrouter",
          accuracy: 72,
          costPerTaskUsd: 0.9,
          onFrontier: false,
        }),
        setting({
          id: "epsilon",
          model: { catalogId: "epsilon", name: "anthropic/epsilon", label: "Epsilon Opus" },
          harness: "claude-code",
          provider: "anthropic",
          accuracy: 97,
          costPerTaskUsd: 4.9,
        }),
      ],
    }),
    // Every vendor in the model catalog on one chart: a same-model twin, near misses in cost
    // and accuracy, and a custom endpoint. The busiest chart the labels have to fit.
    page({
      releaseId: "synthetic-many-vendors",
      releasedAt: "2026-09-20T10:00:00Z",
      repository: {
        id: 1005,
        fullName: "example-org/many-models",
        description: "Every vendor in the catalog on one eval set.",
        stars: 12_400,
      },
      tasks: 40,
      settings: [
        manySetting("alpha-codex", alpha, 38, 3.4, { onFrontier: true }),
        manySetting("alpha-pi", alpha, 37, 3.05, { harness: "pi", onFrontier: true }),
        manySetting("alpha-mini", openai("alpha-mini", "Alpha 5 Mini"), 32, 0.9, {
          reasoningLevel: "medium",
          onFrontier: true,
        }),
        manySetting("beta-opus", anthropic("beta-opus", "Beta Opus"), 39, 5.1, {
          onFrontier: true,
        }),
        manySetting("beta-sonnet", anthropic("beta-sonnet", "Beta Sonnet"), 35, 2.2),
        manySetting("beta-haiku", anthropic("beta-haiku", "Beta Haiku"), 28, 0.6),
        manySetting("gamma-pro", routed("google/gamma-pro", "Gamma Pro"), 36, 1.9, {
          onFrontier: true,
        }),
        manySetting("gamma-flash", routed("google/gamma-flash", "Gamma Flash"), 27, 0.25, {
          reasoningLevel: "low",
          onFrontier: true,
        }),
        manySetting("delta", routed("deepseek/delta-v4", "Delta V4"), 31, 0.45, {
          onFrontier: true,
        }),
        manySetting("epsilon", routed("z-ai/epsilon-5", "Epsilon 5"), 31, 0.55),
        manySetting("zeta", routed("moonshotai/zeta-k3", "Zeta K3"), 34, 1.1, {
          onFrontier: true,
        }),
        manySetting(
          "in-house",
          { catalogId: "in-house", name: "in-house-coder-70b", label: "in-house-coder-70b" },
          23,
          0.35,
          { provider: "custom", custom: true, reasoningLevel: "default" },
        ),
        manySetting(
          "sql",
          { catalogId: "sql", name: "acme-sql-13b", label: "acme-sql-13b" },
          21,
          0.12,
          { provider: "custom", custom: true, reasoningLevel: "default", onFrontier: true },
        ),
        // One typed model name on two endpoints: nothing public tells them apart but the number
        // their ids end in, so the page numbers them the same way.
        ...[1, 2].map((number, index) =>
          manySetting(
            `my-llama-70b|pi|custom|api-key|default|#${number}`,
            { catalogId: "custom", name: "my-llama-70b", label: "my-llama-70b" },
            index === 0 ? 25 : 22,
            index === 0 ? 0.6 : 0.48,
            { provider: "custom", custom: true, reasoningLevel: "default" },
          ),
        ),
      ],
    }),
    // The longest names and description a card and a title have to fit.
    page({
      releaseId: "synthetic-long-name",
      releasedAt: "2026-09-14T10:00:00Z",
      repository: {
        id: 1002,
        fullName: "an-organisation-with-a-long-name/a-repository-with-an-unusually-long-name",
        description:
          "A description long enough to be cut off: it runs well past two lines on a phone, with words like internationalisation that are hard to break anywhere sensible.",
        stars: 1_250_000,
      },
    }),
    // The least there can be: no description, no stars, one setting, few tasks.
    page({
      releaseId: "synthetic-sparse",
      releasedAt: "2026-09-12T10:00:00Z",
      repository: { id: 1003, fullName: "solo/tiny" },
      tasks: 3,
      settings: [
        setting({ id: "only", model: { catalogId: "only", name: "openai/only", label: "Only" } }),
      ],
    }),
    // One repository released by two publishers, one endorsed: the release switcher.
    page(
      {
        releaseId: "synthetic-shared-endorsed",
        releasedAt: "2026-09-10T10:00:00Z",
        repository: shared,
        publisher: { login: "maintainers", kind: "org" },
      },
      true,
    ),
    page({
      releaseId: "synthetic-shared-community",
      releasedAt: "2026-09-18T10:00:00Z",
      repository: shared,
      publisher: { login: "a-community-member-with-a-long-login", kind: "user" },
    }),
  ];
}

export function syntheticSource(): PublicSource {
  return memorySource(syntheticPages());
}

/**
 * A path to every kind of page, over the synthetic data: home, a search, each repository's
 * default line, each other publisher's line, and a repository with nothing released.
 */
export function syntheticRoutes(): string[] {
  const pages = syntheticPages();
  const repositories = [...new Set(pages.map((entry) => entry.release.repository.fullName))];
  const otherLines = pages
    .filter(
      (entry) =>
        !entry.endorsed &&
        pages.some(
          (other) => other.endorsed && other.release.repository.id === entry.release.repository.id,
        ),
    )
    .map((entry) => `${entry.release.repository.fullName}/${entry.release.publisher.login}`);
  return [
    "/",
    "/?q=widgets",
    ...repositories.map((name) => `/${name}`),
    ...otherLines.map((line) => `/${line}`),
    "/nobody/nothing-released",
  ];
}
