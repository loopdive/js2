---
id: 3562
title: "standalone: Array.isArray(ArrayBuffer/Uint8Array) returns true (should be false per §7.2.2) — tests/issue-2047 red on main"
status: done
completed: 2026-07-24
assignee: ttraenkler/dev-opus-2
sprint: 76
created: 2026-07-24
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: codegen
language_feature: array-isarray, typed-arrays
es_edition: es2015
goal: test262-conformance
related: [2047]
loc-budget-allow:
  - src/codegen/object-runtime.ts
origin: "2026-07-24 invisible-guard-test audit (dev-opus-2): tests/issue-2047.test.ts silently red on main (outside required checks, #3008 gap) — surfaced alongside #680/#2961 in the same audit."
---

# #3562 — standalone `Array.isArray` reports byte carriers as arrays

## Problem

`tests/issue-2047.test.ts` (unify standalone `Array.isArray`) is **silently red
on current main** — it is not in the required guard suite (#3552) nor
PR-touched, so the #3008 gap hid the regression. Two subtests fail; the
mechanism is that `Array.isArray` on **byte carriers** (`ArrayBuffer`,
`Uint8Array`) returns **`true`**, where ES §7.2.2 IsArray requires **`false`**.

## Measured evidence (current main, `--target standalone`)

Subtest "returns false for ArrayBuffer / DataView / Uint8Array carriers (§7.2.2)":
```ts
const ab: any = new ArrayBuffer(8);
const dv: any = new DataView(new ArrayBuffer(8));
const u8: any = new Uint8Array(2);
return (Array.isArray(ab) ? 1 : 0) + (Array.isArray(dv) ? 2 : 0) + (Array.isArray(u8) ? 4 : 0);
// expected 0 (all false); ACTUAL 5  →  ArrayBuffer=true (+1), DataView=false (ok), Uint8Array=true (+4)
```
So `Array.isArray(new ArrayBuffer(8)) === true` and
`Array.isArray(new Uint8Array(2)) === true` — both wrong. `DataView` is
correctly `false`.

Subtest "byte carriers are false even when a real array carrier coexists":
expected `3`, **actual `1`** (the byte-carrier arm mis-answers when a real
`number[]` vec carrier also exists in the module).

The value-read-vs-direct-call agreement subtests and the boolean[]/number[]/
string[] carrier subtests still pass — the defect is specific to the
byte-carrier (`i32_byte` ArrayBuffer/DataView, `i8_byte` Uint8Array) branch of
the standalone `Array.isArray` predicate.

## Stale-expectation vs real regression

The test expectation is **spec-correct** (§7.2.2: a TypedArray/ArrayBuffer/
DataView is NOT an Array), so this is a **real semantics regression** in the
standalone `Array.isArray` byte-carrier discrimination, not a stale expectation.
`#2047` originally unified the predicate specifically so byte carriers report
`false`; something since regressed the byte-carrier arm (bisect to find the
culprit SHA — do NOT assume recent; the sibling #680 regression this audit found
was 7 days old).

## Suggested approach

- Bisect the two failing subtests to the culprit (repro above compiles in
  `--target standalone`).
- The byte-carrier discrimination lives in the standalone `Array.isArray`
  lowering (see #2047's unification: `i32_byte`/`i8_byte` carriers must answer
  `false`). Likely a carrier-kind check that stopped distinguishing byte vecs
  from real array vecs.
- Fold `tests/issue-2047.test.ts` into the required guard suite (#3552) once
  green, to close the #3008 invisibility (same closure as #2961/#680).

## Acceptance

- `Array.isArray(new ArrayBuffer(8))`, `Array.isArray(new Uint8Array(2))` →
  `false` in `--target standalone`; `tests/issue-2047.test.ts` green.
- Bisect SHA recorded.
- `tests/issue-2047.test.ts` added to `tests/guard-suite.json`.

## Resolution (2026-07-24, dev-opus-2) — CONTAINED, WAT-confirmed

**Root cause (not the fable shared-struct-rep substrate — the byte vecs are
DISTINCT types).** The standalone `Array.isArray` native predicate
(`__extern_is_array`, finalize-filled by `fillExternIsArray` →
`collectStandaloneArrayCarrierTypeIdxs`, `src/codegen/object-runtime.ts`)
`ref.test`s the value against the array-carrier type list. WAT-confirmed: type
index 0 in every module is `$__vec_base = (sub (struct (field $length (mut
i32))))` — the ABSTRACT common supertype that EVERY concrete `$__vec_*` declares
`(sub final $__vec_base …)`, **including** the byte vecs `$__vec_i32_byte`
(ArrayBuffer) and `$__vec_i8_byte` (Uint8Array). `collectStandaloneArrayCarrier
TypeIdxs` added `$__vec_base` to the carrier list via its `name.startsWith(
"__vec_")` check, so `ref.test (ref 0)` matched the byte-vec subtypes by WasmGC
subtyping → `Array.isArray` true — **defeating #2047's leaf-level exclusion**
(which correctly drops the specific `__vec_i32_byte`/`__vec_i8_byte` type IDs,
but the base subsumes them). DataView is correctly `false` because it's a
distinct `$__dv_window` wrapper, not a `$__vec_base` subtype.

**Attribution.** The `$__vec_base` common-supertype WasmGC refactor silently
defeated #2047's leaf-exclusion; the isArray carrier collector was never updated
to exclude the new abstract base. Regression is >2026-07-04 (predates the shallow
local git history; not bisected to an exact SHA per the mechanism being
sufficient) — another weeks-old invisible one outside required checks (#3008),
found by the same audit as #680/#2961.

**Fix (1 line + comment).** In `collectStandaloneArrayCarrierTypeIdxs`, skip the
abstract base: `if (name === "__vec_base") continue;` before the `__vec_*`
carrier add. The concrete leaf vec types remain the real array carriers, so real
arrays still answer `true`; the byte-vec subtypes are no longer subsumed.

**Verified.** `Array.isArray(new ArrayBuffer(8)/new DataView(…)/new
Uint8Array(2))` → `false`; `Array.isArray([1,2,3])` → `true`; combined shape → 0
(was 5). `tests/issue-2047.test.ts` 8/8 green; tsc clean. Folded into the
required guard suite (`tests/guard-suite.json`, #3552) to close the #3008
invisibility. Broad-impact-wise it only narrows the standalone isArray carrier
set (removes a wrongly-included abstract base) — merge_group-validated.
