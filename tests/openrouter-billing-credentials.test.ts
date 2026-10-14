import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { credentialSchema } from "../src/db/credentials.js";
import { credentials } from "../src/db/schema.js";
import { createVault } from "../src/db/vault.js";
import { credentialExecution } from "../src/evaluation/execution.js";
import { scopeOf } from "../src/evaluation/scope.js";
import { evaluationInput } from "./support/evaluation-fixture.js";
import { memoryVault } from "./support/evaluation-vault.js";
import { testDatabase } from "./support/site-fixture.js";

const draft = {
  name: "OpenRouter",
  kind: "openrouter",
  auth: "api-key",
  value: "inference-secret",
  managementKey: "owner-billing-secret",
} as const;

test("owner billing key is sealed, org-scoped, never returned as credential info, and erased on deletion", async () => {
  const database = await testDatabase();
  try {
    const vault = createVault(database.db, "a".repeat(64));
    const info = await vault.credentials.create(1, draft, {});
    expect(JSON.stringify(info)).not.toContain(draft.managementKey);
    expect(info).not.toHaveProperty("managementKey");
    expect(await vault.credentials.secret(2, info.id)).toBeUndefined();
    expect(await vault.credentials.secret(1, info.id)).toEqual({
      value: draft.value,
      managementKey: draft.managementKey,
    });
    const [row] = await database.db.select().from(credentials).where(eq(credentials.id, info.id));
    expect(row?.secret).not.toContain(draft.managementKey);
    await vault.credentials.remove(1, info.id);
    expect(await vault.credentials.secret(1, info.id)).toBeUndefined();
  } finally {
    await database.close();
  }
});

test("only OpenRouter accepts single-line billing access", () => {
  for (const bad of [
    { ...draft, kind: "openai" },
    { ...draft, managementKey: "a\nb" },
    { ...draft, managementKey: "" },
  ])
    expect(credentialSchema.safeParse(bad).success).toBe(false);
  expect(credentialSchema.safeParse(draft).success).toBe(true);
});

test("billing access belongs to the reserved workspace credential, never the host or sandbox", async () => {
  const vault = memoryVault();
  const model = await vault.credentials.create(1, draft, {});
  const sandbox = await vault.credentials.create(
    1,
    { name: "E2B", kind: "e2b", auth: "api-key", value: "sandbox" },
    {},
  );
  const input = {
    ...evaluationInput(),
    sandbox: "e2b" as const,
    credentialOrgId: 1,
    comparisonId: "comparison",
    credentials: {
      modelCredentialId: model.id,
      sandboxCredentialId: sandbox.id,
      provider: "openrouter" as const,
    },
  };
  await vault.comparisons.insert({
    id: "comparison",
    orgId: 1,
    scope: scopeOf(input),
    createdAt: new Date().toISOString(),
    signature: "test",
    inputs: [input],
  });
  const execution = await credentialExecution(
    input,
    "/temporary-home",
    { OPENROUTER_MANAGEMENT_KEY: "operator" },
    vault,
  );
  expect(execution.billingKey).toBe(draft.managementKey);
  expect(execution.secrets).toContain(draft.managementKey);
  expect(execution.child.OPENROUTER_API_KEY).toBe(draft.value);
  expect(JSON.stringify(execution.child)).not.toContain(draft.managementKey);
  expect(execution.child.OPENROUTER_MANAGEMENT_KEY).toBeUndefined();
});
