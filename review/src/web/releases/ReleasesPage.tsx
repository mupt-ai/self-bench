import { ArrowUpRight } from "lucide-react";
import React from "react";
import { useParams, useSearchParams } from "react-router";
import { formatAgo, plural } from "../api";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "../Dialog";
import { ListSkeleton } from "../LoadingSkeleton";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import {
  Button,
  buttonStyles,
  DataTable,
  EmptyState,
  Notice,
  PageContent,
  PageHeader,
} from "../ui";
import {
  publicPageUrl,
  type ReleaseList,
  type ReleaseSummary,
  releaseRequest,
  releasesUrl,
} from "./api";
import { ReleaseDialog } from "./ReleaseDialog";

/** The Releases tab: this workspace's releases of the repository, and the Release action. */
export function ReleasesPage() {
  const { org } = useOrg();
  const { owner = "", name = "" } = useParams();
  const repo = `${owner}/${name}`;
  const url = releasesUrl(org.login, repo);
  useDocumentTitle(`Releases · ${repo}`);
  const [list, setList] = React.useState<ReleaseList>();
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  // The Results page's Release Results shortcut lands here with the dialog open.
  const [search, setSearch] = useSearchParams();
  const [releasing, setReleasing] = React.useState(search.get("release") === "1");
  React.useEffect(() => {
    if (search.has("release")) setSearch({}, { replace: true });
  }, [search, setSearch]);
  const [withdrawing, setWithdrawing] = React.useState<ReleaseSummary>();
  // Only the latest request may set state: one page instance serves every repository.
  const latest = React.useRef(0);
  const load = React.useCallback(async () => {
    latest.current += 1;
    const request = latest.current;
    try {
      const next = await releaseRequest<ReleaseList>(url);
      if (request !== latest.current) return;
      setList(next);
      setError("");
    } catch (cause) {
      if (request !== latest.current) return;
      setError(cause instanceof Error ? cause.message : "Could not load releases");
    }
  }, [url]);
  React.useEffect(() => {
    setList(undefined);
    void load();
  }, [load]);
  const current = list?.releases.find((release) => release.current);
  const site = list?.resultsSiteUrl;

  return (
    <PageContent>
      <PageHeader
        title="Releases"
        description="Publish this repository's results on selfbench.dev. Each release is kept."
      >
        {current && site && (
          <a
            className={buttonStyles.secondary}
            href={publicPageUrl(site, current.fullName, current.publisher)}
            target="_blank"
            rel="noreferrer"
          >
            View Public Page
            <ArrowUpRight aria-hidden="true" />
          </a>
        )}
        <Button variant="primary" onClick={() => setReleasing(true)}>
          Release Results
        </Button>
      </PageHeader>
      {notice && (
        <Notice tone="success" className="mb-4">
          {notice}
        </Notice>
      )}
      {error && <Notice className="mb-4">{error}</Notice>}
      {!list ? (
        !error && <ListSkeleton label="Loading Releases" />
      ) : list.releases.length === 0 ? (
        <EmptyState title="Not Released Yet">
          Nothing from this workspace is public for {repo}. Release Results publishes accuracy and
          cost for the settings you choose.
        </EmptyState>
      ) : (
        <>
          <DataTable>
            <thead>
              <tr>
                <th>Released</th>
                <th>By</th>
                <th>Settings</th>
                <th>Tasks</th>
                <th>Status</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.releases.map((release) => (
                <tr key={release.id}>
                  <td>
                    {new Date(release.releasedAt).toLocaleString()}
                    <small>{formatAgo(release.releasedAt)}</small>
                  </td>
                  <td>{release.releasedBy}</td>
                  <td className="font-mono">{release.settings}</td>
                  <td className="font-mono">{release.tasks}</td>
                  <td>
                    {release.withdrawnAt ? "Withdrawn" : release.current ? "Current" : "Superseded"}
                    {release.withdrawnAt && (
                      <small>
                        by {release.withdrawnBy} {formatAgo(release.withdrawnAt)}
                      </small>
                    )}
                  </td>
                  <td className="text-right">
                    {!release.withdrawnAt && (
                      <Button size="small" variant="ghost" onClick={() => setWithdrawing(release)}>
                        Withdraw
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </>
      )}
      {releasing && (
        <ReleaseDialog
          url={url}
          workspace={org}
          onClose={() => setReleasing(false)}
          onReleased={(release, unchanged) => {
            setReleasing(false);
            setNotice(
              unchanged
                ? "Nothing changed since the current release, so no new release was written."
                : `Released ${plural(release.settings, "setting")} on ${plural(release.tasks, "task")}.`,
            );
            void load();
          }}
        />
      )}
      {withdrawing && (
        <WithdrawDialog
          release={withdrawing}
          onClose={() => setWithdrawing(undefined)}
          onWithdraw={async () => {
            await releaseRequest(`${url}/${withdrawing.id}/withdraw`, {});
            setWithdrawing(undefined);
            setNotice(
              withdrawing.current
                ? "Withdrawn. Within a minute the public page shows the previous release, if there is one."
                : "Withdrawn.",
            );
            await load();
          }}
        />
      )}
    </PageContent>
  );
}

function WithdrawDialog({
  release,
  onWithdraw,
  onClose,
}: {
  release: ReleaseSummary;
  onWithdraw(): Promise<void>;
  onClose(): void;
}) {
  const cancel = React.useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  return (
    <Dialog
      initialFocus={cancel}
      onDismiss={onClose}
      busy={busy}
      size="small"
      aria-labelledby="withdraw-release-title"
      aria-describedby="withdraw-release-description"
    >
      <DialogHeader
        title="Withdraw Release"
        titleId="withdraw-release-title"
        onClose={onClose}
        busy={busy}
      />
      <DialogBody>
        <p id="withdraw-release-description" className="text-sm leading-6 text-muted-foreground">
          {release.current
            ? "Within a minute the public page goes back to this workspace's previous release, or disappears if there is none."
            : "This release is not public now. Withdrawing it means it is never shown again."}{" "}
          Withdrawing cannot be undone, but you can release again at any time.
        </p>
        {error && <Notice>{error}</Notice>}
      </DialogBody>
      <DialogFooter>
        <Button ref={cancel} disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onWithdraw();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Could not withdraw");
              setBusy(false);
            }
          }}
        >
          {busy ? "Withdrawing…" : "Withdraw"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
