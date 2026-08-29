---
id: 642
title: "Deno/Cloudflare loader plugins"
status: ready
created: 2026-03-19
updated: 2026-08-28
priority: low
feasibility: medium
reasoning_effort: high
goal: platform
sprint: Backlog
depends_on: [599]
files:
  examples/:
    new:
      - "deno-loader/ and cloudflare-worker/ examples"
---
# #642 — Deno/Cloudflare loader plugins

## Status: Deno half done (2026-08-28); Cloudflare half open

Create loader plugins for transparent js2wasm compilation in Deno Deploy and Cloudflare Workers.

### Progress

- **Deno: DONE** — `examples/deno-loader/` ships a runtime-agnostic
  `loadWasmModule()` loader (compile-on-import via `@loopdive/js2` +
  `wrapExports`, per-specifier instance cache, strict-diagnostics rejection)
  with a `deno.json` import map (`npm:@loopdive/js2`) and entry example.
  Deno has no pluggable module-loader hook, so the integration point is an
  explicit loader function rather than a `deno.json` plugin. The loader
  pipeline is CI-validated under Node in
  `tests/issue-642-deno-loader.test.ts` (CI has no Deno install). A real
  `deno run --allow-read --allow-env main.ts` under Deno 2.9.6 with the
  published `npm:@loopdive/js2@0.70.0` was verified by hand 2026-08-28:
  exact expected output.
- **Cloudflare: open** — wrangler build plugin that compiles before deploy.

### Approach
1. Deno: loader module that compiles .ts to .wasm on import (done, see above)
2. Cloudflare: wrangler build plugin that compiles before deploy
3. Both: thin JS shell that instantiates the Wasm module

## Complexity: M
