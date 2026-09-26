---
id: 6660
title: "npm-compat: standalone perf lanes inherit the JS-host package-entry compile failure, hiding their real blockers (axios #3587, lodash/prettier TS8017)"
status: done
sprint: current
created: 2026-09-23
updated: 2026-09-24
completed: 2026-09-24
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: tooling
goal: standalone
related: [3587, 1472, 1474, 2182, 2631, 1768, 2863, 6661]
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

## Implementation Plan

Lead decision (2026-09-24): the standalone lanes run their OWN compile and
report their OWN error, never the host lane's — the lanes are independent by
architecture. The JS-host lanes keep their behaviour. Scripts only; no `src/`
change.

- `scripts/lib/npm-compat-perf.mjs`: `STANDALONE_PERF_LANES` (CLI lane name →
  `perf.lanes` key) and `resolveStandalonePerfLanes({ hostBlocked, selected,
  inProcess, inChild })`. The host diagnostic is not an input: a selected
  standalone lane is always measured — in process, or through the bounded
  child when the host gate blocked; an unselected lane is `skipped`.
- `scripts/generate-npm-compat-report.mjs`:
  - `standaloneDynamicLaneInChild` → `standaloneLaneInChild(name, lane,
    budgetMs)`, serving both `standalone-static` and `standalone-dynamic`
    (`--only <pkg> --perf-only --lane <lane> --partial-output`, budget = the
    package's harness `timeoutMs`, default 120 s).
  - `perfNpmCompatPackage`: `blocked?.standalone ?? runStatic()` is gone; both
    standalone lanes come from `resolveStandalonePerfLanes`. `jsHost` still
    shows the host-gate block (`packageEntryBlockReason`), `jsHostNative` still
    runs its own compile — both byte-for-byte as before.
  - Native (oracle) import failure no longer returns early for every lane: the
    JS-host lanes still report `native package import failed: …` (unchanged),
    but a standalone lane compiles first and, if it compiles, reports
    `status: "oracle-unavailable"` with its binary size — so a harness catalog
    gap (#6661's jest `Cannot find module 'jest-config'`) can no longer mask a
    standalone compile status. The dashboard renders unknown statuses as "could
    not be measured".
- Regression test `tests/issue-6660-npm-compat-standalone-lane-independence.test.ts`.

## Resolution

Measured locally 2026-09-24 on upstream/main d772cc772d + this change.
"Before" = the committed `benchmarks/results/npm-compat.json` (CI refresh of
2026-09-14; the refresh has not promoted since) and the pre-change code path
(`blocked?.standalone`), which copies the host diagnostic by construction.

End-to-end (full mode, host gate actually blocked): `--only axios --no-write`
(691 s): `jsHost` = `JS-host package-entry compile failed: async shape not
supported … (#3587)` (unchanged), `jsHostNative` = the #3587 refusal from its
own compile (unchanged), and **both** standalone lanes were measured in the
bounded child and show their own `__get_builtin` refusal.

Per-lane (`--perf-only --lane standalone-static|standalone-dynamic`; static /
dynamic gave identical first diagnostics):

| package | standalone lanes before | standalone lanes after (verbatim) |
| --- | --- | --- |
| axios | `async shape not supported: … (#3587)` (host) | `Codegen error: '__get_builtin' (dynamic-shape object/property operation) is not yet supported in --target standalone (#1472 Phase B). Use a typed object literal or class instance for fast-path codegen, which compiles to struct.get/struct.set with no JS host imports.` |
| lodash | `Signature declarations can only be used in TypeScript files.` (host noise) | `Codegen error: String.prototype.split(...) with a RegExp or symbol-protocol search value is not supported in --target standalone (#1474). Use a supported backend-created static RegExp or native string-only overload, or recompile without --target standalone.` |
| prettier | `Signature declarations can only be used in TypeScript files.` (host noise) | same `String.prototype.split(...)` #1474 refusal as lodash |
| jest | `native package import failed: Cannot find module 'jest-config'` (catalog gap) | runtime-error, phase `module-init`: `uncaught Wasm-GC exception (non-stringifiable payload): raised by compiler-generated code (the module has no source throw, so no __exn_render_* exports; see #6666)` |

Notes:

- lodash/prettier's `replace` refusal recorded in #6661 is gone on this main
  (GitHub PR 6054, branch `issue-replace-regexp-standalone`, landed standalone
  RegExp `replace`); the next #1474 site is `split`.
- jest now compiles in both standalone lanes (the #6661 hoist fallback fixes the
  native import locally); its module-init throw is #6666 (`require is not
  defined`). Should the native import ever fail again in CI, the standalone
  lanes will read `oracle-unavailable` with their compiled size rather than
  the catalog gap.
- Cost: a host-blocked package now runs two bounded standalone children
  instead of one (axios ≈ 2 × 80–120 s here under load); each is capped by the
  package's harness budget.
- Controls: no `src/` change, so standalone test262 and the JS-host dogfood
  suites are unaffected by construction (not re-run). The regression test
  fails on the parent (3 of 4; `resolveStandalonePerfLanes` missing, generator
  still has `blocked?.standalone`) and passes with the fix (4 of 4).
