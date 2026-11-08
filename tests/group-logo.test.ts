import { expect, test } from "bun:test";
import { GROUP_LOGO, isGroupLogo } from "../src/public/release-groups.js";

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
