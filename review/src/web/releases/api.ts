import type { ReleaseView } from "../../../../src/public/release-views";

export type { PreviewSetting, ReleasePreview } from "../../../../src/public/release-build";
export type {
  ReleaseList,
  ReleaseSummary,
  ReleaseView,
} from "../../../../src/public/release-views";

export function releasesUrl(org: string, repo: string): string {
  return `/api/orgs/${encodeURIComponent(org)}/repos/${repo.split("/").map(encodeURIComponent).join("/")}/releases`;
}

/** A refused request. A 409 carries the fresh view the dialog should show instead. */
export class ReleaseRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fresh?: ReleaseView,
  ) {
    super(message);
  }
}

export async function releaseRequest<Result>(url: string, body?: object): Promise<Result> {
  const response = await fetch(
    url,
    body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  if (response.status === 401) {
    window.location.assign("/login");
    throw new Error("Session expired. Please sign in again.");
  }
  const value = (await response.json().catch(() => ({}))) as Partial<ReleaseView> & {
    error?: string;
  };
  if (!response.ok)
    throw new ReleaseRequestError(
      value.error ?? `Request failed (${response.status})`,
      response.status,
      value.preview ? (value as ReleaseView) : undefined,
    );
  return value as Result;
}

/** The public page of a line on selfbench.dev. */
export function publicPageUrl(site: string, fullName: string, publisher: string): string {
  return `${site}/${fullName}/${publisher}`;
}
