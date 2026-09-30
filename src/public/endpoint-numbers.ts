/**
 * Numbers for custom endpoints. A custom setting's public identity leaves out its endpoint, which
 * stays private, so two endpoints serving one typed model name share it. Within a release each of
 * them gets `|#1`, `|#2`, … in the order of their private keys, which include the endpoint: unique
 * within the release, and derived from nothing an outsider could check a guessed host against.
 *
 * The release build uses this for public ids; the repository page's "(Endpoint N)" labels count
 * the same way; and the app uses it to show each endpoint's public number before a release.
 * Imports nothing, so the app can bundle it.
 */

export interface NumberedSetting {
  /** Private identity, including the endpoint. */
  key: string;
  /** Public identity, without the endpoint. */
  id: string;
  custom: boolean;
}

/**
 * Private keys in one fixed order, by character code: the same on every server whatever its
 * locale, which `localeCompare` is not. Numbering and listing both use it, so a release lists
 * endpoints in the order of their numbers.
 */
function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Each setting's public id within one release, by key. */
export function publicIds(settings: readonly NumberedSetting[]): Map<string, string> {
  const twins = new Map<string, string[]>();
  for (const setting of settings) {
    if (setting.custom) twins.set(setting.id, [...(twins.get(setting.id) ?? []), setting.key]);
  }
  const ids = new Map<string, string>();
  for (const setting of settings) {
    const keys = setting.custom ? (twins.get(setting.id) ?? []) : [];
    const number = [...keys].sort(compareKeys).indexOf(setting.key) + 1;
    ids.set(setting.key, keys.length > 1 ? `${setting.id}|#${number}` : setting.id);
  }
  return ids;
}

/**
 * The endpoint number in a public id, if it has one. One to three digits: an older release's
 * endpoint fingerprint (eight hex characters) is not a number, even when it is all digits.
 */
export function endpointNumber(publicId: string): number | undefined {
  const match = /\|#(\d{1,3})$/.exec(publicId);
  return match ? Number(match[1]) : undefined;
}
