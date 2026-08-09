---
id: 2732
title: "operators: unary +/-/~/>>> ToPrimitive(object) trap; strict-equals boxed-wrapper/funcref trap"
status: blocked
sprint: Backlog
goal: test262-conformance
feasibility: hard
depends_on: [2712]
blocked_on: "(a) dynamic-ToPrimitive $Object dispatch substrate (#2580/#2660/#2175, in-flight); (b) bool-ValType decision #2712 — see Senior verify-first note"
priority: medium
es_edition: ES3
language_feature: operators
task_type: bug
created: 2026-06-26
updated: 2026-06-27
---
# #2732 — operator trapping residuals (split from #2707 (a)+(b))

Split out of #2707 — the TCO portion (c) landed in PR #2159. These two
sub-bugs are independent **runtime traps** (not assertion failures) that look
like value-representation / boxed-wrapper substrate gaps, so this is
**architect-routed (feasibility: hard)**, not a quick operator-codegen tweak.

## (a) Unary `+` / `-` / `~` / `>>>` on a non-primitive operand traps

`+object` where `object = { valueOf() { return 1 } }` traps at runtime with
**"dereferencing a null pointer"** instead of performing `ToNumber` →
`ToPrimitive(object, Number)` (call `valueOf` / `toString`). The issue spec
originally framed this as "null/undefined operands", but the actual failing
test262 tests exercise `ToPrimitive` on **objects** (`valueOf`/`toString`
dispatch), which is the deeper gap — the unary lowering reads a numeric field
off the operand ref before coercing, null-dereferencing when the operand is a
non-number object.

Tests (verified to trap on main HEAD, 2026-06-26):
```
test/language/expressions/unary-plus/S11.4.6_A2.2_T1.js       (+object via valueOf/toString)
test/language/expressions/unary-minus/S11.4.7_A2.2_T1.js
test/language/expressions/bitwise-not/S11.4.8_A2.2_T1.js
test/language/expressions/unsigned-right-shift/S9.6_A3.1_T4.js
test/language/expressions/bitwise-not/S9.5_A3.1_T4.js
```
Spec: §7.1.4 ToNumber, §7.1.1 ToPrimitive (OrdinaryToPrimitive: valueOf then
toString, each via §7.3 Call; TypeError if neither returns a primitive).

## (b) `strict-equals` / `strict-does-not-equals` with a boxed wrapper / funcref traps

`true !== new Boolean(true)` (and the `new Number(...)` / `new String(...)`
variants) should be `true` (different types → §7.2.16 step 1), but the
comparison **traps with a WebAssembly.Exception** instead of short-circuiting on
the type-tag mismatch. The `#` in the original #2707 framing is a wasm funcref /
boxed-wrapper representation; the strict-equality fast path mis-handles the
boolean-primitive vs boxed-object-wrapper case.

Tests (verified to trap on main HEAD):
```
test/language/expressions/strict-equals/S11.9.4_A8_T1.js .. _T3.js
test/language/expressions/strict-does-not-equals/S11.9.5_A8_T1.js .. _T3.js
```
Spec: §7.2.16 Strict Equality Comparison (Type(x) ≠ Type(y) ⇒ return false; the
`!==` then negates).

## Why architect-routed / hard

Both are runtime traps, not wrong values — the codegen emits an op that assumes
a representation the operand doesn't have (a numeric field on a boxed/object
ref; a primitive tag on a wrapper). The fix likely needs the
boxed-wrapper / `any`-value-read substrate (see the standalone value-rep
substrate notes) rather than a localized operator patch. An architect should
spec the ToPrimitive-in-numeric-context path and the strict-eq type-tag
classifier against the boxed-wrapper representation before a dev implements.

## Acceptance criteria

At least 9 of the 11 listed tests (5 unary + 6 strict-equals) flip fail→pass,
with no regression in operator tests and full CI green.

## Notes
- BigInt operator tests remain out of scope (blocked on #2044).
- `with`-statement increment/decrement tests remain wont-fix (skip-filtered).
- TCO portion (c) of the parent #2707 is done in PR #2159.

---

## Senior verify-first note (Esch, 2026-06-27) — both halves are substrate-gated; status → blocked

Verify-first done on `origin/main` `f515906`, running the **actual** 11 test262
files through the runner's own `wrapTest`. Both (a) and (b) **still trap** — the
issue is real, not stale. But the root causes show **neither half is an
independently dev-able localized fix**; both are gated on architect-class
value-rep substrate. Set `status: blocked`. (The architect's earlier split call —
"(a) dev-able" — was a scope-read; this is the traced mechanism, which supersedes
it. Both sub-bugs are documented below so the work isn't lost.)

### (a) Unary `+`/`-`/`~`/`>>>` on object — traced root cause

It is **not** the issue's original framing ("the unary lowering reads a numeric
field off the operand ref before coercing"). The trap is a **type-soundness gap**:

- The 5 unary test files compile with `success: true` but **5 ignored TS errors**:
  `Subsequent variable declarations must have the same type. Variable 'object'
  must be of type '{ valueOf: () => number; }', but here has type '{...}'`.
  test262 reassigns `var object` to type-**incompatible** shapes (legal JS,
  illegal TS). The compiler proceeds and keeps `object` **statically typed as the
  first shape** (`{valueOf:()=>number}`).
- `+object` then emits **static struct-field valueOf dispatch** against that first
  shape's layout. At CHECK#6 the runtime value is a *different* struct shape
  (`{valueOf:()=>{}, toString:()=>1}`); the valueOf field-ref read at the stale
  static offset is null/wrong → **"dereferencing a null pointer"**.
  (Bisect: truncating the file through CHECK#5 passes; adding CHECK#6 traps.)

**Proof it is NOT a localized unary fix** (all on current main):
- single-shape objects PASS — `+{valueOf(){return 1}}` → 1; `{valueOf(){return{}},
  toString(){return 1}}` (toString fallback) → 1;
- type-correct 2- and 3-member unions PASS — even unions whose members' valueOf
  returns an object, and a member where both valueOf+toString return objects;
- it reproduces **only** on the stale-static-type + heterogeneous-`var`-
  reassignment pattern;
- `+(object as any)` and `Number(object)` **also trap** on the full file — boxing
  to externref inherits the wrong static type, feeding the existing dynamic
  ToNumber funnel (`__unbox_number`) a mis-boxed value. So even the dynamic funnel
  cannot save it; the substrate isn't there.

**Sound fix:** ToPrimitive/ToNumber on an object operand must use **dynamic
valueOf/toString lookup on a `$Object` representation**, not static struct-field
dispatch — the dynamic-object-dispatch substrate (in-flight **#2580 / #2660 /
#2175**). A localized force-box of object operands on the hot ToNumber path would
regress the many single-shape cases that currently pass (broad-impact-without-
substrate). → fold this requirement into the substrate spec; not a separate dev
task. `blocked_on` #2580/#2660/#2175.

### (b) strict-equals / strict-does-not-equals with boxed wrapper — it's the bool collision

The wrapper-object arm itself is fine: with the wrapper TS type preserved (the real
test scenario, no `as any`), `true === new Boolean(true)` etc. correctly return
`false` via `__host_eq` (`src/codegen/binary-ops.ts:2563-2585`). The 6 tests fail
on the **primitive cross-type** comparisons they also contain:

- `true === 1` → **true** (should be false); `false === 0` → **true**; `0 ===
  false` → **true**. These are the **boolean-as-i32 representation collision**:
  `true`/`false` lower to bare `{kind:"i32"}` (1/0), identical to a number's i32,
  so the equality path compares values and the static type-mismatch short-circuit
  (`binary-ops.ts:2587`, `leftJsKind !== rightJsKind`) is bypassed by the earlier
  numeric i32 path. (Bisect of S11.9.4_A8_T1: check#1 `true === new Boolean(true)`
  passes; check#2 `true === 1` is where it goes wrong.)

This is exactly **#2712** (real bool ValType / retire the i32-boolean brand). (b)
rides the bool-ValType lane when #2712 lands. `depends_on: [2712]`. This is a
**live conformance cost** that validates the #2712 architect-gate.

### Acceptance re-scope

Original acceptance (9 of 11 fail→pass) is **unreachable now**: (a) = 5 tests
substrate-blocked, (b) = 6 tests blocked on #2712. Neither half is independently
dev-able. When the dynamic-ToPrimitive substrate lands, (a)'s 5 should close; when
#2712 lands, (b)'s 6 should close. Re-open / re-scope per whichever lane lands
first.
