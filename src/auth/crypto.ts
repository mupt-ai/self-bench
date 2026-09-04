import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Opaque, unguessable identifier for OAuth state (256 bits, URL safe). */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/**
 * One configured secret, two independent keys: signing session cookies and sealing GitHub
 * tokens must not share key material, so each purpose gets its own HKDF derivation.
 */
export function deriveKey(secret: string, purpose: "session-signing" | "token-sealing"): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "", `selfbench:${purpose}`, 32));
}

export function hmacSign(key: Buffer, message: string): string {
  return createHmac("sha256", key).update(message).digest("base64url");
}

export interface SecretBox {
  seal(plaintext: string): Uint8Array;
  open(sealed: Uint8Array): string;
}

/**
 * AES-256-GCM sealed box. The GitHub access token is the only thing stored this way: a
 * database read alone must not yield a usable credential.
 */
export function createSecretBox(key: Buffer): SecretBox {
  return {
    seal(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    open(sealed) {
      const bytes = Buffer.from(sealed);
      if (bytes.length < IV_BYTES + TAG_BYTES) throw new Error("sealed value is too short");
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, IV_BYTES));
      decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([
        decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}
