---
id: 5201
title: User-defined instance method of a builtin-derived class is dispatched as a builtin proto method — `__clzmsd is not a function` blocks Temporal module init
status: ready
sprint: current
priority: high
horizon: m
goal: standalone-gap
feasibility: hard
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-29
---

# #5201 — builtin-derived instance methods mis-dispatched to `Array.prototype`

## Problem

With the #5191 fix (class-object singleton) and the #5193 fix (init-window
marshalling, PR #5252) applied, the `@js-temporal/polyfill` + `jsbi@4.3.0`
linked ESM bundle advances further through module init and now stops at:

```
TypeError: __clzmsd is not a function
```

raised from `runtime.ts`'s `__proto_method_call` arm. `moduleInitRuns` stays
`false`; #4628 Option A remains gated on this.

## Mechanism (from dev-5193's isolation — needs a real reduction)

jsbi declares `__clzmsd()` as an **instance method** of
`class JSBI extends Array` and calls it as `_.__clzmsd()`. Codegen lowered
the call to the builtin-proto dispatch path — effectively
`Array.prototype.__clzmsd.call(receiver)` — i.e. a user-defined method of a
builtin-derived class was routed as if it were a built-in `Array.prototype`
method. `Array.prototype` has no such function, so the host runtime throws.

Same #5191 family: the builtin-parent classification bleeding into member
dispatch decisions.

**Important:** the obvious one-line repro (`class C extends Array { m() {
return 1 } } new C().m()`) does NOT reproduce, per dev-5193. The failing
shape involves something extra — plausibly the receiver flowing through a
variable of imprecise type, a `this`-call inside another method (`_` is
jsbi's convention for `this`-aliasing), or the #5193 init-window context.
Reduce from the bundle (harness slice lane / statement-prefix bisection) —
do not guess.

## Direction

Find the dispatch decision that routes member calls on builtin-derived
receivers to `__proto_method_call` with the builtin's proto, and make it
consult the class's own declared members first (or carry the class identity
through the imprecise-receiver path). Keep genuinely-builtin methods
(`push`, `slice`, …) on the fast path; measure both.

## Acceptance criteria

1. A reduced repro (checked into the new test file) that fails on base and
   passes with the fix, host and standalone.
2. jsbi's real shape works: an instance method declared on
   `class X extends Array`, called through a `this`-alias inside another
   method, at module-init time.
3. The Temporal harness advances past `__clzmsd`: run
   `node --import tsx tests/dogfood/temporal-polyfill-harness.mjs` — if a
   NEW later blocker appears, file it (coordinator allocates the id if the
   scan is degraded) and record it; if `moduleInitRuns` flips to `true`,
   say so loudly — that un-gates #4628's integration step.
4. No regressions in scoped class/array-method runs (name the files run);
   builtin proto methods on derived instances still dispatch correctly.

## Notes

- Found by dev-5193 while validating PR #5252 (see its "Temporal harness"
  section). Blocker chain so far: #5191 (class value null) → #5193 (init
  marshalling window) → this.
- Id #5201 reserved with a degraded PR scan (gh offline); manually verified
  against all 18 open PR head branches on 2026-08-29. The
  `check:issue-ids:against-main` gate arbitrates.
