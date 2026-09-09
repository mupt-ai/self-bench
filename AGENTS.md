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
