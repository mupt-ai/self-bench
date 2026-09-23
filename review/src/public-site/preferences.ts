/**
 * Where the theme and animation choices are kept, so selfbench.dev and app.selfbench.dev agree.
 * Local storage belongs to one origin, so a choice made on the public site would not reach the
 * app. A cookie on the shared parent domain does, so each choice is written to both and read
 * from the cookie first. Local development (127.0.0.1, any port) shares host-only cookies,
 * since cookies ignore the port. `index.html` of both sites applies the same rule before first
 * paint; keep the two in step with this file.
 */

/** The registrable domain both sites sit under. */
const SHARED_DOMAIN = "selfbench.dev";
const YEAR_SECONDS = 60 * 60 * 24 * 365;

interface Browser {
  storage?: Pick<Storage, "getItem" | "setItem">;
  jar?: { cookie: string };
  location?: Pick<Location, "hostname" | "protocol">;
}

function browser(): Browser {
  if (typeof document === "undefined" || typeof location === "undefined") return {};
  let storage: Browser["storage"];
  try {
    storage = localStorage;
  } catch {
    // Blocked storage: the cookie alone carries the choice.
  }
  return { ...(storage ? { storage } : {}), jar: document, location };
}

/** The cookie attributes that make one value visible to every selfbench.dev host. */
function cookieScope(location: Browser["location"]): string {
  const host = location?.hostname ?? "";
  const shared = host === SHARED_DOMAIN || host.endsWith(`.${SHARED_DOMAIN}`);
  return `; Path=/; Max-Age=${YEAR_SECONDS}; SameSite=Lax${shared ? `; Domain=${SHARED_DOMAIN}` : ""}${
    location?.protocol === "https:" ? "; Secure" : ""
  }`;
}

/** A `getItem`/`setItem` pair over the shared cookie and this origin's local storage. */
export function sharedPreferences(
  from: Browser = browser(),
): Pick<Storage, "getItem" | "setItem"> | undefined {
  const { storage, jar, location } = from;
  if (!storage && !jar) return undefined;
  return {
    getItem(key) {
      const cookie = jar?.cookie
        .split(/;\s*/)
        .find((part) => part.startsWith(`${key}=`))
        ?.slice(key.length + 1);
      if (cookie) return decodeURIComponent(cookie);
      try {
        return storage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        storage?.setItem(key, value);
      } catch {
        // Blocked storage: the cookie still carries the choice.
      }
      if (jar) jar.cookie = `${key}=${encodeURIComponent(value)}${cookieScope(location)}`;
    },
  };
}
