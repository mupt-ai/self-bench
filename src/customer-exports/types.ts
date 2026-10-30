import type { EvaluationInput } from "../evaluation/types.js";

export interface CustomerExportRequest {
  id: string;
  repoId: number;
  customer: string;
  email: string;
  evaluationId: string;
  createdAt: string;
  createdBy: string;
  tasks: EvaluationInput["tasks"];
}
export interface CustomerExport {
  id: string;
  customer: string;
  email: string;
  evaluationId: string;
  createdAt: string;
  status: "preparing" | "ready" | "failed";
  repository?: string;
  error?: string;
}
export function exportPrefix(repoId: number, id = ""): string {
  return `customer-exports/repos/${repoId}/${id ? `${id}/` : ""}`;
}
export function customerRepository(source: string, repoId: number, id: string): string {
  return `${source.slice(0, source.lastIndexOf("/"))}/customer-${repoId}-${id}`;
}
