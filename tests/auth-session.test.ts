import { describe, expect, test } from "bun:test";
import { constantTimeEqual, createSecretBox, deriveKey, randomToken } from "../src/auth/crypto.js";
import { createSessionSigner, SESSION_TTL_SECONDS } from "../src/auth/session.js";

const SECRET = "session-secret-for-tests-that-is-long-enough-000";

describe("session cookie signing", () => {
  test("issues a signed value that verifies and carries a 30-day expiry", () => {
    const issued = new Date("2026-09-04T10:00:00Z");
    const signer = createSessionSigner(SECRET, { now: () => issued });
    const value = signer.issue(42);
    expect(value).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(signer.verify(value)).toEqual({
      githubId: 42,
      issuedAt: Math.floor(issued.getTime() / 1000),
      expiresAt: Math.floor(issued.getTime() / 1000) + SESSION_TTL_SECONDS,
    });
    expect(SESSION_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  test("rejects tampered payloads, foreign signatures, and garbage", () => {
    const signer = createSessionSigner(SECRET);
    const value = signer.issue(42);
    const [payload, signature] = value.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ v: 1, uid: 7, iat: 0, exp: 4102444800 })).toString(
      "base64url",
    );
    expect(signer.verify(`${forged}.${signature}`)).toBeUndefined();
    expect(signer.verify(`${payload}.${signature.slice(0, -1)}`)).toBeUndefined();
    expect(signer.verify(payload)).toBeUndefined();
    expect(signer.verify("")).toBeUndefined();
    expect(signer.verify(undefined)).toBeUndefined();
    expect(signer.verify("not.base64.at-all")).toBeUndefined();
    const other = createSessionSigner("a-different-secret-that-is-also-long-enough-000");
    expect(other.verify(value)).toBeUndefined();
  });

  test("expires exactly at the recorded time", () => {
    let clock = new Date("2026-09-04T10:00:00Z");
    const signer = createSessionSigner(SECRET, { now: () => clock, ttlSeconds: 60 });
    const value = signer.issue(1);
    clock = new Date(clock.getTime() + 59_000);
    expect(signer.verify(value)?.githubId).toBe(1);
    clock = new Date(clock.getTime() + 1_000);
    expect(signer.verify(value)).toBeUndefined();
  });
});

describe("key material", () => {
  test("derives distinct keys per purpose and seals tokens under the sealing key only", () => {
    const signing = deriveKey(SECRET, "session-signing");
    const sealing = deriveKey(SECRET, "token-sealing");
    expect(signing.length).toBe(32);
    expect(signing.equals(sealing)).toBe(false);
    const box = createSecretBox(sealing);
    const sealed = box.seal("gho_token");
    expect(box.open(sealed)).toBe("gho_token");
    expect(Buffer.from(sealed).toString("utf8")).not.toContain("gho_token");
    expect(() => createSecretBox(signing).open(sealed)).toThrow();
  });

  test("random tokens are unique, URL safe, and compared in constant time", () => {
    const first = randomToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(first).not.toBe(randomToken());
    expect(constantTimeEqual(first, first)).toBe(true);
    expect(constantTimeEqual(first, `${first}x`)).toBe(false);
  });
});
