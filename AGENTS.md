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
