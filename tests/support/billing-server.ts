import { createServer } from "node:http";
import { sendApiError } from "../../src/api/http.js";
import { createBillingRoutes } from "../../src/api/routes/billing.js";
import { createBillingStore } from "../../src/db/billing.js";
import { createUserStore } from "../../src/db/users.js";
import { testAuthConfig, testDatabase } from "./site-fixture.js";

const stripe = {
  secretKey: "sk_test",
  webhookSecret: "whsec_test",
  priceId: "price_metered",
  apiVersion: "2025-09-30.clover" as const,
};

export async function billingServer(
  priceUnitCents = "0.00001",
  meterEventName = "selfbench_managed_usage",
) {
  const database = await testDatabase();
  const users = createUserStore(database.db, { secret: testAuthConfig.sessionSecret });
  const admin = await users.upsert({
    githubId: 1,
    login: "owner",
    token: "gho",
    scopes: "",
    orgs: [
      { githubId: 2, login: "team", role: "admin" },
      { githubId: 4, login: "mupt-ai", role: "admin" },
    ],
  });
  const member = await users.upsert({
    githubId: 3,
    login: "member",
    token: "gho",
    scopes: "",
    orgs: [{ githubId: 2, login: "team", role: "member" }],
  });
  const store = createBillingStore(database.db, true);
  const teamId = (await users.orgsFor(admin.id)).find((org) => org.login === "team")?.id;
  if (!teamId) throw new Error("team missing");
  const stripeCalls: string[] = [];
  let githubRole: string = "admin";
  let dropCreditResponseOnce = false;
  const credits: { body: URLSearchParams; key: string | null }[] = [];
  const routes = createBillingRoutes({
    users,
    store,
    config: stripe,
    publicUrl: "http://billing.test",
    creditAdminOrgId: 4,
    githubApiUrl: "https://api.github.test",
    githubToken: async () => "gho_admin",
    fetchImpl: (async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://api.github.test/user/memberships/orgs")) {
        return Response.json([{ role: githubRole, organization: { id: 4, login: "mupt-ai" } }]);
      }
      stripeCalls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/v1/prices/price_metered"))
        return Response.json({
          active: true,
          currency: "usd",
          billing_scheme: "per_unit",
          recurring: { usage_type: "metered", meter: "mtr_1" },
          unit_amount_decimal: priceUnitCents,
        });
      if (url.endsWith("/v1/customers/cus_1/balance_transactions")) {
        credits.push({
          body: new URLSearchParams(String(init?.body)),
          key: new Headers(init?.headers).get("idempotency-key"),
        });
        if (dropCreditResponseOnce) {
          dropCreditResponseOnce = false;
          throw new Error("simulated lost Stripe response");
        }
        return Response.json({ id: "cbtxn_1" });
      }
      if (url.endsWith("/v1/billing/meters/mtr_1"))
        return Response.json({
          event_name: meterEventName,
          status: "active",
          default_aggregation: { formula: "sum" },
          customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
          value_settings: { event_payload_key: "value" },
        });
      if (url.endsWith("/v1/subscriptions/sub_1"))
        return Response.json({ items: { data: [{ current_period_start: 1_790_000_000 }] } });
      if (url.endsWith("/v1/customers")) return Response.json({ id: "cus_1" });
      if (url.endsWith("/v1/checkout/sessions"))
        return Response.json({ url: "https://checkout.stripe.test/c" });
      if (url.endsWith("/v1/billing_portal/sessions"))
        return Response.json({ url: "https://billing.stripe.test/p" });
      return new Response("missing", { status: 404 });
    }) as typeof fetch,
  });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://billing.test");
      const login = request.headers["x-user"];
      const user = login === "member" ? member : login === "owner" ? admin : undefined;
      if (await routes.webhook(request, url, response)) return;
      if (!user) {
        response.writeHead(401).end();
        return;
      }
      if (!(await routes.handle(request, url, response, user))) response.writeHead(404).end();
    } catch (error) {
      sendApiError(response, error);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  const request = (path: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${address.port}${path}`, init);
  return {
    database,
    store,
    teamId,
    stripeCalls,
    credits,
    setGitHubRole: (role: string) => {
      githubRole = role;
    },
    dropCreditResponseOnce: () => {
      dropCreditResponseOnce = true;
    },
    request,
    stop: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await database.close();
    },
  };
}
