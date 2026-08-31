---
id: 5225
title: "Consumer-module object literals are opaque to a linked provider — Temporal.PlainDate.from({year,month,day}) throws 'year is required' while string and host-object forms work"
status: in-progress
assignee: ttraenkler/dev-5225
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-30
loc-budget-allow:
  # 2026-08-31 (#5225): STRANDED-GRANT RESTATEMENT, not new growth of this PR.
  # src/codegen/context/types.ts is +7 over main's current ceiling because of
  # #5223, whose grant lives in that issue's own file — a file this
  # predecessor-stacked branch does not modify, so the gate cannot see it
  # (CLAUDE.md "Simulate CI's base too" → stranded grants). Restated here so
  # the #5225 PR, which inherits #5223 through the #5241..#5244 chain, is not
  # blocked by a predecessor's already-justified growth.
  - src/codegen/context/types.ts
func-budget-allow:
  # 2026-08-31 (#5225): same stranded-grant restatement, function ratchet side.
  # createCodegenContext is +1 from #5223's accessor-read demand-set wiring.
  - src/codegen/context/create-context.ts::createCodegenContext
  # 2026-08-31 (#5225): REAL growth of this change, +6 — one line of code and
  # the paragraph that says why the retarget has to happen HERE, above the
  # identity cache and the export slot, rather than at any later trap. The
  # mechanism itself lives in the new subsystem module
  # src/runtime/cross-module-struct-owners.ts, not in the god-file.
  - src/runtime.ts::_wrapForHost
---

# #5225 — provider seam: consumer struct opaque to provider module

## Problem

Through the #4628 compile-once linked provider,
`Temporal.PlainDate.from("2020-03-04")` and `.from(<host object>)` both work
(after #5221/PR #5334), but `.from({ year: 2020, month: 3, day: 4 })` — an
object literal built **in the consumer module** — throws
`RangeError: year is required`. The consumer's WasmGC struct crosses the #2527
linker seam as an opaque value the provider module cannot read properties
from, so the polyfill's field extraction sees no `year`.

This is the inbound twin of #5222 (PR #5324): #5222 made provider→consumer
values module-aware at the exit boundary; this is consumer→provider — a value
minted by module A, read by module B's `__extern_get`-equivalent path.

## Direction

Reduce with a non-Temporal linked pair: provider function
`f(o) { return o.x }`, consumer passes `{ x: 7 }`. Likely the same
module-aware mirror machinery from #5324 needs to run on the **argument**
path: when a consumer value enters a registered linked provider, wrap it as a
host mirror against the consumer's exports instead of handing over the raw
struct.

## Acceptance criteria

1. Non-Temporal reduction: provider reads consumer-literal properties
   correctly; new `tests/issue-5225-*.test.ts` failing on base (linked lane),
   single-module control passing on base.
2. `Temporal.PlainDate.from({year,month,day})` works through the provider;
   flip the corresponding knownGap/reported row in
   `tests/dogfood/temporal-global-harness.mjs` / issue-4628 tests.
3. No regressions: issue-5222/4628 test files + #2527 linker family. Gates
   green.

## Notes

- Found by dev-5221 validating PR #5334 (its PR body reports this defect
  explicitly rather than claiming it fixed). Same family as #5222.
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-30.

## Root cause — the general rule

**Not an argument-marshalling gap, and not fixable by wrapping at the seam.
The runtime resolved a struct's DECODER from the module that was RUNNING
instead of the module that MINTED it.**

A raw WasmGC struct carries no decoder. Everything that reads one —
`__struct_field_names`, `__sget_<field>`, `__shas_<field>` — is an **export of
one specific module**, and every read path in `src/runtime.ts` resolved them
from `callbackState.getExports()`, i.e. from whichever module's host imports
were currently executing. That is correct for a single module and wrong the
moment two linked modules exchange values.

Reduced with a throwaway npm package (`tests/issue-5225-consumer-literal-seam.test.ts`,
no Temporal anywhere): provider `f(o) { return o.x }`, consumer passes
`{ x: 7, y: 2 }`. Measured with `linkPlan.mode === "separate"` against the same
source compiled as one module:

| probe                                       | linked (base)               | single-module (base) |
| ------------------------------------------- | --------------------------- | -------------------- |
| `readX(o)` → `o.x`                          | `undefined`                 | `7`                  |
| `typeofX(o)`                                | `"undefined"`               | `"number"`           |
| `sumXY(o)`                                  | `NaN`                       | `9`                  |
| `keysOf(o)` (`getOwnPropertyNames`)         | `""`                        | `"x,y"`              |
| `readNested(o)` → `o.inner.z`               | `undefined`                 | `5`                  |
| `callM(o)` → `o.m()`                        | threw `m is not a function` | `11`                 |
| `hasX(o)` → `"x" in o`                      | `0`                         | `1`                  |

Two distinct failure shapes, and the second one is why "wrap the argument at
the boundary" is not the fix:

1. **Nothing decodes it.** The provider has no `__struct_field_names` for a
   shape it never constructs, so the object reads as empty — the
   `year is required` symptom.
2. **The WRONG module decodes it, silently.** Once the field-name list is
   borrowed from the owner but the getter is not, a reader whose own shapes
   reuse the field name (`day`, `month`, `days` are everywhere in the Temporal
   polyfill) reports the field PRESENT and serves its own `__sget_`'s
   `ref.test`-miss **default — 0**. That reads as a real value: the polyfill
   moved from `year is required` to
   `Cannot convert a number less than one to a positive integer`, and
   `Duration.from({days: 1})` answered `"PT0S"`. Names, presence bit and getter
   must come from the SAME module or the answer is a plausible zero.

Two seams reach this, not one, which is why a fix at either seam alone would
have looked complete and shipped half the defect:

- a **statically imported provider function** is a direct wasm→wasm call, with
  no JS in between to interpose on (the reduction above);
- a **method on a provider mirror** (`Temporal.PlainDate.from(o)`) goes through
  the consumer's `__extern_method_call`, which already wraps the argument into a
  consumer-owned mirror — and the polyfill still reached the raw struct through
  `_safeGet` further in.

## Fix

New `src/runtime/cross-module-struct-owners.ts` + small edits in
`src/runtime.ts`, `src/linked-provider-runtime.ts`, `src/index.ts`.

- A registry of the export objects taking part in **one linked project**:
  every provider (`instantiateLinkedProviders`, unconditionally — a provider
  whose whole surface is plain functions never reaches
  `wrapLinkedProviderValue`) plus the consumer (`wireCompiledInstance`, only
  when providers exist).
- `decoderFor(value, localExports)` answers which module can name the struct,
  caching the result per value — **including the negative**, so a plain host
  object is probed once rather than on every read.
- `_decoderExportsFor` / `_crossModuleCallbackState` apply it at the top of the
  read paths: `_structFieldNamesRaw`, `_getStructFieldNames`,
  `_structOwnFieldStatus`, `_wasmStructHasOwn`, `_safeGet`, `_wrapForHost`, and
  both `extern_get` bindings (the by-name one and the intent one — they are
  separate implementations of the same read).

Deliberately narrow on the hot path (#3903, `__extern_get` ~10k per `run()` on
`mixed/csv-parse`): with fewer than two modules registered the whole mechanism
is **one boolean**, so the single-module lane is byte-identical. In a linked
project it is a cached `WeakMap.get` on a path that already pays a Wasm call.

**Rejected alternative:** interposing a JS wrapper on each provider export so
arguments could be mirrored at the seam. It converts every consumer→provider
call from a direct wasm→wasm call into a JS hop, and it does not fix reads of a
struct that reaches the provider by any other route — which the `_safeGet`
finding above proves happens.

## Result

`Temporal.PlainDate.from({ year: 2020, month: 3, day: 4 })` answers
`"2020-03-04"`. The whole object-argument family moved (fresh
`JS2WASM_TEMPORAL_CACHE`, `cacheHit=false`, both sides, 2026-08-31):

| row                     | base                                | after        |
| ----------------------- | ----------------------------------- | ------------ |
| `staticFromObject`      | `TypeError: year is required`       | `2020-03-04` |
| `durationFromObject`    | `TypeError: invalid duration-like`  | `P1D`        |
| `arithmeticAddDuration` | `WebAssembly.Exception`             | `2020-03-05` |
| `arithmeticSubtract`    | `WebAssembly.Exception`             | `2020-03-03` |
| `arithmeticWith`        | `WebAssembly.Exception`             | `2021-03-04` |
| `staticFromString` ctl  | `2020-03-04`                        | unchanged    |
| `arithmeticAddString` ctl | `2020-03-05`                      | unchanged    |
| `nowKeys` ctl           | full key list                       | unchanged    |

Partial-object controls now answer the SPEC's errors rather than a seam
failure: `from({year, month})` → `day is required`, `from({month, day})` →
`year is required`, `from({year, day})` → `Either month or monthCode are
required`.

Two rows #5242 had **pinned as a known asymmetry** are fixed by the same
mechanism, which is the strongest evidence it is the general one: an instance
built by a plain `new K(…)` inside the provider and crossed to the consumer as
a raw struct now reads its getters (`directGetter` `undefined` → `21`) and
dispatches its methods (`directLabel` threw `label is not a function` →
`K1|2|3|4|5|6`).

**Not fixed here, with the control that says why:**

- `directToString` / `instanceToStringTag` still answer `"[object Object]"`.
  `Symbol.toStringTag` on a compiled class instance is unwired; reproduced on a
  **plain user class in one module** (#5223's note), so not a seam defect.
- `nowPlainDateISOCall` and `nowTimeZoneIdCall` are unchanged. Both are
  `RuntimeError: dereferencing a null pointer`; the first throws **identically
  single-module** (#5221's lane), the second is linking-specific but lives in
  what `timeZoneId` REACHES (the host `Intl.DateTimeFormat` path, cf. #5206),
  not in the value crossing.
- **Writes are out of scope, and the negative is bounded:** only the READ paths
  were made decoder-aware. `_safeSet` still resolves `__sset_` from the running
  module. Nothing in the measured set needs it — `with({year: 2021})` (which
  writes into a record) answers correctly — so this is stated as untested
  surface, not as a known-good.

## Tests

- `tests/issue-5225-consumer-literal-seam.test.ts` — the non-Temporal
  reduction. The provider lane fails on base with exactly the table above; the
  single-module control passes on base. Verified by reverting only
  `src/runtime.ts`, `src/linked-provider-runtime.ts`, `src/index.ts` and
  deleting `src/runtime/cross-module-struct-owners.ts`.
- `tests/dogfood/temporal-global-harness.mjs` / `tests/issue-4628-temporal-global.test.ts`
  — five rows promoted from `knownGaps` to asserted `supported`; the
  `knownGaps` key list shrinks to the three non-seam rows above.
- `tests/issue-5242-class-value-construct-bridge.test.ts` — two pinned
  asymmetry rows un-pinned (see Result).
- Regression, one vitest process per file: issue-5221/5222/5223/5237/5239/
  5241/5242/5243/5244, issue-4628 ×2, provider-manifest, linker, linker-e2e,
  package-linking, issue-3521 ×5, issue-3765 ×2, issue-3782, issue-2928-e6,
  issue-2928-refusal.
  **`package-linking` fails 2 of 22 identically on base** (`Binaryen static
  merge failed: Command…` — the container's `wasm-opt`), and
  `issue-3521-prepared-free-function-routing` dies with
  `ERR_IPC_CHANNEL_CLOSED` on base too. Both measured by reverting only `src/`.
