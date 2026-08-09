---
id: 2585
title: "standalone: getPrototypeOf(Object.create(p)) === p is false — object identity lost in __any_strict_eq tag-5 arm"
status: blocked
sprint: Backlog
created: 2026-06-21
updated: 2026-07-04
priority: high
feasibility: medium
reasoning_effort: high
model: opus
task_type: bugfix
area: codegen, runtime
language_feature: prototype chain, strict equality, object identity
goal: property-model
related: [1888, 1629, 296, 2104, 2626, 2580]
depends_on: [2626]
origin: "2026-06-21 — surfaced during s64 value-rep keystone work; proto-identity comparison gap."
---

> **BLOCKED — folded into #2626 (2026-06-22).** The object-identity `ref.eq` arm
> of the tag-5 equality classifier shipped in #1888 but EJECTED the merge_group on
> the standalone-highwater floor (−162, class/dstr cluster): making tag-5 boxed-object
> `===` reference-correct flips a comparison the destructuring / generator-iterator
> lowering implicitly relied on. The fix is substrate-blocked and tracked, together
> with the #2040 numeric arm, by **#2626** behind the value-rep substrate (#2580 M3/M4,
> #35). Do not re-attempt the standalone proto-identity arm in isolation. See
> `plan/issues/2626-tag5-boxed-value-equality-classifier-substrate.md`.

## Problem

Standalone, comparing two references to the SAME object for identity returns
false when both flow through the `any` value-tag boxing:

```ts
const p: any = { z: 1 };
const c = Object.create(p);
Object.getPrototypeOf(c) === p;   // → false  (expected true)
```

Repro confirmed failing on main HEAD (93e53919f), `--target standalone`:
returns `+0` (false).

### Root cause (WAT-confirmed)

The object plumbing is correct — the bug is in the `===` comparison.

WAT excerpt (`getPrototypeOf(c) === p`):
```
local.get $p / local.tee ... / call $__object_create  ;; c
call $__getPrototypeOf                                 ;; getPrototypeOf(c)
call $__any_box_string          ;; LHS boxed as tag 5
local.get $p
call $__any_box_string          ;; RHS boxed as tag 5
call $__any_strict_eq           ;; compares as STRINGS
```

1. `p` is a real `$Object` (`__new_plain_object` + `__extern_set`).
2. `Object.create(p)` (`__object_create`, object-runtime.ts:2293) builds a
   fresh `$Object` with `$proto = ref.cast $Object(p)` — a `ref null $Object`.
   `__getPrototypeOf(c)` (object-runtime.ts:2264) reads field 0 and
   `extern.convert_any`s it back. So `getPrototypeOf(c)` IS the same GC
   reference as `p` — identity is preserved up to here.
3. The `===` lowers BOTH operands through `__any_box_string`
   (`src/codegen/value-tags.ts:185` — the generic-externref boxing arm, kept at
   **tag 5 / STRING** by the #1888 −794 regression note) and then
   `__any_strict_eq`.
4. `__any_strict_eq`'s **tag-5 arm** (`src/codegen/any-helpers.ts` ~L1608–1624)
   compares the two `externval` fields via **`__str_equals`** (string content
   equality) — never `ref.eq`. Two `$Object` externrefs are not strings, so
   `strEqualsIdx` (the `wasm:js-string` `equals` host import, -1 in pure
   standalone) yields the `else: [{ op: "i32.const", value: 0 }]` arm → false.

So two identical objects boxed as tag-5 always compare unequal: object identity
is silently lost whenever a `$Object` is boxed through the generic-externref
(tag-5) path.

### Why the top-level `ref.eq` fast path does not save it

`__any_strict_eq` opens with a `ref.eq` on the two **`$AnyValue` struct refs
themselves** (any-helpers.ts:1488). But the two operands are **distinct freshly
allocated `$AnyValue` boxes** (one per `__any_box_string` call) — different
structs, so the struct-level `ref.eq` is false. The identity that matters lives
in `externval` (field 4), which the tag-5 arm never `ref.eq`-compares.

## Implementation Plan

### Approach

Add a `ref.eq` (object-identity) short-circuit to the **tag-5 arm** of
`__any_strict_eq`, BEFORE the `__str_equals` content compare. Two identical
object/string externrefs are `ref.eq`-equal, so this returns true for object
identity; two distinct strings with equal content are NOT `ref.eq` and fall
through to `__str_equals` (content equality preserved).

This fixes identity WITHOUT changing the boxing representation — so it does NOT
risk re-introducing the #1888 −794 baseline regression that the
"keep tag-5 for generic externref" note guards against.

### Changes

**File: `src/codegen/any-helpers.ts`**

- Function building `__any_strict_eq` (`addHelper("__any_strict_eq", …)`, line
  ~1481). In the **tag-5 (string)** arm (line ~1608, the
  `tagA == 5` branch), wrap the existing `__str_equals` body so that it FIRST
  compares the two externvals by reference:

  Current tag-5 `then`:
  ```ts
  then: strEqualsIdx >= 0
    ? [ get a.externval, get b.externval, call strEqualsIdx ]
    : [ i32.const 0 ],
  ```

  New tag-5 `then`:
  ```ts
  then: [
    // Object identity (and string-interning) fast path: if both externvals
    // are the same GC reference → equal. Recovers object identity for
    // $Object/$Vec/etc. boxed at tag-5 (value-tags.ts:185).
    local.get a; struct.get $AnyValue 4;  // a.externval (externref)
    any.convert_extern;                    // → anyref (eqref-comparable)
    local.get b; struct.get $AnyValue 4;
    any.convert_extern;
    ref.eq;
    (if (result i32)
      (then i32.const 1)
      (else
        // Distinct refs: fall back to STRING content equality for genuine
        // strings. Non-string externrefs are not ref.eq and not equal here.
        strEqualsIdx >= 0
          ? [ local.get a; struct.get $AnyValue 4;
              local.get b; struct.get $AnyValue 4;
              call strEqualsIdx ]
          : [ i32.const 0 ]))
  ]
  ```

  Notes for the implementer:
  - `externval` is field index 4 of `$AnyValue` (tag=0, i32val=1, f64val=2,
    refval=3/eqref, externval=4/externref) — confirm against the struct layout
    where `__any_box_string` writes `local.get 0` into the 5th `struct.new`
    slot (any-helpers.ts:662).
  - `ref.eq` requires `eqref`-compatible operands. `externref` is not directly
    `ref.eq`-able, so `any.convert_extern` each externval to `anyref` first
    (anyref is a subtype of eqref's hierarchy for GC refs; a host externref
    converts to an internal ref or stays comparable). Verify the emitter
    accepts `ref.eq` on the converted operands; if `any.convert_extern` of a
    host externref is not eqref-comparable, gate the fast path on
    `ref.test`-ing both as internal GC refs first, OR convert and `ref.eq` —
    both `$Object` externvals are internalized GC refs (`extern.convert_any`
    round-trips), so `any.convert_extern` + `ref.eq` is the expected shape
    (this mirrors the tag-6 arm, which `ref.eq`s the eqref `refval` at
    any-helpers.ts:1605).
  - A null externval (defensive): `any.convert_extern(null)` is null; `ref.eq`
    of two nulls is true — acceptable (two tag-5 boxes of null/undefined
    externval would be equal, which matches `===`).

### Edge cases

- **Object identity** (`getPrototypeOf(c) === p`) — same `$Object` externref →
  `ref.eq` true. FIXED.
- **Two distinct strings, equal content** (`("a"+"") === "a"` boxed via any) —
  distinct GC string refs, NOT `ref.eq` → fall to `__str_equals` → true.
  Preserved. (Add a regression test to prove the content path still works.)
- **Two distinct objects** (`{} === {}` via any) — distinct refs, not
  `ref.eq`; `__str_equals` on two non-string objects returns 0 (or
  `strEqualsIdx == -1` → 0) → false. Correct (`{} !== {}`).
- **string vs object both tag-5** — they are different GC refs; `ref.eq` false;
  `__str_equals` content compare returns 0/false. Correct (a string is never
  `===` an object — though note both being tag-5 is itself the #1888
  representation compromise; this fix does not worsen it).
- **NaN / number tags** — unaffected; numbers are tags 2/3 and handled by the
  numeric-class arm above (any-helpers.ts:1510), never reaching the tag-5 arm.

### Regression-risk check

This is additive within the tag-5 arm only. The top-level struct `ref.eq`
(line 1488), numeric arm, and all other tag arms are untouched. The string
content path is preserved as the `else` of the new `ref.eq`. The #1888 note
specifically warns against changing the **boxing** (value-tags.ts:185), which
this fix does NOT touch — so the −794 baseline risk does not apply. Still,
because the harness comparator `isSameValue` runs over tag-5 externref `any`
values, the implementer MUST run the standalone-affecting test262 buckets in CI
and confirm no net regression before merge (escalate if any bucket regresses).

### Test plan

Add `tests/issue-2585-proto-identity.test.ts` (standalone harness):

- `const p:any={z:1}; const c=Object.create(p);
   return (Object.getPrototypeOf(c)===p)?1:0` → 1
- `const p:any={z:1}; const q:any={z:1};
   return (Object.getPrototypeOf(Object.create(p))===q)?1:0` → 0
  (different objects, even same shape)
- object self-identity through any: `const a:any={}; const b:any=a;
   return (a===b)?1:0` → 1
- string content equality preserved: `const s:any="a"; const t:any=("a"+"");
   return (s===t)?1:0` → 1
- string vs object: `const s:any="x"; const o:any={};
   return (s===o)?1:0` → 0
- distinct objects: `return (({} as any)===({} as any))?1:0` → 0

Scoped local check before PR; CI validates conformance. Expect positive
test262 delta in `built-ins/Object/{create,getPrototypeOf}/` and
`language/expressions/equality/` object-identity tests.

---

## Architect spec pointer (2026-07-04)

The dynamic-MOP umbrella spec **#3031**
(`plan/issues/3031-dynamic-mop-extensions-spec.md`, Part 2 §2.1) ratifies
that the mutable-[[Prototype]] chain REPRESENTATION is identity-correct
(`$Object.$proto` holds the same GC ref); only the tag-5 `===` classifier
loses identity. This issue stays folded into **#2626** behind the value-rep
substrate — #3031 explicitly excludes it from its slice table (do not
re-attempt in isolation).
