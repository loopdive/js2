---
id: 6661
title: "npm-compat standalone-dynamic lane: 10 packages showed an opaque or wrong reason ('package entry did not produce a runnable Wasm module', 'Cannot find module jest-config', 'Signature declarations can only be used in TypeScript files')"
status: done
sprint: current
created: 2026-09-23
updated: 2026-09-23
completed: 2026-09-23
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
related: [1058, 3494, 4043, 4287, 5384, 6665, 6666, 6667]
---

# #6661 — make every npm-compat standalone-dynamic status name its real cause

## Problem

`benchmarks/results/npm-compat.json` → `packages[].perf.lanes.standaloneDynamic`
carried three kinds of non-answers:

1. **`package entry did not produce a runnable Wasm module`** — typescript,
   eslint, react-dom, tailwindcss, jsdom, webpack, lodash-es, three, stylelint.
   `reportCompileDiagnostic` in `scripts/generate-npm-compat-report.mjs` read
   `compile.error`, `compile.errors[0]`, `compile.diagnostics[0]` and
   `validation.error` — but the package-entry harness report has none of those
   when the compile TIMED OUT (it has `compile.timedOut` and
   `validation.firstError`). Eight of the nine were JS-host budget timeouts;
   react-dom's report failed with no `errors[]`. Worse, the standalone lanes
   were never run at all: any JS-host package-entry failure copied that
   failure onto the standalone lanes.
2. **`Signature declarations can only be used in TypeScript files.`** — lodash,
   prettier. No `.js` file is parsed through a TS-only path by the harness:
   the JS-host graph compiler prepends a typed timer shim
   (`injectTimerShimOnly`, `declare function __timer_set_timeout(…)`) to every
   `.js` file that calls `setTimeout`, and TypeScript reports TS8017/TS8010 on
   it. Under `allowJs` those are **non-fatal** (compileProject ignores them), but
   the report named `errors[0]`, i.e. the noise. lodash really failed on a
   `stack-balance invariant` codegen error; prettier compiled and then failed
   WebAssembly validation.
3. **`native package import failed: Cannot find module 'jest-config'`** — jest's
   `build/index.js` `require`s `jest-config`, which it does not declare. The
   installed copy finds it through pnpm's hoist directory
   (`node_modules/.pnpm/node_modules`); the extracted tarball under
   `tests/dogfood/.npm-compat/jest/` only had its importer directory linked, so
   the native (oracle) import failed in CI before any lane ran.

## Implementation Plan

- `tests/dogfood/package-entry-harness.mjs`: new `packageEntryBlockReason(report)`
  (replaces the generator's `reportCompileDiagnostic`) that names the gate and
  the real reason: budget overrun, first non-noise compile error, or the
  validation error. `isJsGrammarNoiseDiagnostic` filters TS8xxx "can only be
  used in TypeScript files"; the harness's own `blockedReason` / category
  sample use it too.
- `scripts/generate-npm-compat-report.mjs`: when the JS-host gate blocks a
  package, the standalone-dynamic lane is no longer copied from it — it is
  measured in a bounded child process (`--only <pkg> --perf-only --lane
  standalone-dynamic --partial-output`, budget = the package's harness
  `timeoutMs`), so the lane reports its own error or its own budget overrun.
  `firstCompileDiagnostic` skips the TS8xxx noise as well.
- `tests/dogfood/npm-compat-catalog.mjs`: `wirePnpmHoistFallback` links
  `tests/dogfood/.npm-compat/node_modules` → `.pnpm/node_modules`, the next
  directory Node probes after `.npm-compat/<pkg>/node_modules` — the installed
  package's exact resolution order. Only a link this helper created is ever
  replaced; flat npm trees are left alone.
- Module-init throws in the generic lane that the module cannot render (no
  `__exn_render_*` exports ⇒ no source `throw`) are labelled as raised by
  compiler-generated code (`renderModuleInitThrow`); the shared test262
  renderer is untouched.
- Regression test `tests/issue-6661-npm-compat-opaque-lane-diagnostic.test.ts`.

## Resolution

Standalone-dynamic lane, before → after (after = measured locally 2026-09-23 on
this branch with `--perf-only --lane standalone-dynamic`, 1500 s cap; the
full-mode path was verified end-to-end on stylelint):

| package | before | after |
| --- | --- | --- |
| typescript | opaque | standalone compile > 1500 s (budget overrun, #1058) |
| webpack | opaque | standalone compile > 1500 s (budget overrun, #4287) |
| eslint | opaque | `Standalone dynamic import is unsupported…` (#3494) |
| jsdom | opaque | `Standalone dynamic import is unsupported…` (#3494) |
| stylelint | opaque | `Standalone dynamic import is unsupported…` (#3494) |
| tailwindcss | opaque | `'__get_builtin' (dynamic-shape …) is not yet supported` (#4043; also #680 generators, #2717 flatMap) |
| three | opaque | `JSON.stringify of this value is not yet supported by the native JSON provider` ([#6667](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6667-standalone-three-json-stringify-refusal)) |
| lodash-es | opaque | `String.prototype.match(...) with a RegExp … value` ([#6665](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6665-standalone-string-methods-dynamic-regexp-value)) |
| react-dom | opaque | runtime-error at module-init: `ReferenceError: require is not defined` ([#6666](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6666-standalone-nested-cjs-require-reference-error)) |
| jest | `Cannot find module 'jest-config'` | runtime-error at module-init: `…non-stringifiable payload): raised by compiler-generated code (…; see #6666)` — the throw is `ReferenceError: require is not defined` (decoded from the WAT, #6666) |
| lodash | `Signature declarations…` (noise) | `String.prototype.replace(...) with a RegExp … value` (#6665) |
| prettier | `Signature declarations…` (noise) | `String.prototype.replace(...) with a RegExp … value` (#6665) |

In CI (full mode) typescript/webpack will read `standalone-dynamic lane
exceeded the <timeoutMs>ms harness budget (compile-budget)` — the child is
bounded by the package's own harness budget (600 s / 120 s). The same holds
for any blocked package whose standalone compile outruns that budget on the
CI runner (locally, under load average ~60, lodash-es reached its refusal in
304 s against a 120 s budget and three in 256 s against 180 s) — the lane
then names the overrun, which is still the real, actionable reason.
