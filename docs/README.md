# SelfBench Docs

This directory is a standalone [Mintlify](https://mintlify.com/) site. It uses the same `docs.json`/MDX layout as `dari-mono/dari-docs`; it is not served by the SelfBench API.

Requires Node.js 22 or 24 (Mintlify does not support Node.js 25).

```bash
cd docs
npm ci
npm run dev
npm run validate
```

To publish, connect `mupt-ai/self-bench` to a Mintlify project with **docs** as its documentation directory. Configure the production domain in Mintlify and DNS; no docs domain is assumed here. The CI docs job checks the build and internal links on every PR.
