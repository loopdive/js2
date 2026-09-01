---
id: 5272
title: "test262 runner: the in-process original-harness path (runTest262File) never applies the standalone host-import leak check — local probes disagree with the sharded lane"
status: ready
sprint: current
created: 2026-09-01
updated: 2026-09-01
priority: high
horizon: s
feasibility: easy
task_type: bug
area: test262-runner
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-es6
related: [2961, 4444, 5267]
---

# #5272 — `runTest262File` skips the standalone leak check on the original-harness path

## Problem

Two runner paths score the same standalone row differently:

| Path | Used by | Leaked `env::*` import on `--target standalone` |
| --- | --- | --- |
| `scripts/test262-worker.mjs` (sharded lane; CI + `pnpm run test:262`) | the published baseline | scored `compile_error` / `host_import_leak` — `scripts/test262-worker.mjs:1801` (`standalone target emitted host imports: … (#2961)`), with the explicit note at `:1795` "Do not satisfy leaked imports through buildImports" |
| `tests/test262-runner.ts` `runTest262File` → `runOriginalHarnessVariant` (in-process; `scripts/run-test262-paths.mts`, `tests/test262.test.ts`, `scripts/test262-worker-esm.mjs`) | every local probe agents use to measure a slice before/after | **no check.** `standaloneHostImportError` (`tests/test262-runner.ts:3700`) is called only from the legacy `runSyntheticTest262File` (`:4944`). The original-harness path builds `buildImports(result.imports, …)` (`:4450`) and instantiates through `instantiateTest262Module` (`scripts/test262-import-object.mjs:175`), whose `standalone` branch only attaches conditional namespaces — it does not reject `env::` imports either. |

Consequence (measured by the #5267 planning pass on 2026-09-01, HEAD
`0d9bfedee`): `new Set(customIterable)` / `new WeakMap([[k, v]])` compiled with
`compile(src, { target: "standalone" })` still emit `env::Set_new` /
`env::WeakMap_new`. The sharded baseline scores those 14 constructor rows as
`host_import_leak` compile errors. The local probe instead satisfies the import
from the JS host and reports whatever the test then does — here a V8-text
`TypeError` at `__module_init`, in other shapes a **pass**. So a slice can look
fixed (or differently broken) locally while CI still counts the leak, and a
"before/after" measured with `run-test262-paths.mts --standalone` is not the
number the merge_group will see.

## Implementation Plan

1. In `runOriginalHarnessVariant` (`tests/test262-runner.ts`, after the
   `result.success`/severity check at ~`:4404` and before `buildImports` at
   ~`:4450`): call `standaloneHostImportError(target, result.imports)`; when it
   returns a message, return `{ pass: false, phase: "compile", detail: message,
   timing: timing(), wasm_sha }` exactly like the compile-failure arm above it.
   `runTest262File` already maps `phase: "compile"` to `status: "compile_error"`
   (`:4620`), and `classifyErrorCategory` (`:5300`) already maps the message to
   `host_import_leak`, so the record shape matches the sharded lane without
   further change. Negative tests: keep the existing negative handling — a
   leak is never a valid negative-test outcome, so do not route it through
   `negativeCompileErrorMatches`.
2. Apply the same call in the strict rerun (it goes through the same function,
   so step 1 covers it) and confirm `runSyntheticTest262File` keeps its call.
3. Regression test `tests/issue-5272-runner-standalone-leak.test.ts`: compile a
   tiny program that is KNOWN to leak on standalone today (use
   `new WeakMap([[{}, 1]])` until #5267 Step A lands; then switch the fixture to
   a synthetic leak via a deliberately host-only construct, or stub
   `result.imports`) and assert `runTest262File(…, "standalone")` returns
   `status: "compile_error"` with `error` matching
   `/standalone target emitted host imports/`. Add a control that a host-free
   program still passes. Mark the fixture choice in the test so it is updated
   when the leak closes.
4. Re-measure one leaky row through both paths (`scripts/run-test262-paths.mts
   --standalone` vs a single-row `TEST262_TARGET=standalone TEST262_PATH_FILTER=…
   pnpm run test:262`) and record identical status + error_category in this
   file.

## What NOT to do

- Do not weaken the sharded worker's check, and do not satisfy leaked imports
  from the host "to see further" — the leak IS the verdict (#2961).
- Do not touch `HANGING_TESTS`, skip lists, or baselines.

## Acceptance criteria

- `runTest262File(file, cat, ms, "standalone")` returns
  `status: "compile_error"`, `error_category: "host_import_leak"` for any row
  whose compiled module imports an `env::` symbol; host mode is unchanged.
- The regression test above passes in both lanes; the equivalence gate and
  the five ratchet gates stay green.
- One leaky row measured through both paths yields the same status and
  error category (recorded here).

## References

- #2961 (strict leak scan for `--target standalone`), #4444 (ES2015 umbrella),
  #5267 (planning pass that surfaced the gap; its Step A closes the
  `Set_new`/`WeakMap_new` leaks themselves).
