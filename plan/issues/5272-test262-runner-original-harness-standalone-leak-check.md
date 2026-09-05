---
id: 5272
title: "test262 runner: the in-process original-harness path (runTest262File) never applies the standalone host-import leak check — local probes disagree with the sharded lane"
status: in-review
sprint: current
created: 2026-09-01
updated: 2026-09-02
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

## 2026-09-02 implementation (Opus)

`runOriginalHarnessVariant` (`tests/test262-runner.ts`) now calls the existing
`standaloneHostImportError` right after `computeWasmSha` and **before**
`buildImports`, returning `{ pass: false, phase: "compile", detail, timing,
wasm_sha }`. No second classifier was written. `runTest262File` maps
`phase: "compile"` → `status: "compile_error"` and `classifyErrorCategory`
already maps the message → `host_import_leak`, so the record shape needed no
other change. The strict rerun goes through the same function, so step 2 is
covered; `runSyntheticTest262File` keeps its own call.

**Fixture correction to the plan.** The plan named `new Set(customIterable)` /
`new WeakMap([[k, v]])`; the for-of lane (PR #5458) has since closed both, and
`Promise.all` / `Promise.race` / `RegExp` / `Proxy` no longer leak either
(measured 2026-09-02 with the runner's own compile options — `target:
"standalone"`, `deferTopLevelInit`, `hostBridge: "always"` — all report
`imports: []`). `new SharedArrayBuffer(8)` still emits
`env::SharedArrayBuffer_new` (296 rows in the committed standalone baseline
carry exactly that leak), so it is the fixture.

**One negative-test refinement.** The check is skipped for `parse`/`early`/
`resolution` negatives. That is not leniency: the sharded worker's own
compile-phase-negative arm (`scripts/test262-worker.mjs:1788`) returns
`negativeCompileSucceededVerdict` → `status: "fail"` **before** it reaches its
leak check at `:1797`. Applying the leak check unconditionally here would have
scored those rows `compile_error` while the baseline says `fail` — a new
disagreement in the opposite direction, in the very lane this issue exists to
align. Runtime negatives are unaffected and do reach the check, exactly as in
the worker.

### Before / after — `npx tsx scripts/run-test262-paths.mts .tmp/5272.txt --standalone`

The plan's suggested probe rows (`Promise/all`, `Promise/race`) no longer leak,
so the slice is two rows the committed baseline scores `host_import_leak` plus
the `Proxy` control.

| row | before (HEAD `4ae25b8d6c`) | after |
| --- | --- | --- |
| `built-ins/SharedArrayBuffer/prototype/slice/nonconstructor.js` | **pass** (pseudo-pass — `buildImports` satisfied `env::SharedArrayBuffer_new` from the host) | `compile_error` — `standalone target emitted host imports: env::SharedArrayBuffer_new (#2961)` |
| `built-ins/Atomics/notify/bad-range.js` | `fail` — `RuntimeError: illegal cast in __module_init()` | `compile_error` — same leak message |
| `built-ins/Proxy/revocable/revoke.js` (control) | pass | pass |

Counts: `{ pass: 2, fail: 1 }` → `{ compile_error: 2, pass: 1 }`.

**JS-host lane is byte-identical before and after** (same slice without
`--standalone`, both runs executed here): `{ pass: 2, fail: 1 }`, same failure
text on `Atomics/notify/bad-range.js`. Expected — `standaloneHostImportError`
returns `undefined` unless `target === "standalone"`.

### Parity with the sharded lane (acceptance criterion 3)

`TEST262_TARGET=standalone
TEST262_PATH_FILTER="built-ins/SharedArrayBuffer/prototype/slice/nonconstructor.js"
TEST262_REPORTER=dot pnpm run test:262 --official-scope-only`, run 2026-09-02.
The wrapper exits 2 with `missing-shard-manifest: Expected 16 shard manifests
but found 1` — the documented consequence of filtering to a single row (15
shards match nothing), **not** a verdict failure. The one shard that ran wrote
`benchmarks/results/test262-standalone-results-20260902-044838.jsonl`:

```
"status":"compile_error"
"error":"standalone target emitted host imports: env::SharedArrayBuffer_new (#2961)"
"error_category":"host_import_leak"
"imports":["env::SharedArrayBuffer_new"]
```

Identical status, error text and `error_category` to what the in-process runner
now returns for that row. The committed baseline
(`.test262-cache/test262-standalone-current.jsonl`, promoted 2026-09-01 20:21)
carries the same three fields for both leaky rows, so the two lanes agreed on
this row's verdict in both a fresh run and the published artifact.

### Regression test

`tests/issue-5272-runner-standalone-leak.test.ts` — 7 tests, all pass
(`npx vitest run`, 124 s). It guards the fixture first (fails loudly with
"pick a construct that does" if `SharedArrayBuffer` ever stops leaking, so the
row assertions can never vacuate silently), then asserts `compile_error` +
`/standalone target emitted host imports/` on both leaky rows, that the same
rows are untouched on the JS-host lane, that a host-free standalone row still
passes, and that `standaloneHostImportError` is the single classifier.

### Gates

`pnpm run typecheck` exit 0. All five ratchet gates exit 0, run bare:
`check-loc-budget`, `check-func-budget`, `check-coercion-sites`,
`check:oracle-ratchet` (`no net checker-usage growth`), `check:dead-exports`
(`OK (25 known entries, 0 new)`).

### Pre-existing failures in neighbouring runner tests (NOT caused by this change)

Each was re-run on the unmodified HEAD copy of `tests/test262-runner.ts` and
fails identically there:

| file | base | with the change |
| --- | --- | --- |
| `tests/test262-runner-static-gen-yield.test.ts` | 10 pass | 10 pass |
| `tests/issue-542-negative-skip.test.ts` | 3 fail | 3 fail — stale `shouldSkip` assertions; `eval`/`with` are no longer skipped |
| `tests/issue-3369-project-runner.test.ts` | 1 fail | 1 fail — hits its own 600 s timeout; the box was at load ~12 on 4 cores |
| `tests/test262-fyi-runner.test.ts` | 8 fail / 2 pass | 8 fail / 2 pass — `Test262 worker exited before ready (code 1)`, a child-spawn failure in this container |

The last three are all host-lane or non-runner paths, so a
`target === "standalone"`-gated check cannot reach them.
