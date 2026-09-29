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

- Every model vendor has one color and one display name, in `VENDOR_COLORS` and `VENDOR_NAMES` in `review/src/public-site/format.ts`. Both results charts (the selfbench.dev repository page and the app's Results page) and the public tables use them, so a vendor looks the same everywhere.
- When a new vendor becomes available, whether through a new direct provider or through OpenRouter (whose model names start with the vendor, as in `z-ai/glm-5.3`), add it to both. An unlisted vendor falls back to the grey that Custom uses and to its raw id. Pick a hue that stays distinct from the other vendors in both light and dark mode.

## Public Site

- Work under `review/src/public-site/` (selfbench.dev) also follows `review/src/public-site/AGENTS.md`: how pages adapt to phones, and when and how to run the phone checks.
