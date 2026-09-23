import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sharedPreferences } from "./preferences";

/** A cookie jar that keeps name=value pairs the way a browser does, ignoring attributes. */
function browser(hostname: string, protocol = "https:", saved: Record<string, string> = {}) {
  const cookies = new Map<string, string>();
  const written: string[] = [];
  const store = new Map(Object.entries(saved));
  return {
    written,
    store,
    from: {
      storage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
      },
      jar: {
        get cookie() {
          return [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
        },
        set cookie(line: string) {
          written.push(line);
          const [pair = ""] = line.split(";");
          const [key = "", value = ""] = pair.split("=");
          cookies.set(key, value);
        },
      },
      location: { hostname, protocol },
    },
  };
}

test("a choice made on selfbench.dev is written to the shared parent domain", () => {
  const site = browser("selfbench.dev");
  sharedPreferences(site.from)?.setItem("selfbench-theme", "dark");
  expect(site.written[0]).toContain("selfbench-theme=dark");
  expect(site.written[0]).toContain("; Domain=selfbench.dev");
  expect(site.written[0]).toContain("; Secure");
  expect(site.store.get("selfbench-theme")).toBe("dark");
  for (const host of ["app.selfbench.dev", "dev-app.selfbench.dev"]) {
    const app = browser(host);
    sharedPreferences(app.from)?.setItem("selfbench-theme", "light");
    expect(app.written[0]).toContain("; Domain=selfbench.dev");
  }
});

test("other hosts keep a host-only cookie, which local ports still share", () => {
  const local = browser("127.0.0.1", "http:");
  sharedPreferences(local.from)?.setItem("selfbench-motion", "off");
  expect(local.written[0]).not.toContain("Domain=");
  expect(local.written[0]).not.toContain("Secure");
  expect(browser("notselfbench.dev").written).toEqual([]);
  const lookalike = browser("notselfbench.dev");
  sharedPreferences(lookalike.from)?.setItem("selfbench-theme", "dark");
  expect(lookalike.written[0]).not.toContain("Domain=");
});

test("the shared cookie wins over this origin's older local choice", () => {
  const app = browser("app.selfbench.dev", "https:", { "selfbench-theme": "light" });
  const preferences = sharedPreferences(app.from);
  expect(preferences?.getItem("selfbench-theme")).toBe("light");
  app.from.jar.cookie = "selfbench-theme=dark";
  expect(preferences?.getItem("selfbench-theme")).toBe("dark");
  expect(preferences?.getItem("selfbench-motion")).toBeNull();
});

test("both sites apply the saved choice with the same script before first paint", () => {
  const script = (file: string) =>
    /<script>[\s\S]*?<\/script>/.exec(readFileSync(join(import.meta.dir, file), "utf8"))?.[0];
  const app = script("../../index.html");
  expect(app).toContain("Domain=selfbench.dev");
  expect(script("../../public-site/index.html")).toBe(app);
});
