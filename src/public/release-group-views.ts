/** What the app reads of a workspace's repository groups (src/api/routes/release-groups.ts). */

/** A repository the workspace can add to a group: one it has a current release of. */
export interface GroupCandidate {
  id: number;
  fullName: string;
  releasedAt: string;
  tasks: number;
  /** Its current release's setting ids, so the editor can count what members share. */
  settingIds: string[];
}

/** A group as the app lists it. */
export interface GroupSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  /** The page's address on selfbench.dev, when the site is configured. */
  publicUrl: string | null;
  /** Members in order; `released` is false while one has no current release here. */
  repositories: { id: number; fullName: string; released: boolean }[];
  updatedAt: string;
  updatedBy: string;
}

export interface GroupList {
  groups: GroupSummary[];
  candidates: GroupCandidate[];
  resultsSiteUrl: string | null;
}
