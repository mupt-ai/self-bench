/** The merged pull requests a feature task was built over, each linked on GitHub. */
export function FeaturePullRequests({
  fullName,
  pullRequests,
}: {
  fullName: string;
  pullRequests: readonly number[];
}) {
  return (
    <p className="mt-1 text-sm leading-6 text-muted-foreground">
      Feature built over{" "}
      {pullRequests.map((pr, index) => (
        <span key={pr}>
          {index > 0 && ", "}
          <a
            className="font-mono hover:text-foreground hover:underline hover:underline-offset-4"
            href={`https://github.com/${fullName}/pull/${pr}`}
            target="_blank"
            rel="noreferrer"
          >
            #{pr}
          </a>
        </span>
      ))}
    </p>
  );
}
