import { testAuthConfig } from "./site-fixture.js";

/** What the fake GitHub reports for the connected repository; tests change it. */
interface FakeRepository {
  private: boolean;
  stars: number;
  fullName: string;
  gone?: boolean;
  /** When set, the repository lookup answers with this status and no body. */
  lookupStatus?: number;
  /** Runs while a release looks the repository up, to interleave another request. */
  onLookup?: () => Promise<void>;
}

/**
 * A fake GitHub for the release routes: the signed-in members by token, and two public
 * repositories, vercel/next.js and vercel/commerce, as tests set them.
 */
export function fakeGitHub() {
  const github: FakeRepository = { private: false, stars: 137842, fullName: "vercel/next.js" };
  const commerceOnGitHub: FakeRepository = {
    private: false,
    stars: 12000,
    fullName: "vercel/commerce",
  };
  const ids: Record<string, number> = { priya: 1, marco: 2, outsider: 3 };
  const githubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const login = new Headers(init?.headers).get("authorization")?.replace("Bearer token-", "");
    if (url === `${testAuthConfig.githubApiUrl}/user`)
      return Response.json({ id: ids[login ?? ""] ?? 0 });
    if (url === `${testAuthConfig.githubApiUrl}/repositories/70107786` && github.onLookup)
      await github.onLookup();
    if (url === `${testAuthConfig.githubApiUrl}/repositories/70107786` && github.lookupStatus)
      return new Response(null, { status: github.lookupStatus });
    if (url === `${testAuthConfig.githubApiUrl}/repositories/70107786` && !github.gone)
      return Response.json({
        id: 70107786,
        full_name: github.fullName,
        private: github.private,
        archived: false,
        description: "The React Framework",
        language: "JavaScript",
        default_branch: "canary",
        stargazers_count: github.stars,
        pushed_at: "2026-09-22T03:14:55Z",
        owner: { avatar_url: "https://avatars.example/vercel.png" },
      });
    if (url === `${testAuthConfig.githubApiUrl}/repositories/4242` && !commerceOnGitHub.gone)
      return Response.json({
        id: 4242,
        full_name: commerceOnGitHub.fullName,
        private: commerceOnGitHub.private,
        stargazers_count: commerceOnGitHub.stars,
        owner: { avatar_url: "https://avatars.example/vercel.png" },
      });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { github, commerceOnGitHub, githubFetch };
}
