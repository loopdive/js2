---
id: 6451
title: "JS-host `Object.keys`/`values`/`entries`/`for-in` return nothing in the #2131 harness — 6 of 7 rows regressed on main"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
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
