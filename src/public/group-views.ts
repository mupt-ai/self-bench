/** What the app reads of a workspace's repository groups (src/api/routes/groups.ts). */

/** A member of a group: a GitHub repository, and whether it is still connected here. */
interface GroupMemberView {
  /** GitHub's id for the repository. */
  id: number;
  fullName: string;
  /** False once the repository is disconnected: its tasks drop out of the group until reconnected. */
  connected: boolean;
  /** Its approved tasks, which the group's evaluations run. */
  tasks: number;
}

/** A group as the app lists and opens it. */
export interface GroupView {
  slug: string;
  name: string;
  description: string;
  /** A data URL logo, or null for the default mark. */
  logo: string | null;
  repositories: GroupMemberView[];
  /** Every member's approved tasks together. */
  tasks: number;
  updatedAt: string;
  updatedBy: string;
}

/** The Repository Groups page: the workspace's groups, and the repositories a group can hold. */
export interface GroupList {
  groups: GroupView[];
  repositories: { id: number; fullName: string; tasks: number }[];
}

/** What a save sends: the group's name, address, description and members, in order. */
export interface GroupInput {
  name: string;
  slug: string;
  description: string;
  /** Left out keeps the logo; null restores the default mark. */
  logo?: string | null | undefined;
  repositoryIds: number[];
}
