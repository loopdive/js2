---
id: 2793
title: "[ARCH][SUBSTRATE] Structural-narrowing struct COPY at call boundary breaks reference semantics (mutation through interface/structural-class param lost)"
status: blocked
blocked_reason: "Senior-dev investigation (2026-06-28): no safe localized patch — needs phased substrate work (Gap A anon-literal field order → interfaces-as-externref everywhere → class-structural sibling detection). Routed to architect lane. See '## Senior-dev investigation & design recommendation'."
sprint: Backlog
created: 2026-06-28
updated: 2026-06-28
priority: medium
horizon: l
feasibility: hard
model: fable
reasoning_effort: max
task_type: bug
area: codegen
language_feature: structural-typing
goal: correctness
parent: 2791
depends_on: [2773]
---

# Structural-narrowing struct COPY at call boundary breaks reference semantics

Spun off from **#2791** (hybrid audit Row 4 investigation). Row 4's READ side is
discharged; this is the **genuine silent miscompile** that investigation
surfaced. It is **NOT** in the Row-4 lane (`resolveStructName` /
`emitNullGuardedStructGet`) — it lives in the call-argument coercion / param
typing, and overlaps the substrate `$Object`/externref value-rep work (**#2773**),
so route it to the **architect / substrate lane**.

## Symptom (silent wrong value)

Passing a value to a parameter whose declared type is a **different nominal
struct type** — a structurally-compatible _distinct class_, or an `interface` —
and then **mutating through that parameter** silently loses the write. JS
reference semantics are violated (objects are passed by reference; the compiler
copies).

```ts
class A {
  x: number;
  constructor() {
    this.x = 1;
  }
}
class B {
  x: number;
  constructor() {
    this.x = 2;
  }
} // structurally identical, DISTINCT Wasm struct
function setX(o: A, v: number): void {
  o.x = v;
}
const b = new B();
setX(b, 9);
b.x; // JS: 9.   Compiler: 2  (write went to a copy)
```

Interface params are the more idiomatic trigger and fail identically:

```ts
interface I {
  v: number;
}
class A implements I {
  a: number;
  v: number;
  constructor() {
    this.a = 0;
    this.v = 1;
  }
}
class B implements I {
  v: number;
  constructor() {
    this.v = 2;
  }
}
function setV(o: I, x: number): void {
  o.v = x;
}
const a = new A(),
  b = new B();
setV(a, 100);
setV(b, 200);
a.v * 1000 + b.v; // JS: 100200.   Compiler: 1002  (both writes lost)
```

Runnable repro + `it.fails` locks: `tests/issue-2791.test.ts` (the
"KNOWN write miscompile" describe block — flip `it.fails` → `it` when fixed).

## Root cause (verified via WAT, origin/main df78324)

The call site emits a **structural-narrowing struct COPY**: it reads the
source's fields and builds a fresh `struct.new <paramType>`, passing the copy.
The callee's `struct.set` then mutates the copy; the caller's original object is
never touched.

```
;; test():  setX(new B(), 9)
call 2            ;; new B() -> $B
struct.get 4 0    ;; b.__tag
struct.get 4 1    ;; b.x
struct.new 1      ;; *** fresh $A copy from B's fields ***
f64.const 9
call 4            ;; setX(<copy>, 9)   -- mutates the copy, not b
... struct.get 4 1  ;; return b.x -> still 2
```

Code path: `src/codegen/type-coercion.ts` — `getStructNarrowInfo` /
`emitStructNarrowBody` (the "Case 3: destination fields are a subset of source
fields" narrowing, ~L760-855). The `struct.set` inside the callee
(`assignment.ts:2912-2961`) and the Row-4 read dispatch are both _locally
correct_; the bug is the copy upstream.

## Why it has been latent

- **Not in test262**: test262 is JS — it has no `interface` / structural-class
  types, so this never appears in conformance. It bites **TS-typed user code**
  (interface/structural params with mutation — very common), central to the
  `npm-library-support` and self-hosting/dogfood goals.
- The Row-4 read path's runtime `ref.test` multi-dispatch masks the _read_ half,
  so values read correctly — only mutation is lost, which is easy to miss.

## Why no Row-4-lane fix works

By the time the callee's field write runs, the receiver is already a
disconnected copy. Gating `resolveStructNameForExpr` (the audit's prescribed
Row-4 fix) cannot reconnect it. Union/`any` params already route to the safe
dynamic path (they pass _by reference_ as externref — and indeed mutation
through union/`any` params works correctly today); the breakage is specific to
params typed as a _single different nominal struct_ that triggers the narrowing
copy.

## Recommended fix direction (architect / substrate)

The SAFE machinery already exists (multi-dispatch read + `emitAlternateStructSetDispatch`
write). Route structural/interface receivers through it by **not materializing a
narrowed struct copy**:

- **Preferred:** type a parameter (or binding) whose declared type is an
  `interface`, or a class that has a structurally-distinct assignable type, as
  **`externref`/`anyref`** rather than a narrow `ref $T`. The call-site coercion
  becomes `extern.convert_any` (share the ref) instead of the
  `emitStructNarrowBody` field-copy, and the callee's reads/writes use the
  existing SAFE multi-dispatch. Param typing lives in the function-signature
  lowering (`declarations.ts` / wasm param-type resolution); the copy is gated
  in `type-coercion.ts`.
- **Soundness condition for keeping the copy:** the narrowing field-copy is only
  sound when the source value's identity is NOT observed after the conversion (a
  fresh temporary / pure value-narrowing). Distinguishing aliased-and-mutated
  from value-narrowed needs escape/aliasing analysis — which is why this is
  architect-scoped, not a localized patch, and why a blanket "never copy" is
  itself unsound (it would change return-value / value-copy semantics).
- **Overlap with #2773:** the externref/`$Object` value-rep substrate work is
  the natural home for "share the ref + dynamic field access" — coordinate so
  the param-typing change and the substrate reader/writer land coherently.

## Validation (broad-impact)

- Flip the `tests/issue-2791.test.ts` `it.fails` write cases to `it` (must pass,
  host + standalone) and add: nested/aliased mutation, mutation visible to a
  second alias, array-of-interface element mutation, return-of-narrowed-value
  (must still value-copy where identity is not observed).
- Broad-impact → full `merge_group` test262 + standalone-floor authoritative; do
  NOT scoped-sweep.

## Senior-dev investigation & design recommendation (2026-06-28)

**Verdict: confirmed root cause; NO safe localized patch exists — this is a
substrate change (the issue's `[ARCH][SUBSTRATE]` tag is correct). Routing to the
architect / substrate lane (#2773) with a validated fix direction + the exact
gaps that must close.** Investigation done off `origin/main` ed1ef8e.

### The hard constraint (why the call-site alone can't fix it)

The copy lives in `type-coercion.ts coerceType` → `emitSafeStructConversion`
Case 3 → `emitStructNarrowBody` (~L971), reached when coercing `ref $From →
ref $To` for two **unrelated** Wasm struct types (`$To`'s fields ⊆ `$From`'s by
name, `$From` not a declared Wasm subtype of `$To`). The Wasm verifier will not
accept a `ref $From` where `ref $To` is declared, so the *only* way to SHARE the
caller's object (not copy) is to **widen the parameter's Wasm type to a common
supertype** (externref/anyref) — there is no call-site-only fix. Confirmed: the
param Wasm type is the binding constraint.

### Probe: interface → externref + dynamic dispatch WORKS, but exposes 2 latent gaps

I prototyped the issue's "Preferred" direction (route a plain `interface` value
type through externref + the existing union/`any` dynamic multi-struct dispatch,
by returning externref from `resolveWasmType` for interface types and `undefined`
from `resolveStructName` for them). Measured host **and** standalone:

| Case (host+standalone)                         | main (baseline) | probe         |
|------------------------------------------------|-----------------|---------------|
| `#2793` interface mutation-through-param        | FAIL (lost)     | **FIXED**     |
| return-the-param then mutate (identity)         | FAIL (=1)       | **FIXED (42)**|
| interface-typed field, mutate via alias         | FAIL (=1)       | **FIXED (99)**|
| array-of-interface element mutation             | FAIL (=1)       | **FIXED (5)** |
| second-alias visibility                         | FAIL (=1)       | **FIXED (77)**|
| reordered-anon read thru interface (#2791 lock) | OK (1020908)    | **REGRESS (1020809)** |
| non-mutated single-implementer interface read   | OK (4)          | **REGRESS (trap "illegal cast")** |

Takeaways: (1) the direction is **correct** — it fixes `#2793` AND **four more
currently-silent interface-reference-semantics miscompiles** that share the same
root cause (so `#2793` is the tip of an iceberg). (2) Naive widening **regresses
two currently-green reads**, and the WAT shows the regressions are NOT in the new
path — they are **latent bugs the narrow-copy was masking**:

- **Gap A — anon-literal field order (the copy is load-bearing).** `const b: I =
  { y: 8, x: 9 }` builds an anon struct in *source* order `[y,x]`, but the
  structurally-deduped canonical struct order is `[x,y]`; today the narrow-copy
  into `$I` **reorders by name** and masks this. Remove the copy and the value
  flows as its own anon struct → a by-name dynamic read of `o.x` returns the
  wrong slot (got 8, want 9). The literal builder must store in canonical field
  order independent of the copy.
- **Gap B — shape-dependent interface resolution.** With a *single* implementer,
  `getTypeAtLocation(param o: I)` does not resolve through the interface symbol,
  so the param was NOT widened (WAT: `getV` param stayed `(ref null $I)` and did a
  monomorphic `struct.get`), while the call site still narrow-copies → the
  inconsistency surfaces as an illegal cast. Widening must key off the param's
  **declared type node**, not the checker's (sometimes narrowed) resolved type.

### Why a localized params-only patch is unsound (do NOT ship it)

Widening only the *param* (leaving returns/locals/fields as `ref $I`) creates
impedance mismatches: `function f(o:I):I{return o}` and `this.field = o`
(field: `I`) then coerce externref → `ref $I` via a guarded cast that **nulls on
a non-`$I` runtime value** — trading the mutation miscompile for a
returns-`null`/store-`null` miscompile. Consistency requires interface types to
be externref **everywhere** (param + return + local + field). That is the
substrate change, and it must also fix Gap A/Gap B first.

### Recommended plan (architect / substrate lane, coordinate with #2773)

1. **Phase 1 (prereq, low-risk):** fix Gap A — make anon object-literal
   construction store fields in the deduped canonical order regardless of source
   order. Land + validate independently; it is a real latent bug today.
2. **Phase 2 (interfaces):** make `resolveWasmType` map a plain user `interface`
   to externref **consistently** (param/return/local/field), keyed off the
   declared type (fixes Gap B), and force `resolveStructName`/`resolveStructNameForExpr`
   to `undefined` for interface receivers so all reads/writes use the proven
   externref dynamic dispatch (`__set_member_*` / multi-struct get). This flips
   the **interface** half of the `#2791` lock (2 of 4 cases) and the 4 sibling
   miscompiles above. Broad value-rep change → full `merge_group` + standalone
   floor authoritative; watch interface-typed **struct fields** (layout/boxing).
3. **Phase 3 (class-structural, separate + riskier):** the `class A{x}` /
   `class B{x}` case needs whole-program structural-sibling detection to decide
   which *class* params to widen (a class with no structural sibling MUST keep
   its fast monomorphic `ref $A` path — perf). Recommend splitting this into its
   own issue; it is rarer and orthogonal to the idiomatic interface case that
   drives `npm-library-support` / dogfood.

Net: the `#2791` lock cannot be fully flipped (all 4) without Phase 3; the
high-value, idiomatic interface cases flip after Phase 1+2. None of the three is
a single safe senior-dev patch — they are sequenced substrate PRs.

### Captured repros (cold-start — tracked here, not yet split into own issues)

The investigation repros are inlined below so the next-window owner can reproduce
from this file alone (the `.tmp/*.mjs` probes are gitignored). Compile each with
`compile(src, { standalone })` and run `exports.test()`; all four **sibling
miscompiles** are silently wrong on `origin/main` TODAY (same root cause as the
headline `#2793` case — the structural-narrowing copy), host AND standalone:

```ts
// (1) return-the-param identity — main: 1   correct: 42
interface I { v: number; }
class A implements I { v: number; constructor(){this.v=1;} }
function id(o: I): I { return o; }
export function test(): number { const a=new A(); const r=id(a); r.v=42; return a.v; }

// (2) interface-typed field, mutate via alias — main: 1   correct: 99
interface I { v: number; }
class A implements I { v: number; constructor(){this.v=1;} }
class Box { h: I; constructor(h: I){ this.h=h; } }
function bump(b: Box){ b.h.v = 99; }
export function test(): number { const a=new A(); const b=new Box(a); bump(b); return a.v; }

// (3) array-of-interface element mutation — main: 1   correct: 5
interface I { v: number; }
class A implements I { v: number; constructor(){this.v=1;} }
function bump(arr: I[]){ arr[0].v = 5; }
export function test(): number { const a=new A(); const arr:I[]=[a]; bump(arr); return a.v; }

// (4) second-alias visibility — main: 1   correct: 77
interface I { v: number; }
class A implements I { v: number; constructor(){this.v=1;} }
function setV(o: I, x: number){ o.v = x; }
export function test(): number { const a=new A(); const b=a; setV(a,77); return b.v; }
```

The two probe-exposed regressions to watch (currently GREEN on `origin/main` —
the narrow-copy masks them; the fix MUST keep them green):

```ts
// Gap A — anon-literal field order. main: 1020908 (correct). Interface→externref
// probe regressed it to 1020809 because the copy currently reorders fields by
// name; without it, `{ y:8, x:9 }` flows as a source-order anon struct and a
// by-name dynamic read of `o.x` returns the wrong slot. FIX: store anon literals
// in canonical (deduped) field order.
interface I { x: number; y: number; }
function sum(o: I): number { return o.x*100 + o.y; }
export function test(): number { const a:I={x:1,y:2}; const b:I={y:8,x:9}; return sum(a)*10000+sum(b); }

// Gap B — shape-dependent interface resolution. main: 4 (correct). With a SINGLE
// implementer, getTypeAtLocation(param o:I) does not resolve through the interface
// symbol, so a probe keyed off the resolved type left the param a monomorphic
// `ref $I` while the call site still narrow-copies → illegal-cast trap. FIX: key
// the widening off the param's DECLARED type node, not the checker's resolved type.
interface I { v: number; }
class A implements I { a: number; v: number; constructor(){this.a=3;this.v=4;} }
function getV(o: I): number { return o.v; }
export function test(): number { return getV(new A()); }
```

These six + the headline `#2793` param-mutation case are all tracked under THIS
issue (no separate issue files filed). The architect/substrate owner may split
Phase 3 (class-structural) into its own issue when scoping the next window.
