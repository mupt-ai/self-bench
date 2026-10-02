# SelfBench Agent Instructions

## UI Copy and Casing

- Use Title Case for authored UI labels: page and section headings, navigation, buttons, action links, field labels, table headings, menu items, and short selector options.
- Capitalize the first and last words and all significant words. Keep articles, coordinating conjunctions, and short prepositions lowercase inside a label (for example, `Back to Run`, `Continue with GitHub`, and `Provider or Sandbox`).
- Examples: `Manage Credentials`, not `Manage credentials`; `Run Dataset`, not `Run dataset`; `Model API Key`, not `Model API key`; `Estimated Model Cost / Task`, not `Estimated model cost / task`.
- Match accessible names and control tooltips to the same casing as their visible labels. Use Title Case for short search/filter placeholders; retain sentence case for instructional placeholders and full-sentence tooltips.
- Keep descriptions, helper text, confirmations, error messages, log output, and other prose in sentence case. Do not title-case entire sentences.
- Preserve brands, acronyms, filenames, model/provider IDs, repository names, user-authored content, and API values exactly (`OpenAI`, `OpenRouter`, `API`, `PR`, `auth.json`, `mupt-ai/self-bench`). Change presentation copy, not persisted values.
- Write the intended casing in the source. Do not add CSS `capitalize` or a runtime title-casing utility; existing intentional uppercase badge styling may remain.
- Apply this rule to new UI and update label-sensitive tests when changing existing copy.

## Model Vendors

- Every model vendor has one color and one display name, in `VENDOR_COLORS` and `VENDOR_NAMES` in `src/public/vendors.ts`. Both results charts (the selfbench.dev repository page and the app's Results page), the public tables, and the link preview images the server draws use them, so a vendor looks the same everywhere.
- When a new vendor becomes available, whether through a new direct provider or through a gateway in `src/gateways/` (whose model names start with the vendor, as in `z-ai/glm-5.3`), add it to both. Vendors are keyed as OpenRouter spells them; a gateway that spells one differently maps it in its `vendorAliases`. An unlisted vendor falls back to the grey that Custom uses and to its raw id. Pick a hue that stays distinct from the other vendors in both light and dark mode.

## Public Site

- Work under `review/src/public-site/` (selfbench.dev) also follows `review/src/public-site/AGENTS.md`: how pages adapt to phones, and when and how to run the phone checks.
- Any change to what a selfbench.dev page shows, or a new page, also follows "selfbench.dev for Search Engines" below.

## selfbench.dev for Search Engines

**The approach.**
- selfbench.dev is a Vite React app rendered in the browser. The API server hands out its build, behind a CDN, as it does for the app.
- The server doesn't render React. It writes only the cheap parts that search engines, AI crawlers and link previews read before any script runs: each page's head, its text, and the API response its first render needs.
- The browser draws the page itself. The script replaces the server's text the moment it mounts, with no transition, so the finished page shows as soon as possible.
- This is deliberate instead of a server-rendering framework (Next.js, Astro, and the like):
  - it stays one service to run, with no React renderer on the server
  - pages change whenever someone releases, which rules out a static build
  - the site's browser-only effects (the water background, page transitions) need no server-side guards and cause no hydration mismatches
- Keep to it. Only revisit it if selfbench.dev grows into a content-heavy site: docs, a blog, many explainer pages.

All of it is built from the released lines on every request, so a release or withdrawal needs no step of its own. What does need keeping up is the server's copy of the site itself.

- **What is automatic.** The server builds each of these from the released lines:
  - the head: title, description, canonical address, Open Graph and X tags, and the link preview image (`src/api/site-head.ts`, `src/api/link-card.ts`)
  - the page's text (`src/api/site-body.ts`) and the API response its first render reads (`pageData`)
  - schema.org data: WebSite on the home page; breadcrumbs and a Dataset on a repository page
  - `/sitemap.xml` and `robots.txt`
  - IndexNow notifications on every release and withdrawal (`src/api/indexnow.ts`)

  `src/api/site-pages.ts` puts a page together, and the shared strings are in `src/public/seo.ts`.
- **Keep the server's text in step with the page.** `site-body.ts` repeats what the page shows: its headings ("All Settings", "Tasks", "Other Benchmarks of This Repo") and the settings table's column names (`ModelTable.tsx`). When you rename, add or remove one on the page, make the same change there. The home heading is `HOME_HEADING` in `seo.ts`, which both use. Keep exactly one `<h1>` per page, with the page's own heading.
- **Titles live in one place.** The site sets the same titles as the server (`useTitle` with `HOME_TITLE` or `repositoryTitle`), so change them in `seo.ts` only.
- **A new page needs all of these,** or search engines get a 404, a generic head or an empty page:
  1. its status in `site-pages.ts`
  2. its own title, description and canonical address in `site-head.ts`
  3. its text in `site-body.ts`
  4. an entry in the sitemap (`sitemapOf`)
  5. `useTitle` with the same title

  If its first render reads the public API, carry that response with `pageData`, as the home and repository pages do.
- **Caching keeps every page within about 15 seconds of a release.**
  - Pages, the sitemap and the public API send `public, max-age=0, s-maxage=10`: `PAGE_CACHE` in `results-site.ts`, `CACHED` in `routes/public-releases.ts`.
  - The CDN keeps them 10 seconds and, because of `s-maxage`, never hands out an expired copy. Browsers check every time, which is a bodyless `304` while the `ETag` matches.
  - Don't drop `s-maxage` or add `stale-while-revalidate`. Without `s-maxage`, Cloud CDN hands an expired copy, possibly hours old, to the first request after its lifetime. `stale-while-revalidate` caps outage serving too.
  - Don't lengthen these lifetimes unless releases also clear the CDN.
  - Files whose address changes with their content may be cached long: hashed scripts, and link preview images, which carry the release id.
  - A release's task list, task files and downloads never change, but must go within a minute of a withdrawal, so they are kept a minute (`TASK_DATA` in `routes/public-tasks.ts`). A new release has new addresses, so this delays nothing.
  - IndexNow waits past the page lifetime before notifying.
- **Descriptions aim for 160 characters or fewer,** the most search results show and the most Bing accepts without a warning.
  - A generated one (`repositoryDescription`) drops whole sentences past 160 but always keeps its opening question. In an edge case, such as a very long repository name, it may run over. That's fine: search results just cut it off.
  - A hand-written one should fit.
- **Some copy states how SelfBench works:** `HOME_TITLE`, `HOME_DESCRIPTION`, `HOME_HEADING`, and the Dataset's `measurementTechnique` in `site-head.ts`. Update them if the product changes, such as how tasks are built or scored.
- **Addresses are what search engines know a page by.** Don't change a page's address, or the canonical rules (a repository's own casing; a publisher's default line shares the repository's address), without a redirect from the old one.
- **Published tasks stay out of search and training crawls.** A publisher can publish a release's tasks (the release dialog's Publish Tasks; `tasksPublished` in the payload). The site lists them and opens each in a viewer (`?task=` on the repository page, which keeps the page's canonical address), and anyone can download them. But the tasks are a benchmark: their data, all under `/api/public/releases/<id>/tasks`, answers `noindex`, and robots.txt disallows that path, ahead of its `Allow: /`, since many crawlers take the first rule that matches. The page text only says the tasks are there. Keep it that way. Agents under evaluation cannot reach the site at all: their network allows only the model provider's hosts.
- **Served tasks carry a canary** (`src/public/task-canary.ts`): BIG-bench's line, which training-data filters look for, with SelfBench's own GUID inside it, so a model can be tested for having trained on the tasks. The download and the viewer's files add it, at the end, to the files SelfBench writes that hold comments; never to the instruction (the agent's prompt), patches or JSON, and stored tasks never change. The GUID comes from the `selfbench-task-canary` secret (`SELFBENCH_TASK_CANARY`, `task_canary` in `TF_INPUTS_JSON`). Never put it in this repository, where a model could learn it from the code, and never change it.
- **Only prod is indexed.** Only where `SELFBENCH_RESULTS_SITE_INDEX` is `true`, as in prod, does the site serve a sitemap and the IndexNow key, and send notifications. Everywhere else it answers `noindex`. Keep new search features behind the same switch.
- **The IndexNow key is public by design.** `INDEXNOW_KEY` is served at `/<key>.txt` for engines to check, so it lives in the code. Leave it unchanged, since engines re-verify a new one.
- **Tests cover each piece:** `tests/results-site*.test.ts`, `site-head`, `site-body`, `page-data`, `indexnow` and `site-icons`. Update them with the change.

## Site Icons

- The app and selfbench.dev share one set of icons in `review/public/`, the static folder of both builds, served from the site root:
  - `dari-logo.svg`: the mark, and the SVG tab icon.
  - `favicon.ico`: the mark at 48, 32 and 16px, for tabs and search results.
  - `icon-192.png`: the mark with a white ring (a 32-unit white stroke on its circle), on transparency.
  - `apple-touch-icon.png`: the ringed mark on a black square, 180px, for phone home screens.
- Keep `favicon.ico` and `apple-touch-icon.png` at the root under those names: browsers and crawlers request those paths without reading the page.
- Both `index.html` files link the same icons, and the app serves each one without sign-in (`ICONS` in `src/api/http.ts`). `tests/site-icons.test.ts` checks both, so a new icon needs all three.

## Model Gateways

- Gateways (one key for every vendor's models: OpenRouter, Vercel AI Gateway) live in `src/gateways/`, one file each, registered in `gateways` in `src/gateways/index.ts`. A gateway's id is its credential kind and Pi's provider name for it. Evaluation routes, Harbor trials, generation, the credential editor, and access labels all read that registry, so a new gateway is a new file plus a registry entry (and a `harbor_gateway.py` Pi adapter when Harbor does not pass Pi the gateway's key variable, as for Vercel).
