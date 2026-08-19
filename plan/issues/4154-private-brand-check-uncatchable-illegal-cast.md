---
id: 4154
title: "private access on a foreign receiver traps `illegal cast` instead of throwing the §7.3.28 PrivateBrandCheck TypeError"
status: done
completed: 2026-08-04
sprint: 78
priority: medium
goal: error-model
feasibility: medium
horizon: m
created: 2026-08-04
requested_by: ttraenkler/claude-bench
related: [4149, 3189]
---

# #4154 — PrivateBrandCheck traps instead of throwing

## Problem

`o.#m = v` where `o` does not carry the class's private brand emits an
unguarded cast of the receiver. On a foreign object that is an **uncatchable
`illegal cast` trap**, where §7.3.28 PrivateBrandCheck requires a **catchable
TypeError**.

The canonical shape is test262's own brand-check tests:

```js
class C {
  set #m(v) { this._v = v; }
  access(o, v) { return o.#m = v; }
}
let c = new C();
c.access(c, 'test262');          // fine — c has the brand

let o = {};
assert.throws(TypeError, function () {
  c.access(o, 'foo');            // must throw TypeError; today: illegal cast trap
});
```

Because the trap is uncatchable, `assert.throws` cannot catch it and the whole
module dies — so the test cannot pass even in principle until this is fixed.

## How it surfaced

It is **latent**, not new. It was masked by a second defect: `this._v = v`
inside the setter targeted a field with no declaration, and the generic
struct-write path dropped that write outright (`fieldIdx === -1 → return null`).
So the test failed at its FIRST assert (`Test262Error: Expected
SameValue(«undefined», «"test262"»)`) and never reached the brand check.

#4149 made undeclared-field writes land (routing them to the dynamic terminal).
The tests now get past the first assert and reach the brand check — where they
hit this trap. Measured by A/B on a single file, both tests:

| tree | result |
| --- | --- |
| `upstream/main` | `Test262Error: Expected SameValue(«undefined», «"test262"»)` |
| #4149 branch | `RuntimeError: illegal cast in C_access() at source L33` |
| #4149 branch, `assignment.ts` reverted | back to `Test262Error` |

Both files are `fail` in the baseline in every arm — this was a change of
failure MODE (fail → fail), never a pass→fail. It was caught by the #3189
uncatchable-trap ratchet in the merge queue (`illegal_cast` 48 → 50) and was
briefly declared under `trap-growth-allow` in
`plan/issues/4149-standalone-aliased-property-function-call-null.md`. That
declaration has since been **removed**: this issue is fixed in the same PR, so
the trap never appears and both files are expected to go `fail` → pass.

## Affected tests (the two the ratchet named)

- `test/language/statements/class/elements/private-setter-brand-check.js`
- `test/language/statements/class/elements/static-private-setter-access-on-inner-class.js`

Fixing this should make both **pass**, not merely stop trapping: each one's
remaining assertion is exactly the `assert.throws(TypeError, …)` that the
catchable throw would satisfy.

## Root cause (measured, not the original sketch)

The sketch said "the write path coerces the receiver … that coercion must
become a `ref.test`-guarded branch". The coercion is real but it was **not
emitted by the write path at all** — which is why grepping `assignment.ts` for
a `ref.cast` finds nothing to guard.

`compilePropertyAssignment`'s private-accessor branch has a receiver coercion
gated on `(ctx.standalone || ctx.wasi)` (#3232). On the gc/host lane that gate
is false, so the receiver is pushed as a bare `externref` where the setter
declares `(ref null $Class)`. Nothing in the front end fixes that up. The
**generic call-argument repair pass** does: `fixCallArgTypesInBody` in
`src/codegen/stack-balance.ts` sees an `externref` argument against a struct-ref
param and splices in

```wat
any.convert_extern
ref.cast_null $Class     ;; <- the uncatchable trap
```

That is a whole-module repair with no notion of private semantics, so it cannot
be the place the brand check lives. Confirmed by dumping the repro's WAT:
`C_access` was exactly `local.get 1; any.convert_extern; ref.cast null …;
local.get 2; local.tee 3; call 4`.

## Fix

`compilePrivateSetterWithBrandCheck` (new, `src/codegen/expressions/assignment.ts`).
When the receiver is statically an `externref` and the setter's self param is a
struct ref, the private-accessor branch now performs the narrowing **itself**,
guarded, so the repair pass never sees a mismatch:

```wat
local.set  $recv                 ;; receiver
<value>                          ;; RHS evaluated BEFORE the check (§13.15.2)
local.set  $val
local.get  $recv
any.convert_extern
ref.test   $Class                ;; the brand check
(if (then <narrow; call the setter>)
    (else <throw a real TypeError instance>))
local.get  $val                  ;; `=` evaluates to the RHS
```

`ref.test` uses the same subtype relation the `ref.cast_null` used, so every
receiver the cast accepted still takes the call path — this converts a trap into
a throw and changes nothing else. `ref.test` is false for null, which is also
correct: PutValue on a Private Reference does `ToObject(base)` first and
`ToObject(null)` throws TypeError anyway.

**Read side: no change needed.** Measured on both lanes, foreign-receiver reads
of a private *getter* and a private *field* already throw catchable TypeErrors.
The one read-side gap is a private **method** call on a foreign receiver
(`(o as any).#meth()`), which silently succeeds instead of throwing — verified
identical before and after this fix, so it is a separate pre-existing defect,
not part of this one.

## Acceptance

- The repro above throws a catchable TypeError on both lanes. ✅ (gc/host and
  standalone; the thrown value passes `instanceof TypeError`)
- Both named test262 files pass. ✅ locally, by transcription — both files'
  shapes are covered by `tests/issue-4154-private-brand-check-typeerror.test.ts`
  and pass on both lanes. The test262 submodule is not checked out in this
  container, so the files themselves were not run; CI's merge-queue shards are
  the authority.
- `illegal_cast` does not grow; the `trap-growth-allow` in #4149 is retired. ✅
  declaration removed.

## Regression test

`tests/issue-4154-private-brand-check-typeerror.test.ts` — both test262 shapes
(instance setter, static setter via inner class) × both lanes, plus the
branded-write, assignment-value and RHS-evaluation-order guard rails.
Mutation-checked: all 4 cases fail against the pre-fix `assignment.ts`.
