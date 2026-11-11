import { evaluationRequest } from "../evaluation/api";

export type MemberRole = "admin" | "member";

export interface Member {
  login: string;
  name?: string;
  avatarUrl?: string;
  role: MemberRole;
  /** "github": joined through a connected GitHub organization; "invite": added in SelfBench. */
  source: "github" | "invite";
}

export interface GitHubConnection {
  githubId: number;
  login: string;
  kind: "org" | "user";
}

export interface Invite {
  id: number;
  githubLogin: string;
  role: MemberRole;
  createdAt: string;
}

export interface Members {
  members: Member[];
  github: GitHubConnection[];
  canManage: boolean;
}

export const roleLabels: Record<MemberRole, string> = { admin: "Admin", member: "Member" };

const orgUrl = (org: string) => `/api/orgs/${encodeURIComponent(org)}`;

export const fetchMembers = (org: string) => evaluationRequest<Members>(`${orgUrl(org)}/members`);

export const fetchInvites = async (org: string) =>
  (await evaluationRequest<{ invites: Invite[] }>(`${orgUrl(org)}/invites`)).invites;

export const inviteMember = (org: string, login: string, role: MemberRole) =>
  evaluationRequest<Invite>(`${orgUrl(org)}/invites`, { login, role });

export const revokeInvite = (org: string, id: number) =>
  evaluationRequest(`${orgUrl(org)}/invites/${id}/delete`, {});

export const setMemberRole = (org: string, login: string, role: MemberRole) =>
  evaluationRequest(`${orgUrl(org)}/members/${encodeURIComponent(login)}/role`, { role });

export const removeMember = (org: string, login: string) =>
  evaluationRequest(`${orgUrl(org)}/members/${encodeURIComponent(login)}/delete`, {});

export const connectGitHub = (org: string, login: string) =>
  evaluationRequest(`${orgUrl(org)}/github`, { login });

export const renameWorkspace = (org: string, name: string) =>
  evaluationRequest(`${orgUrl(org)}/settings`, { name: name || null });

export const createWorkspace = (login: string, name: string) =>
  evaluationRequest<{ id: number; login: string }>("/api/orgs", {
    login,
    ...(name ? { name } : {}),
  });
