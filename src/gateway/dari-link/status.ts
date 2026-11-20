import { grant, LinkError } from "@mupt-ai/dari-gateway/link/client";
import type { DariLinkStatus } from "./connection.js";
import type { DariLinkGrants } from "./link.js";

/** Reads a connection's plans from Dari for the Credentials page; Dari's refusal comes back as text. */
export async function dariLinkStatus(
  grants: DariLinkGrants,
  orgId: number,
  credentialId: string,
): Promise<DariLinkStatus> {
  try {
    const now = await grant(await grants(orgId, credentialId));
    return {
      manageUrl: now.manageUrl,
      plans: now.plans.map(
        ({ id, kind, title, plan, account_email, state, available_at, usage }) => ({
          id,
          kind,
          title,
          plan,
          account_email,
          state,
          available_at,
          usage,
        }),
      ),
    };
  } catch (error) {
    if (!(error instanceof LinkError)) throw error;
    return {
      error:
        error.code === "not_configured"
          ? "Dari Link is not configured here."
          : error.unlinked
            ? "This Dari connection was revoked or expired. Choose Update Plans to connect again."
            : `Dari did not answer: ${error.message}`,
      unlinked: error.unlinked,
    };
  }
}
