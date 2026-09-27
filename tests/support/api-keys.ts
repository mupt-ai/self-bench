import { expect } from "bun:test";
import type { AuthServer } from "./site-fixture.js";

export async function mint(site: AuthServer, headers: Record<string, string>, body: object) {
  const response = await site.request("/api/api-keys", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    key: { id: number; name: string; prefix: string; scope: string; createdAt: string };
    secret: string;
  };
}
