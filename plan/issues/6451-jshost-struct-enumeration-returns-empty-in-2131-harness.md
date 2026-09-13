---
id: 6451
title: "JS-host `Object.keys`/`values`/`entries`/`for-in` return nothing in the #2131 harness — 6 of 7 rows regressed on main"
status: done
sprint: current
created: 2026-09-13
updated: 2026-09-13
completed: 2026-09-13
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

`tests/issue-2131.test.ts` passes **1 of 7** on `upstream/main` `3e92241ecc`.
The six JS-host rows do not merely mis-*order* keys — the enumeration comes back
**empty**:

| row | expected | actual on main |
| --- | --- | --- |
| `Object.keys` puts array-index keys first, ascending | `1,2,b,a` | `""` |
| `for-in` visits keys in the same order | `1,2,b,a,` | `""` |
| `Object.values` follows the spec key order | `4,2,1,3` | `""` |
| `Object.entries` follows the spec key order | `12ba` | `NaN` |
| pure string-key objects keep insertion order | `b,a,c` | `""` |
| non-canonical numeric-looking keys are NOT reordered | `b,01,a` | `""` |
| standalone keeps integer-key-first order (#3155) | — | ✓ passes |

Only the **standalone** row survives, which localises this to the **JS-host**
enumeration path, not to `_orderOwnKeysSpec` or the standalone twin.

Measured 2026-09-13 while landing
[#6426](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6426-object-assign-option-bag-across-linked-package):
identical counts with #6426's change applied and with it reverted, so it is
neither caused nor masked by that fix.

[#2131](https://js2wasm.loopdive.com/dashboard/issue.html?slug=2131-jshost-enum-order-ignores-integer-key-ascending)
is `done` and its Resolution records `7/7`, so this is an untracked regression
some later change introduced.

## Why it is not already obvious

Every dogfood suite is green on the same HEAD and several of them (redux's
`finalReducers[key]`, React's dynamically assembled props — see the #4298 note
in `src/runtime.ts`) depend on exactly this round trip. So either

- the regression is specific to how **this test's harness** drives the runtime
  (it calls `buildImports` from `src/runtime.js` directly rather than going
  through `compile`'s own import object), which would make it a stale-harness
  defect rather than a compiler one, **or**
- the dogfood suites never exercise the shape this test uses.

Deciding which of those is true is the first job, because they have opposite
consequences: the first is a test-only fix, the second is a real user-visible
enumeration hole that nothing else in the corpus covers.

## Acceptance criteria

1. Name which of the two explanations above is correct, with a probe that
   distinguishes them (same source compiled through `compile` end-to-end vs
   through the test's `buildImports` harness).
2. If the compiler is at fault: the six rows answer as node does, and a dogfood
   A/B over the 17 suites is reported.
3. If the harness is at fault: the harness is repaired so the rows exercise the
   real import object, and the test is green — a test that cannot fail for the
   right reason is worse than no test.
4. Bisect to the commit that moved it, and record that sha here either way.

## Notes

- `tests/issue-2131.test.ts:88` is the last of the six; `:35`, `:47`, `:57`,
  `:68`, `:78` are the others.
- `Object.entries` answering `NaN` rather than `""` is the sharpest clue: that
  row builds a string by concatenation over the entries, so an empty entry list
  plus a numeric seed produces `NaN`. Consistent with "the list is empty",
  inconsistent with "the list is mis-ordered".

## Implementation Plan

**Diagnosis (measured 2026-09-13 on upstream/main 54c36a9fe3): explanation 1 — the harness is stale, the compiler is right.** One compile of the row-1 source, four instantiations: `buildImports`+`setExports` → `""`; `r.importObject` with no `__setInstance` → `""`; `buildImports`+`setInstance(instance)` → `"1,2,b,a"`; `r.importObject`+`__setInstance` → `"1,2,b,a"`.

**Responsible arm.** `src/runtime.ts` `_hostBridgeExportView` (~L1573) masks the `_DATA_STRUCT_HOST_BRIDGE_EXPORTS` (`__is_data_struct`, `__struct_field_names`, ~L1280) unless `_dataStructHostBridgeMetadata` establishes authority, and `src/runtime/instance-lifecycle-adapter.ts` passes `mayEstablishInstanceAuthority=false` for `setExports` and `true` only for `setInstance` (branded instance). With the names masked, `_getStructFieldNames` returns `null`, so the `__object_keys`/`__object_values`/`__object_entries` arms (~L13767+) and for-in's `fieldNamesForHost` (~L8525) fall through to `Object.keys(opaqueStruct)` = `[]`. That is deliberate fail-closed forgery defence, not a bug — keep it.

**Bisect (criterion 4): `708ebbd56d` "feat(codegen): authenticate data-struct host bridges" (2026-07-30).** Confirmed by running `tests/issue-2131.test.ts` against `git archive`d `src/` at parent `ec58ea778e` (7/7) and at `708ebbd56d` (1/7). That commit migrated `tests/issue-forin.test.ts` to `setInstance` but missed the other local harnesses.

**Why dogfood is green:** `tests/helpers/compile-project-run-probe.mjs:36` and `src/linked-provider-runtime.ts:213/289` call `__setInstance`; the shared helpers in `tests/helpers/compile.ts` (`compileAndRunTestSyncSetExports`, `compileAndRunInstance`, …) already call `setInstance`. Only hand-rolled per-file harnesses still call `setExports`.

**Fix (test-only):**
1. `tests/issue-2131.test.ts` `run()`: replace `imports.setExports?.(instance.exports)` with `imports.setInstance?.(instance)`. Expect 7/7.
2. Sweep the same-mechanism collateral. On this HEAD the 41 `setExports`-only test files that enumerate (`grep -l setExports tests/*.test.ts | xargs grep -L setInstance | xargs grep -l 'Object.keys\|for (const .* in \|Object.entries\|Object.values'`) include confirmed same-symptom failures: `tests/issue-1243.test.ts:26` (10 rows, `''`/`0` enumeration) and `tests/issue-2849.test.ts:42` (5 rows, sidecar read `undefined`). Apply the same one-line change; re-run each file. Run in batches of ≤10 files — all 41 in one vitest call OOMed the worker at 8 GB.
3. Triage the remaining red files in that set (issue-2742, 3214, 3486, 3643, 1462, 2138, 2785, 2792 showed 1–2 failures each in the partial run): flip to `setInstance`, keep only the ones that turn green; list the ones that stay red in the issue as out of scope. Known NOT this mechanism, do not touch: `issue-1277` (export-name mapping), `issue-2900` (module-init census).
4. Do NOT add a fallback in `_hostBridgeExportView` for `setExports`; `tests/issue-3520-data-struct-host-bridge-abi.test.ts` / `issue-3520-runtime-consumer-wiring.test.ts` assert the fail-closed behaviour and are the anti-vacuity control for this change. Leave the `setExports` docstring at `src/runtime.ts:~18936` ("prefer setInstance") as is; optionally add one sentence: struct enumeration requires `setInstance`.

**Regression-test shape:** no new two-file `.js` fixture — the compiler emits correct output; the fixture-lane already exercises this via `__setInstance`. The repaired 2131 file is the test: it fails on this HEAD with `setExports` (`''`) and passes with `setInstance`; removing the line re-fails it (control measured above).

**Expected movement:** dogfood anchors unchanged (webpack 16/16 · three 17/18 · … · hono ~261/324) — the runners never used `setExports`. Standalone lane: no change; row 7 already passes and standalone has no host imports. Unit suite: +6 (2131), +10 (1243), +5 (2849), plus whatever step 3 recovers.

**Order/constraints:** one PR, tests only (no `src/` edits), so no ratchet gates move; `SKIP_SLOW_PRECOMMIT=1` is fine. Set `status: done`, record the bisect sha and the four-way probe numbers in the issue Resolution.

## Dispatch

**sonnet** — a mechanical `setExports → setInstance` harness sweep with a per-file green/red check; the diagnosis and bisect are already done and no compiler judgement is needed.

## Resolution

Confirmed explanation 1: the harness was stale, not the compiler. Bisected to
`708ebbd56d` "feat(codegen): authenticate data-struct host bridges"
(2026-07-30), which migrated `tests/issue-forin.test.ts` to `setInstance` but
missed every other hand-rolled harness. `tests/issue-2131.test.ts` now 7/7
(was 1/7) after `run()` calls `imports.setInstance?.(instance)` instead of
`imports.setExports?.(instance.exports)`.

Swept the same-mechanism collateral (41 candidate files via
`grep -l setExports tests/*.test.ts | xargs grep -L setInstance | xargs grep -l 'Object.keys\|for (const .* in \|Object.entries\|Object.values'`,
run in batches of ≤10 to avoid the 8GB OOM). 19 files total (including 2131)
flipped `setExports`/`__setExports` → `setInstance`/`__setInstance` and turned
fully or partially green with no other change:

| file | before | after |
| --- | --- | --- |
| issue-2131.test.ts | 1/7 | 7/7 |
| issue-1243.test.ts | 11/21 | 21/21 |
| issue-2849.test.ts | 6/11 | 11/11 |
| issue-1462.test.ts | 14/15 | 15/15 |
| issue-2138.test.ts | 6/7 | 7/7 |
| issue-2742.test.ts | 13/15 | 15/15 |
| issue-2792.test.ts | 13/14 | 14/14 |
| issue-3486-fnctor-constructor-identity.test.ts | 5/6 | 6/6 |
| issue-3643-array-dstr-getiterator.test.ts | 13/14 | 14/14 |
| issue-1613.test.ts | 2/7 | 7/7 |
| issue-1629-S1.test.ts | 3/7 | 7/7 |
| issue-1830.test.ts | 1/3 | 3/3 |
| issue-2066.test.ts | 0/6 | 6/6 |
| issue-2179.test.ts | 4/10 | 10/10 |
| issue-2739.test.ts | 1/6 | 6/6 |
| issue-2747.test.ts | 2/8 | 7/8 (1 pre-existing unrelated failure remains, see below) |
| issue-2805-init-time-any-receiver-write.test.ts | 2/3 | 3/3 |
| issue-797-batch1.test.ts | 5/11 | 6/11 (5 pre-existing unrelated failures remain, see below) |
| issue-2785.test.ts | 18/20 | 19/20 (1 pre-existing unrelated failure remains, see below) |

Total: +58 tests fixed across the 18 collateral files, +6 on 2131 itself = **+64 tests** net.

**Reverted, no net change:** `issue-2746.test.ts` — switching it to `setInstance`
turned the M2 test's `Object.keys(new Date(0))` count from 2 (correct) to 3
(a real Date-struct field leaking into enumeration once the host bridge is
authenticated for this shape), regressing a previously-passing test. Left on
`setExports`; its pre-existing, unrelated M1 (`arr.hasOwnProperty`) failure is
unchanged either way. This Date-struct leak is a separate, real bug — flagged
as a new issue below rather than fixed here (out of this issue's scope, and
the plan's anti-vacuity control (#3520 tests) forbids papering over it with a
`setExports` fallback in `_hostBridgeExportView`).

**Confirmed NOT this mechanism** (per plan) — untouched: `issue-1277.test.ts`
(export-name mapping), `issue-2900.test.ts` (module-init census, OOMs
independent of this change).

**Out of scope — same grep hit, different unrelated pre-existing bug, left on
`setExports`/untouched:**
- `issue-2166-objvec-element-index.test.ts` — target is `standalone`, no host
  imports exist; `__setExports` was already a no-op, failure is a real
  standalone positional-index bug, unrelated.
- `issue-3186.test.ts` — failing row is array **element** access (`a[k]`), not
  Object.keys/values/entries/for-in; unrelated numeric read bug.
- `issue-2856-extern-in-ir.test.ts` — OOMs even run alone with 12GB heap;
  pre-existing infra issue, independent of the setExports/setInstance choice.
- `issue-3491-test262-fyi-module-fixtures.test.ts` — fails inside
  `scripts/test262-fyi-reader.mjs` `loadOriginalHarnessTests`, a fixture/
  submodule loading path unrelated to struct enumeration.
- `issue-854-smoke.test.ts` — one failure is a missing test262 fixture file
  (`SKIP: file not found`), the other is `Symbol.iterator` resolution via
  `__extern_get`, not struct-field enumeration.
- `issue-2747.test.ts` "walks a multi-level `__proto__` chain" — pre-existing
  prototype-chain-depth bug, unaffected by the setInstance switch (same
  failure before/after with a partially-improved-but-still-wrong string).
- `issue-797-batch1.test.ts` WI2/WI4 (5 tests) — pre-existing compile-time
  enumerability-flag bug (`Object.keys` still returns 3 fields instead of 2
  after `defineProperty(..., {enumerable:false})`), unaffected by the switch.
- `issue-2785.test.ts` "map-on-array-like" — pre-existing, identical
  `TypeError: object is not a function` before and after.
- `issue-3214-void-host-callback.test.ts` "rejects non-void before the IR
  claim" — pre-existing IR-claim rejection-list bug, unrelated to enumeration.

Gates: `check-loc-budget`, `check-func-budget`, `check-coercion-sites`,
`check:oracle-ratchet`, `check:dead-exports`, `check:dogfood-validation`,
`check:host-import-policy` all green (0 changed `src/` files). `tsc --noEmit`
clean. `check:compiler-boundaries` reports pre-existing
`inventory-valid-architecture-incomplete` (exit 1) identical to `upstream/main`
HEAD `9760680f22` — no `src/` change in this PR, not a regression.

No `src/` change → no dogfood A/B needed (the 17 upstream-package suites never
used `setExports`; confirmed by the green `check:dogfood-validation` run
above, itself unaffected by these test-file edits).

New issues filed for the out-of-scope findings above:
[#6471](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6471-jshost-date-struct-leaks-internal-field-into-enumeration)
(Date-struct field leak once the host bridge is authenticated) and
[#6472](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6472-jshost-defineproperty-enumerable-false-not-honored-by-object-keys)
(`defineProperty(..., {enumerable:false})` ignored by `Object.keys`/`values`/`entries`/`propertyIsEnumerable`).
