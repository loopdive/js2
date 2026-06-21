---
id: 2505
title: "standalone: typed-vec array method on an externref receiver (top-level new Array(N)) emits invalid ref.cast"
status: done
assignee: ttraenkler/sdev-arrayrep
created: 2026-06-19
updated: 2026-06-19
completed: 2026-06-19
priority: medium
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: arrays, array-methods
goal: standalone-mode
related: [2190, 2191, 2502]
note: "renumbered 2379→2505 — id 2379 was reused on main for the Uint8ClampedArray method-dispatch issue, and 2503 landed on main for a toprimitive issue. This is the array-sort externref-element-rep issue."
---

# #2505 — array method on an externref receiver emits invalid `ref.cast`

## Problem (file-verified, current main)

A **top-level** `new Array(N).sort()` (and the other typed-vec array methods)
emits **invalid Wasm**:
`CompileError: Invalid types for ref.cast: ref.as_non_null of (ref extern) has to
be in the same reference type hierarchy as (ref N)` in `__module_init`.

Isolated minimal repro (current main):
- `new Array(2)` alone → PASS
- `new Array(1,2,3).sort()` → PASS (element-list ctor → typed vec)
- `[3,1,2].sort()` → PASS (literal → typed vec)
- `new Array(2).sort()` at **module top level** → **THROW** (invalid cast)
- `export function test(){ new Array(2).sort() }` → PASS (function-body codegen
  dodges it — DO NOT use a fn wrapper to repro; the test262 files run at top level)

Measured: `built-ins/Array/prototype/sort` 14 pass / 32 fail / 8 CE. The
invalid-Wasm subset (~16-21 of the fails: the CompileError + null-deref buckets)
is this bug. (The 9 "Cannot convert object to primitive" fails are #1917
ToPrimitive-engine-gated — out of scope.)

## Root cause (pinned)

The array-method dispatch (`compileArrayMethod`, `src/codegen/array-methods.ts`)
probe-compiles the receiver to find its real type (lines ~2654-2698). For a
top-level `new Array(N)`, the probe returns **externref** (line ~2667), which
sets `receiverIsExternref = true` but does **NOT** update `vecTypeIdx` — so it
stays the default inferred vec type.

`compileArraySort` (line ~7064) then does
`compileExpression(propAccess.expression)` (→ pushes an externref) followed by
`struct.get { typeIdx: vecTypeIdx, fieldIdx: 0 }` — a `struct.get` on the typed
vec applied to an externref value → the invalid `ref.cast`/`ref.as_non_null` of
`(ref extern)` against the vec struct type.

`receiverIsExternref` IS computed at the dispatch level but is **not consulted by
the `case "sort":` arm** (line ~2796) nor threaded into `compileArraySort` — so
sort takes the typed-vec path unconditionally even when the receiver is an
externref carrier.

## VERIFY-GATE VERDICT (2026-06-19) — (b) representation-scale, NOT a contained cast guard

The contained-vs-representation decision gate was: *does the `extern→$AnyString`
cast validate for a literal-array vec but not a `new Array(N)` vec because (a) the
element TYPE is correct and the cast is merely unvalidatable, or (b) the element
TYPE is genuinely WRONG for `new Array(N)`?*

**Answer: (b). The element array TYPE diverges at construction.** WAT-probed
(`.tmp/probe-elem.mts`, `.tmp/probe-vectype.mts`) standalone, current main
(parent 3760a9beb):

| source                         | element-array build       | sort/join stringify load            | validates |
|--------------------------------|---------------------------|-------------------------------------|-----------|
| `[3,1,2]` (literal)            | `array.new_fixed 3 3` — **type 3 = numeric f64 element array** | `array.get 3` → `number_toString` → `any.convert_extern` → `ref.cast (ref 6)` (cast operand IS the externref number_toString result) | **yes** |
| `new Array(2)` + writes        | `array.new_default 1` — **type 1 = boxed-any / externref element array** | `array.get 1` → `ref.as_non_null` → `any.convert_extern` → `ref.cast null (ref null 6)` (cast operand is the **boxed-any element itself**) | **NO** — `Invalid types for ref.cast: ref.as_non_null of (ref extern) has to be in the same reference type hierarchy as (ref 6)` |

The defect is **upstream of the cast site**: `new Array(N)` constructs a vec whose
element array is the boxed-any/externref array (type 1) while an array literal
constructs a vec with a typed numeric element array (type 3). So `elemType` for
`new Array(N)` is `externref`, the stringify takes the **non-numeric else arm**
(`ref.as_non_null` on a raw boxed-any element), and the subsequent `$AnyString`
cast is applied to a boxed *number* extern — a genuinely mistyped element, not a
correct-value-wrong-brand situation.

**A `ref.test $AnyString`-guarded bail at the cast site would PAPER OVER a real
representation bug** (it would silently mis-stringify the boxed-number element, or
bail to an empty/wrong result), so per the contained-vs-representation rail this
is **STOP-and-escalate**, not a dev guard.

## Architect target (the real fix — one of)

1. **Normalize `new Array(N)` element representation** to match the
   literal-array typed numeric vec when the subsequent writes are numeric (so the
   vec carries a typed numeric element array, not the boxed-any array). This is
   the representation-unification fix and removes the divergence at the source.
2. **Make the typed-vec array-method stringify dispatch on the ACTUAL element
   array type** (boxed-any vs numeric) rather than the statically-inferred
   `elemType`/`isNumeric`, and route a boxed-any element through the runtime
   any→string path (`__to_string`/`number_toString` after an any-tag dispatch)
   instead of the static `array.get + number_toString + ref.cast $AnyString`.

Both touch core array representation / typed-vec construction — architect-scale,
not a contained dev slice. The earlier "gate `case "sort":` on
`!receiverIsExternref`" idea (below) is INSUFFICIENT: the gate doesn't even fire
because the receiver is a typed vec `(ref null 2)`, not an externref — and even
if it did, it would only dodge sort while leaving the mistyped `new Array(N)`
element representation in place for every other consumer.

### (superseded) earlier dispatch-level hypothesis

When the receiver is an externref (`receiverIsExternref`), the typed-vec array
methods must NOT take the static-vec `struct.get`/`ref.cast` path. — **Does not
apply**: the `new Array(N)` receiver is a typed vec, `receiverIsExternref` is
`false`, so this gate never fires. Kept for the record; the real divergence is
the element-array type, per the verdict above.

## Acceptance criteria

1. Top-level `new Array(2).sort()` compiles to VALID Wasm (instantiates) standalone.
2. `built-ins/Array/prototype/sort` invalid-Wasm subset flips (re-measure;
   exclude the 9 #1917 ToPrimitive fails).
3. No regression: `new Array(1,2,3).sort()`, `[3,1,2].sort()`, comparator sort,
   and the existing typed-vec array-method fast paths stay correct (WAT-diff a
   literal-array sort; broad equivalence; HW floor).

## Resolution (sdev-arrayrep, 2026-06-19) — contained dispatch gate, NOT representation rework

Re-grounded against current main (218375d60, after #2502 + #2026 landed). The
earlier VERIFY-GATE verdict ("architect-scale representation normalization") was
**over-scoped**. #2502 had since gated the numeric Timsort fallback against
externref elements (sort crash in **GC mode** cleared), but the standalone
(`--target standalone`, native strings) crash for `new Array(N).sort()` and
`any[].sort()` was still live — through a *different* code path than #2502 fixed.

**Pinned root cause (standalone):** `compileArraySort` routes ref/externref
element kinds to `compileArrayDefaultToStringSort` (#1993 default ToString sort).
That function's non-numeric (`isStringElem`) branch loads each `array.get`
element and — **in native-string mode only** — `ref.cast`s it to `$AnyString`
(`stringifyTail`, array-methods.ts ~7194/7202). That cast is sound for a
NativeString-typed element ref (`kind:"ref"|"ref_null"`), but a boxed-any
`externref` element (`new Array(N)` holes, `any[]`) is in a *different*
reference-type hierarchy → `Invalid types for ref.cast: ref.as_non_null of
(ref extern) has to be in the same reference type hierarchy as (ref N)` in
`__module_init`. The #2502 no-op gate sits *after* this branch, so it never
fired for the externref-element case (the string branch returned non-null).

**Fix (one guard, `compileArrayDefaultToStringSort`):** bail (`return null`) when
`!isNumeric && native && elemType.kind === "externref"`, so the caller falls
through to the #2502 no-op (return the receiver unchanged — correct for the
all-holes `new Array(N)` case) instead of emitting the invalid cast. The guard is
scoped to **native + externref**: host mode is untouched (its string branch
`cmpStrType` is `externref` and emits only `ref.as_non_null`, no cast — so host
externref string sorts stay valid; the broader guard regressed the GC string-sort
test and was narrowed). Numeric (`f64`/`i32`) and NativeString-ref element sorts
are unaffected.

This is the contained dispatch fix the rail asks for, not a representation
rework: `new Array(N)`'s boxed-any element array stays as-is; we simply stop the
ToString sort from minting an invalid cast over it. Boxed-any ToString-*order*
sorting (sorting holes/`any` by their actual stringified value) remains a
separate, non-crashing follow-up needing a runtime any→string step.

**Out of scope (separate pre-existing bug, flagged):** standalone
`Array.prototype.join()` emits invalid Wasm (`__str_to_extern`: "not enough
arguments on the stack for call (need 3, got 2)") for **any** element kind —
`[3,1,2].join(",")`, `["a","b"].join(",")`, `new Array(2).join(",")` all fail. It
reproduces on a plain numeric/string literal with no `new Array` and no sort, so
it is NOT the element-rep issue; it belongs to the standalone-join slice (#2074).

### Test
`tests/issue-2379-standalone-sort-rep.test.ts` — 6 tests: `new Array(2).sort()`,
`new Array(3)`+writes+sort, `any[]` sort all compile to VALID standalone Wasm;
regressions — `number[]`, `string[]`, and comparator sorts stay valid standalone.
Existing #2502 (8), #1816 (9), #1993 (12) sort suites all still green.
