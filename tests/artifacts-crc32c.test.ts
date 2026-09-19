import { expect, test } from "bun:test";
import { CRC32C } from "@google-cloud/storage";
import { createCrc32cValidator } from "../src/artifacts/crc32c.js";

test("native CRC32C matches GCS across empty inputs, chunk boundaries, and binary bytes", () => {
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.from("123456789"),
    Buffer.from("data"),
    Buffer.from(Array.from({ length: 1024 * 1024 }, (_, i) => i % 256)),
  ]) {
    const expected = new CRC32C();
    expected.update(bytes);
    for (const size of [1, 17, 65536, Math.max(bytes.length, 1)]) {
      const actual = createCrc32cValidator();
      for (let offset = 0; offset < bytes.length; offset += size) {
        actual.update(bytes.subarray(offset, offset + size));
      }
      expect(actual.toString()).toBe(expected.toString());
      expect(actual.validate(expected.toString())).toBe(true);
      expect(actual.validate("not the checksum")).toBe(false);
    }
  }
  const known = createCrc32cValidator();
  known.update(Buffer.from("123456789"));
  expect(known.toString()).toBe("4waSgw==");
});
