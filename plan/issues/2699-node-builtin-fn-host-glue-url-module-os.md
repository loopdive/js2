---
id: 2699
title: "node builtins: destructured/named function imports for url/module/os route to host (eslint host-glue)"
status: done
completed: 2026-06-26
assignee: ttraenkler/agent-ae565d4893a5783d7
created: 2026-06-26
updated: 2026-06-26
priority: high
feasibility: easy
reasoning_effort: medium
task_type: feature
area: host-interop
language_feature: node-builtins
goal: npm-library-support
related: [1791, 1792, 1044, 1491, 1492, 2693]
---
# #2699 — node:url / node:module / node:os destructured-import host-glue

## Problem (verify-first findings)

Real-eslint-runs need the Node builtins eslint/lib imports. Verified on current
`main`:

- The **namespace** form already works in a JS host: `const os = require("node:os");
  os.platform()` → "linux", `const fs = require("node:fs"); fs.existsSync(p)` →
  true. The `node_builtin` runtime resolver (`src/runtime.ts:11981`) already does
  `require(modName)` and member dispatch flows through `__extern_get`. No new
  runtime shim is needed for the namespace form.
- The **destructured / named** form was BROKEN: `const { pathToFileURL } =
  require("node:url")` (eslint's actual form — cli.js, config-loader.js, eslint.js)
  generated **no host import** — `pathToFileURL` fell through to a generic `env`
  stub and resolved to `undefined`. eslint imports node builtins destructured:
  `{ pathToFileURL }`, `{ createRequire }`, `{ isMainThread, threadId }`, etc.

The working mechanism for named/destructured function imports is the existing
`__nodefn__<module>__<fn>` typed-stub path (`NODE_BUILTIN_FN_TYPED_STUBS` →
`node_builtin_fn` ImportIntent → `require(module)[fn]` host adapter), already used
by `node:crypto` (#1491/#1492). The gap was simply that url/module/os had no
entries (and `node:module` was not even in `NODE_BUILTIN_MODULES`).

## Fix (pure data — runtime route already exists)

`src/import-resolver.ts`:
- Added `node:module` to `NODE_BUILTIN_MODULES`.
- Added `NODE_BUILTIN_FN_TYPED_STUBS` entries for the eslint function surface:
  - `url`: `pathToFileURL`, `fileURLToPath`
  - `module`: `createRequire`
  - `os`: `platform`, `release`

## Verified

`const { pathToFileURL, fileURLToPath } = require("node:url")` → routes to
`__nodefn__url__pathToFileURL` / `__nodefn__url__fileURLToPath`:
- `pathToFileURL("/tmp/x.js").href` → "file:///tmp/x.js"
- `fileURLToPath("file:///tmp/x.js")` → "/tmp/x.js"
- `os.platform()` → "linux", `os.release()` → "6.12.76-linuxkit"
- `createRequire("/tmp/x.js")` → a function

`tests/issue-2699.test.ts` covers classification + round-trips with the real
modules injected via `buildImports(..., deps)`.

## Deferred follow-ups

### 2026-08-22 Jest defaults host seam

The original Jest `Defaults.test.ts` unit also imports the named
`node:os` function `tmpdir`. The generic named-builtin path returned a null
value for that member even though the namespace route was available. Added
`tmpdir` to the existing `node:os` typed-function table and extended the
classification/host-value test above. This keeps the package test on the
same real Node host boundary; no Jest test body or expected value was changed.

Implementation: [PR #4764](https://github.com/loopdive/js2/pull/4764).

- **`node:fs/promises`** — the `/` in the module name breaks the
  `__nodefn__<module>__<fn>` identifier scheme (would emit an invalid
  `__nodefn__fs/promises__readFile` declaration). Needs slash-sanitisation
  coordinated across the import-manifest classifier + runtime resolver. eslint's
  `fs/promises` use is in the CLI/config layers, not the Linter.verify hot path.
- **`node:worker_threads`** — `Worker`/`parentPort`/`isMainThread` are
  value/class-shaped, not functions, so the function-stub pattern doesn't fit;
  CLI-only (not eslint/lib), deferred.
- **`node:url` `URL` class** (a global + class) and **`node:util`
  styleText/stripVTControlCharacters** — separate shapes/efforts.
- Standalone (`--target wasi`) host-glue is out of scope (these route to the JS
  host `require`); dual-mode for these is a follow-up.
