const TEMPLATE_NAME_SEGMENT = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const TEMPLATE_TAG = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export function normalizeE2BBuildName(value: string): string {
  const name = normalizeE2BTemplateReference(value);
  if (name.includes("/")) {
    throw new Error("E2B template build name must not include a team namespace");
  }
  return name;
}

export function normalizeE2BTemplateReference(value: string): string {
  const reference = value.trim();
  if (!reference) {
    throw new Error("E2B template reference must not be blank");
  }
  const colon = reference.indexOf(":");
  if (colon !== -1 && colon !== reference.lastIndexOf(":")) {
    throw invalidTemplateReference(value);
  }

  const name = colon === -1 ? reference : reference.slice(0, colon);
  const tag = colon === -1 ? undefined : reference.slice(colon + 1);
  const segments = name.split("/");
  if (
    segments.length > 2 ||
    segments.some((segment) => !TEMPLATE_NAME_SEGMENT.test(segment)) ||
    (tag !== undefined && !TEMPLATE_TAG.test(tag))
  ) {
    throw invalidTemplateReference(value);
  }
  return reference;
}

export function normalizeE2BDomain(value: string | undefined): string | undefined {
  const domain = value?.trim();
  if (!domain) {
    return undefined;
  }
  if (domain.includes("://") || /[\s/]/.test(domain)) {
    throw new Error("E2B domain must be a hostname without a scheme or path");
  }
  const portSeparator = domain.lastIndexOf(":");
  const hostname = portSeparator === -1 ? domain : domain.slice(0, portSeparator);
  const port = portSeparator === -1 ? undefined : domain.slice(portSeparator + 1);
  const labels = hostname.split(".");
  if (
    hostname.length > 253 ||
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
    ) ||
    (port !== undefined && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535))
  ) {
    throw new Error("E2B domain must be a valid hostname with an optional port");
  }
  return `${hostname.toLowerCase()}${port === undefined ? "" : `:${port}`}`;
}

function invalidTemplateReference(value: string): Error {
  return new Error(
    `invalid E2B template reference ${JSON.stringify(value)}; use lowercase name[:tag] or team/name[:tag] with letters, digits, hyphens, underscores, and optional periods in the tag`,
  );
}
