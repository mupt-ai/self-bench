export function assertPullRequestBelongsToRepository(
  repositoryUrl: string,
  pullRequestUrl: string,
  pullRequestNumber: number,
): void {
  const repository = githubRepository(repositoryUrl);
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/i.exec(pullRequestUrl);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(`invalid GitHub pull request URL: ${pullRequestUrl}`);
  }
  const candidateRepository = `${match[1]}/${match[2]}`.toLowerCase();
  if (candidateRepository !== repository || Number(match[3]) !== pullRequestNumber) {
    throw new Error(
      `pull request ${pullRequestUrl} does not match ${repository}#${pullRequestNumber}`,
    );
  }
}

export function githubRepository(url: string): string {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
  if (!match?.[1] || !match[2]) {
    throw new Error(`unsupported GitHub repository URL: ${url}`);
  }
  return `${match[1]}/${match[2]}`.toLowerCase();
}
