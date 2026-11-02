import type { EvaluationInput } from "../evaluation/types.js";

/** A customer export as saved: one evaluation's frozen tasks, pulled through a registry grant. */
export interface CustomerExportRequest {
  id: string;
  repoId: number;
  customer: string;
  evaluationId: string;
  /** When the chosen evaluation ran. */
  evaluationCreatedAt: string;
  /** The registry grant (db/registry-grants.ts) the ZIP's Dockerfiles pull with. */
  grantId: string;
  createdAt: string;
  createdBy: string;
  tasks: EvaluationInput["tasks"];
}
export interface CustomerExport {
  id: string;
  customer: string;
  evaluationId: string;
  evaluationCreatedAt: string;
  createdAt: string;
  expiresAt: string;
  status: "ready" | "expired" | "revoked";
}
export function exportPrefix(repoId: number, id = ""): string {
  return `customer-exports/repos/${repoId}/${id ? `${id}/` : ""}`;
}
/** How long a customer can pull an export's images. */
export const EXPORT_DAYS = 30;
