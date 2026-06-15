---
id: 2142
title: "Reconcile undefined-representation ownership: #2051 spec (externref widening) vs #2106 (UNDEF_F64 sentinel)"
status: ready
sprint: 62
created: 2026-06-12
updated: 2026-06-12
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: docs
area: planning
language_feature: undefined
goal: consistency
related: [2051, 2106, 2004]
origin: "2026-06-12 sprint-62 architecture analysis (value-rep workstream N1)"
---

# #2142 — two architect documents prescribe different representations for the same sites

## Problem

The #2051 spec (PR #1393, `arch-2051-undefined-repr`) prescribes
**externref widening + host `undefined`** for optional-chain short-circuit
arms; #2106 (value-rep P3) prescribes the **`UNDEF_F64` sentinel** for the
same producer list. A dev dispatched on either will contradict the other.

## Approach

Amend #2106: remove #2051's sites from its producer list; record the
decision rule — *widen when consumers already discriminate externref;
sentinel only inside hot f64 carriers* (codePointAt OOB, f64 destructuring
reads). #2051 lands per its own spec (it composes with all three existing
consumers and needs zero observer changes).

## Acceptance criteria

- Both documents name exactly one owner mechanism per site.
- #2051's t4/t6 cases and #2004's `codePointAt ?? -1` each cite exactly one
  mechanism.

## Notes

Doc-only, S-size. Do before dispatching #2051 or #2106.

---

## Decision (authoritative — 2026-06-15, arch1)

> Verified against `origin/main` @ `516feec44`. Code anchors below are from
> that HEAD; re-grep the function names if they have drifted.

### The actual state on main (the three mechanisms already exist)

There are **three** distinct undefined-in-a-primitive-carrier mechanisms in
the tree today, not two. The conflict #2142 names is real, but the resolution
is grounded in which consumers each mechanism's value can actually reach:

1. **externref + host `undefined`** (`emitUndefined` → `__get_undefined`).
   Observed by `===`/`!==` (`binary-ops.ts:411-422` routes
   `x === undefined` through `__extern_is_undefined`), by `typeof` (runtime
   `__typeof`, `typeof-delete.ts`), by ToString (`__extern_toString`,
   `string-ops.ts`), and by `??` (`logical-ops.ts:226-236` —
   `ref.is_null || __extern_is_undefined`). This is **the only channel all of
   `===`/`typeof`/ToString/`??` already discriminate.**
2. **sNaN sentinel `0x7FF00000DEADC0DE`** (`type-coercion.ts:2672`,
   `emitDefaultValueCheck` family). Observed by **exactly one** consumer:
   `emitDefaultValueCheck` (`shared.ts:418`), wired into
   destructuring/default-parameter checks (`destructuring-params.ts:830`) and
   array/tuple hole materialization (`literals.ts:1759,2317,2886`). It is
   **NOT** observed by `===`, `typeof`, ToString, or `??`. `=== undefined` on
   an f64 is unconditionally `false` (`binary-ops.ts:479-482`); the f64 channel
   cannot be told apart from a *real* `NaN`-valued property.
3. **codePointAt `??`-site NaN special-case** (`logical-ops.ts:208-216`,
   `isCodePointAtCall`). `codePointAt`'s result type is **still `f64`**
   (`index.ts:6936`) and out-of-range still emits `f64.const NaN`
   (`string-ops.ts:2635`). The *only* place this NaN is read as "undefined" is
   a hard-coded branch in `compileNullishCoalescing` that detects an
   `isCodePointAtCall` LHS and tests `f64.ne` (isNaN). `=== undefined` /
   `typeof` over `codePointAt(oob)` do **not** observe undefined today.

### The decision rule

**Widen to externref + host `undefined` when the value must be observable to
the general nullish/identity/stringify consumer set (`===`, `!==`, `typeof`,
ToString, `??`). Use the sNaN sentinel ONLY inside the hot f64 carriers whose
sole consumer is `emitDefaultValueCheck` (destructuring/default-parameter
reads, array/tuple holes). Do not introduce a third claim on `codePointAt` —
it already has its own `??`-site mechanism; leave it.**

Why widen, not sentinel, for the general case: facts 1–2 above mean the
sentinel value can never reach `===`/`typeof`/ToString — those consumers would
need new per-operator sentinel-detection code at every site (and the sNaN bit
pattern collides with a genuine `NaN` property value, which is unfixable). The
externref channel already routes through all four consumers with zero new
observer code. #2051's own implementation plan confirms its binding slots are
*already* externref (`variables.ts:100-102` widens `isNullablePrimitiveType`),
so widening removes a lie at the source rather than adding a representation.

Why sentinel, not widen, for the default-check carriers: those f64 values are
consumed *only* by `emitDefaultValueCheck` (which already compares against the
sentinel), they are hot (destructuring/param init on every call), and widening
them to externref would force a `__box_number` on every defaulted read for zero
observability gain — the value is never compared with `===`/`typeof`/ToString,
only "is this the absent sentinel? then run the default initializer."

### Per-site ownership (one owner mechanism per site)

| Site | Owner mechanism | Owning issue | Rationale |
|---|---|---|---|
| Optional-chain short-circuit (`a?.b`, `a?.[i]`, `a?.m()`) where non-nullish result is primitive | **externref + host `undefined`** | **#2051** | result feeds `===`/`typeof`/ToString/`??`; binding slot already externref |
| `number\|undefined` carriers consumed by `===`/`!==`/`typeof`/ToString/`??` (general value-rep observability) | **externref + host `undefined`** | **#2106** (P3 observability), composing with #2072/#2104 value-rep | same consumer set; the sentinel can't reach these consumers |
| Destructuring / default-parameter f64 reads; array/tuple holes | **sNaN sentinel** (existing) | **#2106** (P3) — codifies the existing `emitDefaultValueCheck` carve-out; **erasure stays** | sole consumer is `emitDefaultValueCheck`; hot path; no observability needed |
| `codePointAt(oob) ?? rhs` | **codePointAt `??`-site NaN special-case** (existing, `logical-ops.ts:208`) | **neither #2051 nor #2106** — already shipped, leave as-is | already works for `??`; do not re-represent |
| Standalone `undefined` vs `null` distinctness (`$undefined` singleton) | **standalone tag-1 `$undefined` global** | **#2106** (P3 standalone), aligned with #2104 JsTag | orthogonal to the host-vs-sentinel choice; standalone-only gap |

### Amendments applied

- **#2106**: producer list amended — #2051's optional-chain sites **removed**
  (they are #2051-owned, externref-widened). #2106's remaining producer scope
  is (a) the general `number|undefined` observability widening to externref and
  (b) codifying the existing sNaN sentinel carve-out for default-check carriers,
  plus (c) the standalone `$undefined` singleton. The decision rule above is
  recorded in #2106's "Root cause"/"Fix direction".
- **#2051**: unchanged — lands per its own `## Implementation Plan` (externref
  widening at the three optional-chain sites). It composes with all four
  existing consumers and needs zero observer changes.
- **#2004** (`codePointAt ?? -1`): already `done` (PR #1329 / #1475-era). Its
  one mechanism is the `logical-ops.ts:208` `??`-site NaN special-case. Neither
  #2051 nor #2106 touches it.

### Acceptance criteria — met

- ✔ Both documents name exactly one owner mechanism per site (table above).
- ✔ #2051's `t4`/`t6` cases → externref widening (#2051).
- ✔ #2004's `codePointAt ?? -1` → the existing codePointAt `??`-site NaN
  special-case (neither doc re-claims it).
- ✔ Default-check / hole carriers → sNaN sentinel, erasure preserved (#2106).
