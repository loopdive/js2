---
id: 3240
title: "Standalone: faithful native constructors for the remaining subclass-builtins (Array/Function/Date/RegExp/ArrayBuffer/DataView/Promise)"
status: ready
sprint: current
priority: medium
horizon: l
feasibility: hard
model: fable
goal: standalone-mode
umbrella: 1781
related: [3238, 3239, 56, 3053]
---

## Problem

Tracking issue for the **remaining** `__new_*` subclass-builtins host-import
leaks in `--target standalone`, after the cheap slices landed:

- #3238 — `Object` (native `__new_plain_object`) ✓
- Error family incl. `AggregateError` — already host-free via
  `emitWasiErrorConstructor` (`isWasiErrorName`) ✓
- #3239 — TypedArrays (11) + `SharedArrayBuffer` (identity-only empty vec) ✓

What is left leaks a distinct `env::__new_<Parent>` host import for:

| Parent        | flips | passing behavior tests in standalone today                     |
| ------------- | ----- | -------------------------------------------------------------- |
| `Array`       | 3     | `regular-subclassing`, `contructor-calls-super-single-argument` |
| `Function`    | 3     | `instance-length`, `instance-name`, `super-must-be-called`     |
| `Date`        | 3     | `regular-subclassing`, `super-must-be-called`                  |
| `RegExp`      | 4     | `this-subclass-constructor`, `regular-subclassing`, `lastIndex`|
| `ArrayBuffer` | 2     | `arg-is-dataview-subclass-instance`, `super-must-be-called`    |
| `DataView`    | 1     | (super-must-be-called family)                                  |
| `Promise`     | 1     | `regular-subclassing`, species-constructor count tests         |

≈17 host-free flips.

## Why these are HARD (real regression surface) — cannot use the #3239 shortcut

The #3238/#3239 approach is **identity-only**: it drops the constructor args
and returns an empty native object/vec, safe *only* because no subclass
*behavior* test passes for those parents. That does NOT hold here.

Measured from the standalone baseline: each parent above has **PASSING behavior
tests** that are currently leaky-passing via the host shim providing a real
JS parent instance. The subclass forwarder DOES pass the ctor args to
`__new_<Parent>` (arity observes `new Sub(n)` call sites —
`getObservedClassNewArity`), so a naive args-ignoring native ctor would replace
the shim's faithful instance with an empty one and **regress those leaky
passes** (e.g. `class Sub extends Array {}; new Sub(5).length` must be `5`, not
`0`). Each therefore needs a **faithful arg-honoring native constructor**.

## Per-builtin substrate notes (from the #3239 measurement)

Plain (non-subclass) `new <Parent>(...)` is ALREADY native/host-free for all of
these (verified) — the native construction machinery exists in
`src/codegen/expressions/new-super.ts`. The work is to expose it as an in-module
`__new_<Parent>` defined-func returning externref (the #3238 pattern) that
honors the forwarded args, and to route the two `class-bodies.ts` builtin-parent
sites to it (gated `ctx.standalone || ctx.wasi`, like #3238/#3239).

- **Array** (highest value): needs real **argc plumbing** — `new Array(5)`
  (length 5) vs `new Array(1,2,3)` (elements) is distinguished by the *call-site
  arg count*, not the fixed forwarder param count (`__argc`). Replicate the
  0 / 1-numeric-with-RangeError / n-element logic from new-super.ts
  (`new Array()` path ~L5537–5700). Do first, its own PR.
- **ArrayBuffer / DataView**: single numeric `byteLength` (+ buffer/offset for
  DataView) — no variadic ambiguity; unbox arg, build the i8-byte vec
  (new-super.ts ~L5078+). DataView depends on an ArrayBuffer arg.
- **Date**: `new Date()` = current time — needs a clock; check whether
  standalone `Date.now()` is host-free first (may inherently need host time →
  may not be flippable). `super(v)` from value is simpler.
- **RegExp**: pattern+flags → native regex compile (dual backend #682); heavier.
- **Function**: subclass instance must be `instanceof Function` (a closure) and
  carry `.length`/`.name` — needs a closure-shaped native instance; heaviest.
- **Promise**: `super(executor)` — native Promise carrier (#2867 area).

## Approach

- **ONE builtin (or tight family) per PR.** Start with **Array** (own issue).
- For each: verify NO behavior-test regression on a **scoped local standalone
  sweep** BEFORE pushing (compile+run the parent's `subclass/builtin-objects/*`
  tests). The `merge_group` standalone floor is the authoritative hard gate.
- Gate every new branch on `ctx.standalone || ctx.wasi` (gc/host byte-identical).
- Route through a faithful native `__new_<Parent>` in `object-runtime.ts` /
  `new-super.ts`, mirroring `emitStandaloneObjectConstructor` (#3238) /
  `emitStandaloneVecBuiltinConstructor` (#3239).

## Acceptance

- Per-builtin PRs flip the `subclass-<Parent>` tests host-free with **no
  standalone-floor regression** (behavior tests preserved).
- Recommend a senior-dev (Opus) per slice given the regression surface.
