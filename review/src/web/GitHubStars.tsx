import { useEffect, useState } from "react";
import { GitHubMark } from "./GitHubMark";

/** A star count as GitHub shows it: 999, then 1.2k, 12k. */
function formatStars(count: number): string {
  if (count < 1000) return String(count);
  const thousands = count / 1000;
  return `${thousands < 10 ? Number(thousands.toFixed(1)) : Math.round(thousands)}k`;
}

/** The repository's stars, read once per tab from GitHub's public API; undefined until known. */
function useStars(repo: string): number | undefined {
  const key = `selfbench.stars.${repo}`;
  const [stars, setStars] = useState<number | undefined>(() => {
    try {
      const saved = sessionStorage.getItem(key);
      return saved === null ? undefined : Number(saved);
    } catch {
      return undefined;
    }
  });
  useEffect(() => {
    if (stars !== undefined) return;
    let cancelled = false;
    fetch(`https://api.github.com/repos/${repo}`, {
      headers: { accept: "application/vnd.github+json" },
    })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((body: { stargazers_count?: unknown } | undefined) => {
        const count = body?.stargazers_count;
        if (cancelled || typeof count !== "number") return;
        setStars(count);
        try {
          sessionStorage.setItem(key, String(count));
        } catch {
          // The count is a nicety; without storage it is read again next time.
        }
      })
      // Rate-limited or offline: the link shows the mark alone.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [key, repo, stars]);
  return stars;
}

/** A link to a repository on GitHub, as developer sites put one in their header: a small outlined
 * button with GitHub's mark and the star count once known. */
export function GitHubRepoLink({ repo }: { repo: string }) {
  const stars = useStars(repo);
  const label = stars === undefined ? "GitHub" : `GitHub, ${stars.toLocaleString("en-US")} stars`;
  return (
    <a
      href={`https://github.com/${repo}`}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      title={label}
      className="inline-flex h-8 items-center gap-2 rounded-md border border-input px-2.5 text-[13px] font-medium text-foreground transition-colors hover:border-foreground/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <GitHubMark />
      {stars !== undefined && (
        <span className="text-muted-foreground tabular-nums">{formatStars(stars)}</span>
      )}
    </a>
  );
}
