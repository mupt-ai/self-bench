import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { createPublicReleaseRoutes } from "../src/api/routes/public-releases.js";
import { GROUP_LOGO, isGroupLogo, type PublishedGroup } from "../src/public/release-groups.js";

const png = (bytes: number) => `data:image/png;base64,${"A".repeat(Math.ceil((bytes * 4) / 3))}`;

test("accepts small PNG, JPEG, WebP, and SVG data URLs", () => {
  expect(isGroupLogo("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
  expect(isGroupLogo("data:image/jpeg;base64,/9j/4AAQ")).toBe(true);
  expect(isGroupLogo("data:image/webp;base64,UklGRg==")).toBe(true);
  expect(isGroupLogo("data:image/svg+xml;base64,PHN2Zy8+")).toBe(true);
});

test("refuses other types, non-base64 payloads, and images over the size limit", () => {
  expect(isGroupLogo("data:image/gif;base64,R0lGOD==")).toBe(false);
  expect(isGroupLogo("data:text/html;base64,PGgxPg==")).toBe(false);
  expect(isGroupLogo("https://example.com/logo.png")).toBe(false);
  expect(isGroupLogo("data:image/png;base64,not base64!")).toBe(false);
  expect(isGroupLogo(png(GROUP_LOGO.maxBytes + 3000))).toBe(false);
  expect(isGroupLogo(png(GROUP_LOGO.maxBytes - 3000))).toBe(true);
});

test("a released group's logo is served on its own, never inside the pages that show it", async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  const logo = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const group: PublishedGroup = {
    ...{ releaseId: "r1", updatedAt: "2026-11-01T00:00:00Z", slug: "web", name: "Web" },
    ...{ publisher: { login: "acme", kind: "org" }, logo, members: [], tasks: 0 },
    ...{ settings: [], frontier: [] },
  };
  const routes = createPublicReleaseRoutes({
    currentLines: async () => [],
    currentGroups: async () => [group],
  });
  const server = createServer((request, response) => {
    void routes.handle(request, new URL(request.url ?? "/", "http://site"), response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);
  try {
    const href = "/api/public/groups/acme/web/logo?v=r1";
    const directory = await (await get("/api/public/results")).text();
    expect(directory).not.toContain("data:image");
    expect(JSON.parse(directory).groups[0].logo).toBe(href);
    expect((await (await get("/api/public/groups/acme/web")).json()).group.logo).toBe(href);

    const image = await get(href);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/svg+xml");
    // Opened on its own, an uploaded SVG still runs nothing on the site.
    expect(image.headers.get("content-security-policy")).toContain("sandbox");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await image.text()).toBe(svg);
    expect((await get("/api/public/groups/acme/other/logo")).status).toBe(404);
  } finally {
    server.close();
  }
});
