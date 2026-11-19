import { startStubGateway } from "@mupt-ai/dari-gateway/self_host/stub_gateway";
import type { CredentialInfo } from "../../src/db/credentials.js";
import { dariLinkRequest } from "../../src/gateway/dari-link/connection.js";
import { dariLinkGrants } from "../../src/gateway/dari-link/link.js";
import { evaluationServer } from "./evaluation-fixture.js";
import { memoryVault } from "./evaluation-vault.js";

export const CLAUDE = "anthropic/claude-sonnet-5-5";
export const GPT = "openai/gpt-5.5";
const CREDENTIALS = "/api/orgs/avyay/credentials";

/**
 * Dari's stub gateway on stand-in plans (a Claude plan, a ChatGPT plan, an OpenRouter key: no
 * subscription, no paid call), and SelfBench's API with the stub's registered app as its Dari Link.
 */
export async function startDariLink() {
  const dari = await startStubGateway({
    plans: ["anthropic_claude_code", "openai_codex"],
    keys: ["openrouter"],
    models: [CLAUDE, GPT],
    redirectUri: "https://selfbench.test/api/dari-link/callback",
  });
  const vault = memoryVault();
  const server = await evaluationServer(vault, { dariLinkApp: dari.app });
  const [org] = await server.users.orgsFor(server.user.id);
  if (!org) throw new Error("Missing test org");

  /** Connect with Dari as the browser does: the user approves, the page posts the code. */
  async function connect(credentialIds?: string[]) {
    const { code, codeVerifier } = await dari.connect({
      ...dariLinkRequest,
      ...(credentialIds ? { credentialIds } : {}),
    });
    return server.request(`${CREDENTIALS}/dari-link`, {
      method: "POST",
      body: JSON.stringify({ code, codeVerifier }),
    });
  }
  const list = async () =>
    (await (await server.request(CREDENTIALS)).json()) as {
      credentials: CredentialInfo[];
      dariLink: unknown;
    };
  const remove = (id: string) =>
    server.request(`${CREDENTIALS}/${id}/delete`, { method: "POST", body: "{}" });

  return {
    dari,
    vault,
    server,
    orgId: org.id,
    grants: dariLinkGrants(vault.credentials, dari.app),
    connect,
    list,
    remove,
  };
}
