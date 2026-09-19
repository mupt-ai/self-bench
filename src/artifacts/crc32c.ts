import { crc32c } from "@node-rs/crc32";

/** Preserve GCS checksum validation without hashing every archive byte in the JS event loop. */
export function createCrc32cValidator() {
  let value = 0;
  const encoded = () => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return bytes.toString("base64");
  };
  return {
    update(data: Buffer) {
      value = crc32c(data, value);
    },
    toString: encoded,
    validate(expected: string) {
      return encoded() === expected;
    },
  };
}
