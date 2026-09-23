---
id: 6660
title: "npm-compat: standalone perf lanes inherit the JS-host package-entry compile failure, hiding their real blockers (axios #3587, lodash/prettier TS8017)"
status: ready
sprint: Backlog
created: 2026-09-23
updated: 2026-09-23
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: tooling
goal: standalone
related: [3587, 1472, 1474, 2182, 2631, 1768, 2863]
---

# Standalone perf lanes show the host lane's compile error, not their own

## Problem

`benchmarks/results/npm-compat.json` (refresh 2026-09-14) reports the same
diagnostic in all four perf lanes (`jsHost`, `jsHostNative`, `standalone`,
`standaloneDynamic`) for axios, lodash and prettier:

| package  | diagnostic shown in `standaloneDynamic`                                  |
| -------- | ------------------------------------------------------------------------ |
| axios    | `async shape not supported: … sits inside a try … (#3587)`               |
| lodash   | `Signature declarations can only be used in TypeScript files.`           |
| prettier | `Signature declarations can only be used in TypeScript files.`           |

None of these comes from a `--target standalone` compile. In
`scripts/generate-npm-compat-report.mjs::perfNpmCompatPackage`, when the
**JS-host package-entry report** (`runNpmCompatCatalogHarness`, `target: "gc"`)
fails, `blocked = packagePerfFailure(spec, reportCompileDiagnostic(report)).lanes`
is copied into `standalone` and `standaloneDynamic` as well
(`blocked?.standalone ?? …`, `blocked?.standaloneDynamic ?? …`). Only
`jsHostNative` is exempt.

Evidence that the standalone compiler never raises #3587:
`reportDeclinedAsyncRejectionHazard` (src/codegen/async-activation.ts) returns
early on `ctx.wasi === true || ctx.standalone === true`.

Consequence: work gets routed to the wrong lane (a standalone async-planner task
was cut for axios on the strength of this row).

## Measured on upstream/main 9b1ba0d19f (2026-09-23)

Host package-entry compile (`node --import tsx tests/dogfood/npm-compat-catalog-harness.mjs --package <pkg> --json`):

- axios: 1 error, `lib/adapters/fetch.js:219:32` — the #3587 loud refusal on the
  `await resolveBodyLength(...)` inside `if` inside `try` of the fetch adapter's
  `async (config) => {…}` (awaits inside `if`, inside an `&&`-chain assignment
  `(requestContentLength = await …) !== 0`, then more awaits later in the try).
  A HOST-lane planner gap.
- lodash: 8 errors, TS8017/TS8010 at `lodash.js:2:18` / `3:25` … — the
  TS-syntax prelude checked as JS (#2631/#1768 family in `src/compiler.ts`
  ~L1445 / `src/checker/index.ts` ~L763/L929). Front-end, not async.

Standalone-dynamic lane, run directly
(`npx tsx scripts/generate-npm-compat-report.mjs --only <pkg> --no-write --perf-only --lane standalone-dynamic`,
which passes no report and so no `blocked`):

| package  | real first standalone-dynamic diagnostic                                                  |
| -------- | ----------------------------------------------------------------------------------------- |
| axios    | `'__get_builtin' … not yet supported in --target standalone (#1472 Phase B)`              |
| lodash   | `String.prototype.replace(...) with a RegExp … not supported in --target standalone (#1474)` |
| prettier | same #1474 diagnostic                                                                      |

Full axios standalone error list (compileProject on the lane driver, optimize 0):
62 entries, 4 hard errors + 58 host-import-leak warnings:

1. `combined-stream/lib/combined_stream.js:37:10` — `__get_builtin` (#1472 / #2863)
2. `lib/helpers/sanitizeHeaderValue.js:43:23` — RegExp `replace` (#1474)
3. `lib/core/AxiosError.js:29:1` — internal error in `redactConfig`: codegen
   invariant #2182 `liveBodies unbalanced (entry=1, exit=2)`
4. `Maximum call stack size exceeded (at src/codegen/fixups.ts:207:17)`

## Fix direction

Exempt `standalone` / `standaloneDynamic` from `blocked` the way `jsHostNative`
already is (a host-lane compile failure is not evidence about a standalone
compile), or label an inherited row explicitly (e.g. `status: "blocked-by-host"`
with the host diagnostic in `inheritedFrom`). This changes what the
CI-refreshed dashboard publishes, so it needs a lead decision; do not
hand-commit `npm-compat.json`.

## Progress (2026-09-23, [#6661](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6661-npm-compat-opaque-lane-diagnostic))

The **standalone-dynamic** half is fixed by #6661: when the JS-host gate
blocks, that lane is measured in a bounded child process
(`--perf-only --lane standalone-dynamic`, budget = the package's harness
`timeoutMs`) and reports its own error; TS8017/TS8010 timer-shim noise is no
longer chosen as a blocker anywhere. Still open here: the compile-time-static
`standalone` lane (and `jsHost`, by design) still inherit the host block.
