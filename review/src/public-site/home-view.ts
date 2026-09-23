/**
 * Where the home page was when someone left it for a repository, so coming back puts them
 * exactly there. Kept in session storage, keyed by the home page's history entry, so it
 * survives a reload of that tab but not a new visit.
 */
export interface HomeView {
  scrollTop: number;
  query: string;
  /** The card that was opened and where it sat on screen, to scroll back to exactly. */
  anchor?: { line: string; top: number };
}

const VIEWS = "selfbench-home-views";
const JOURNEY = "selfbench-journey";
/** How many home views to keep; older ones are dropped. */
const KEEP = 20;

function read<T>(key: string): T | undefined {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private windows and full storage: going back simply starts at the top.
  }
}

export function saveHomeView(entry: string, view: Partial<HomeView>): void {
  const views = read<Record<string, HomeView>>(VIEWS) ?? {};
  const merged: HomeView = { ...(views[entry] ?? { scrollTop: 0, query: "" }), ...view };
  delete views[entry];
  const kept = Object.entries(views).slice(-(KEEP - 1));
  write(VIEWS, Object.fromEntries([...kept, [entry, merged]]));
}

export function homeView(entry: string | undefined): HomeView | undefined {
  return entry ? read<Record<string, HomeView>>(VIEWS)?.[entry] : undefined;
}

/**
 * A trip from a home page into a repository: which home entry it left from, for which
 * repository, and the history entries of that repository reached on the way. The trip only
 * grows by in-app steps from the home entry or one of its pages, so a pasted or typed link,
 * even to the same repository, never returns to a scrolled home page.
 */
interface Journey {
  entry: string;
  repository: string;
  pages: string[];
}

export function startJourney(entry: string, repository: string): void {
  const journey = read<Journey>(JOURNEY);
  const same = journey?.entry === entry && journey.repository === repository;
  write(JOURNEY, { entry, repository, pages: same ? journey.pages : [] } satisfies Journey);
}

/**
 * Notes an arrival at history entry `key` showing `repository`, from entry `previous` (none
 * for a fresh page load). A step from the trip's home entry or one of its pages joins the trip.
 */
export function followJourney(key: string, repository: string, previous?: string): void {
  const journey = read<Journey>(JOURNEY);
  if (!journey || journey.repository !== repository || journey.pages.includes(key)) return;
  if (previous !== journey.entry && !journey.pages.includes(previous ?? "")) return;
  write(JOURNEY, { ...journey, pages: [...journey.pages, key] } satisfies Journey);
}

/** The home entry this page's trip started from, if the visitor came from one. */
export function journeyFrom(key: string, repository: string): string | undefined {
  const journey = read<Journey>(JOURNEY);
  return journey?.repository === repository && journey.pages.includes(key)
    ? journey.entry
    : undefined;
}

/**
 * Set by the home page while it is showing: records where it is now and, when leaving for a
 * repository, starts the trip there.
 */
let saveShownHome: ((leavingFor?: string) => void) | undefined;

export function onSaveHome(save: ((leavingFor?: string) => void) | undefined): void {
  saveShownHome = save;
}

/** Records the home page's current view, if it is showing, before history leaves it. */
export function saveHomeNow(leavingFor?: string): void {
  saveShownHome?.(leavingFor);
}

/** The repository ("owner/name") a path points at, if it is a repository page. */
export function repositoryOf(path: string): string | undefined {
  const [owner, name] = path.split("/").filter(Boolean);
  return owner && name ? `${owner}/${name}` : undefined;
}
