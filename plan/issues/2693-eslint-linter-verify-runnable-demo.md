---
id: 2693
title: "MILESTONE: ESLint-style Linter.verify runs as Wasm in Node (host-delegated parse)"
status: done
created: 2026-06-26
updated: 2026-07-26
completed: 2026-06-26
priority: high
feasibility: hard
reasoning_effort: high
task_type: test
area: codegen
language_feature: host-delegated-parsing
goal: npm-library-support
assignee: ttraenkler/sendev-eslint
es_edition: n/a
related: [1282, 1400, 1573, 1712, 2689, 2691, 1791, 3653, 3654, 3655, 3657]
---
# MILESTONE — ESLint-style Linter.verify runs as Wasm in Node.js

## 2026-07-26 scope correction

The original TypeScript-scanner demo remains real and green: its one test
compiles, validates, instantiates, and checks four runtime results.

The separate real-`espree`/real-`esquery` confirmation was not exercising that
seam on macOS. Its hard-coded `/workspace/...` lookup was caught and returned
from the test, which Vitest reported as PASS. With only the path corrected, the
test loads the real packages and then fails compilation:

```text
IR path failed for Linter_verify:
call to unknown function "__host_is_statement" [IR-FALLBACK]
```

Path/skip correctness is #3653; the ambient boolean host-call IR gap is #3657.
Accordingly, this completed milestone proves the smaller scanner-delegated
architecture, **not** the real dual-delegation seam and not the real ESLint npm
package.

The older statement below that ESLint's external dependencies are uninstalled
is historical and no longer true. Current package-graph resolution is #3654;
JSON `require` is #3655.

The demonstrable "eslint runs as Wasm" milestone for the npm-library-support
goal. An ESLint-style `Linter` class with `verify()` + the ESLint-core `semi`
rule is **compiled to Wasm**, **instantiated in Node**, and **run** — producing
correct lint diagnostics — with **parse host-delegated** (decoupled from a
compiled parser, acorn #1712).

Test: `tests/issue-2693-linter-verify-demo.test.ts`. Standalone demo:
`.tmp/linter-demo/{linter.ts,run.mts}`.

```
PASS  verify("var x = 1")  => "Missing semicolon. (1:9)"
PASS  verify("var x = 1;") => ""
PASS  verify("let y = 2")  => "Missing semicolon. (1:9)"
PASS  verify("const z = 3;") => ""
ALL PASS — Linter.verify runs as Wasm in Node (parse host-delegated)
```

## Architecture proven
1. **Lint logic in Wasm** — `class Linter { verify(code) {...} }` + the `semi`
   rule compiles to a 1 KB WasmGC module.
2. **Parse host-delegated** — the module imports `__parse` / `__tok_value` /
   `__tok_line` / `__tok_col`; the Node harness fulfils them with TypeScript's
   scanner (espree/acorn stand-in). The wasm contains **no parser** — exactly
   the `ParserService.language.parse` host-delegation seam identified in #1573.
3. **Runs in Node** — instantiated via `WebAssembly.instantiate(binary,
   importObject)` + `__setExports`, then `verify(...)` is called and returns
   real `Missing semicolon. (line:col)` messages with correct positions.

## Why the demo, not the real `eslint` package
Surveyed on current main (post #2689 + node:path #1791). Compiling the REAL
`eslint/lib/linter/linter.js` end-to-end is gated on a large surface NOT
present / not yet supported in this environment:

- **External npm deps are not even installed**: `eslint-scope`,
  `eslint-visitor-keys`, `@eslint/core`, `@eslint/plugin-kit`, `espree`,
  `debug` — all MISSING from `node_modules` (eslint 10 expects them as
  separate installs). linter.js's `require(...)` of each fails to resolve.
- **node:path module declaration** — `require("node:path")` still reports
  "Cannot find module" at the TS-checker layer even though #1791 landed a
  runtime impl (the module's type/resolution surface is the remaining gap).
- **JSON imports** — `require("../../package.json")`.
- **Internal-export cascade** — `FlatConfigArray` / `Config` / etc. report
  "declares X locally, but it is not exported" because their target modules
  fail to compile first (same cascade as api.js #2691), not a resolver bug.

So the real-`eslint` Linter is the endgame (gated on the npm-dep tree +
node-builtin substrate #1575). This milestone proves the **architecture** end
to end now, host-delegating both parse (#1712-independent) and the dep tree.

## Next steps toward the real Linter.verify (carryable)
- Install / vendor + compile (or host-shim) `eslint-scope`, `@eslint/core`,
  `@eslint/plugin-kit`, `eslint-visitor-keys`; host-delegate `espree` parse and
  `debug`.
- Register a `node:path` TS module declaration so `require("node:path")`
  resolves (pairs with the #1791 runtime).
- JSON `require("*.json")` import support.
- Then re-run the #1573 survey on linter.js with the deps present.
