---
id: 7016
title: "standalone: npm upstream unit modules keep host imports — Node builtins (`env.__node_*`), Web platform constructors (Request/Response/Blob/FormData/File/ReadableStream/AbortController), atob/btoa/fetch/crypto.subtle, `__js_array_new/push` and resolved-as-extern package functions survive `--target standalone`, so the zero-import lane cannot even instantiate those files"
status: ready
sprint: current
created: 2026-10-16
updated: 2026-10-16
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: feature
area: compiler
language_feature: platform-globals, node-builtins, web-apis
goal: standalone-gap
related: [7013]
---

# Standalone binaries retain host imports for platform surface

Largest failure cluster of the [#7013](./7013-standalone-upstream-unit-lane.md)
standalone upstream unit lane. The lane instantiates each test module with an
EMPTY import object and records any retained import as a `host-import` failure
(it never stubs one). Measured 2026-10-16 (`JS2WASM_UPSTREAM_TARGET=standalone`):

| suite | tests lost | retained imports (examples) |
| --- | --- | --- |
| hono | ~175 of 324 | `env.atob`, `env.btoa`, `env.Blob_new`, `env.FormData_new/append`, `env.File_new`, `env.ReadableStream_new`, `env.fetch`, `env.SubtleCrypto_importKey`, `env.Crypto_get_subtle`, `env.__node_crypto`; plus 57 tests failing at runtime with `Request is not defined` / `Response is not defined` |
| axios | ~164 of 231 | `env.__node_stream`, `env.__node_util`, `env.__node_path`, `env.__node_url`, `env.__node_util/types`, `env.__node_assert`, `env.hasSymbolShams`, `env.AbortController_new`, `env.FormData_new`, `env.Blob_new`, `env.__js_array_new/push` |
| jest | ~75 of 356 | `env.__node_os` (39), `env.__node_util/types` + `env.__node_vm` (20), `env.__node_fs`, `env.__node_path`, `env.__node_process` |
| prettier | 72 of 151 | `env.__node_assert` — from prettier's OWN `src/universal/assert.js` (`export { equal, ok, strictEqual } from "node:assert"`), plus `env.__node_url/path/fs/promises/module` for `massage-ast` / `resolve-parser` |
| three | 18 of 18 | `env.WebGL2RenderingContext_clientWaitSync`, `env.WebGL2RenderingContext_get_SYNC_FLUSH_COMMANDS_BIT`, … (three's math unit pulls the renderer constants) |
| typescript | 5 of 14 | (no import — `ReferenceError: Buffer is not defined` at module init) |
| redux | 1 of 82 | `env.__node_vm` |
| uuid | 15 of 75 | (no import — `crypto is not defined (no secure randomness provider in a standalone module)`) |

(An `assert` import in a generated TEST module is harness, not package code:
the #7013 lane resolves it to the compiled-in
`tests/dogfood/standalone-node-assert.js`. The prettier row above is package
code and is deliberately NOT rewritten.)

## Root cause (to confirm per family)

`--target standalone` still lowers four families through `env` imports instead
of either a Wasm-native implementation or a compile-time diagnostic:

1. **Node builtin namespaces** — an `import … from "node:<mod>"` (or a
   package's `require("stream")`) becomes an `env.__node_<mod>` namespace
   import (the JS-host `loadNodeHostDependencies` contract).
2. **Web platform constructors** — `new Blob()`, `new FormData()`,
   `new ReadableStream()`, `new AbortController()` lower to `env.<Ctor>_new` /
   method imports (the extern-class path), and bare `Request` / `Response`
   reads compile to a runtime `ReferenceError`.
3. **`atob` / `btoa` / `fetch` / `crypto.subtle` / `crypto.getRandomValues`**
   — global functions with host imports or a runtime throw.
4. **Runtime helpers** — `__js_array_new` / `__js_array_push` (a JS-array
   bridge) and `hasSymbolShams` (a package-internal function that the resolver
   treated as an external) leak into standalone output.

## Implementation Plan

1. **Inventory.** Add `--inspect-imports` output to the #7013 lane (already in
   `report.compile.details[].hostImports`) and group by family over all 19
   suites; this table is the acceptance denominator.
2. **Family 4 first (bugs, not features).** `__js_array_*`: find the emitter
   (`grep -rn "__js_array_new" src/codegen`) and gate it on
   `!ctx.standalone`, using the native vec path standalone already has.
   `hasSymbolShams`: reproduce with axios' `has-symbols/shams` and fix the
   resolver so a package-internal CJS export is compiled, not externalized.
3. **atob/btoa** — pure functions: implement Wasm-native versions in
   `src/runtime/` (Latin-1 range check → `InvalidCharacterError` DOMException
   shape), selected when `ctx.standalone`.
4. **Node builtins and Web constructors** — no host exists, so the compiler
   must reject at compile time with a diagnostic naming the builtin
   (`standalone target has no provider for node:stream`) instead of emitting
   an import. Then decide per builtin whether a native provider is in scope
   (`node:path`, `node:util/types`, `node:assert` are pure and cheap;
   `node:fs`/`node:vm`/`fetch` are not).
5. **Randomness** — `crypto.getRandomValues` has no entropy source without an
   import; keep the throw but make it a documented capability
   (`capabilityRequirements: ["random"]`) so a WASI build can satisfy it via
   `random_get`.
6. Re-measure the #7013 lane; `check:host-import-policy` must stay green.

## Acceptance

- No standalone suite module reports `hostImports` for families 1–4 except
  through an explicit compile diagnostic.
- hono / axios standalone pass counts rise by the tests whose only failure was
  the import (measure with the #7013 lane, one suite at a time).
- JS-host (`gc`) binaries byte-identical for an affected fixture.
