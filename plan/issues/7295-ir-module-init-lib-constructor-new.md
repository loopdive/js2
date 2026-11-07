---
id: 7295
title: "IR module-init: admit new <LibBuiltin>(…) (String/Number/Boolean/Object/Array) — measured, 0 yield"
status: blocked
sprint: current
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: investigation
area: ir
goal: ir-full-coverage
related: [6583, 7281, 7106, 4208]
assignee: "ttraenkler/c-lane-opus"
---

# #7295 — IR module-init: `new <LibBuiltin>(…)`

## Problem

On the wrapped stride-40 standalone ledger, 23 files have a single legacy unit,
the test `<module-init>`, refused as `constructor-resolution-unsupported`. The
target was the lib-constructor subset: `new String/Number/Boolean(x)`,
`new Object()` / `new Object(x)` and `new Array(…)` with an unshadowed lib
constructor. Out of scope: `new Proxy`, `new (Async)DisposableStack`, script
constructors (`new foo()`, `new Palette()`) and class expressions.

## Measurement (step 1, 2026-11-07, main b83a8ee0)

Every one of the 23 files refuses at the same arm,
`expr-new-ctor-unknown` (`phase1NewExpression`, `src/ir/select.ts`). The arm
fires because none of these names is a local class or an `isKnownExternClass`
entry. In scope after excluding Proxy ×6, DisposableStack ×2 and the two
script constructors: **14 files**.

The wrapper machinery already exists on both sides:

- from-ast `lowerPrimitiveWrapperConstruction` lowers `new String/Number/Boolean(x)`
  (one exact primitive argument) to `__new_<Kind>(arg)`. The result is typed
  `extern:Object`.
- the selector's `selectorPrimitiveWrapperConstruction` admits that shape, but
  only as an operand of a ToPrimitive operator (`+`, loose equality, numeric
  readers, #4208 S4 / #7106). Wrapper identity comparison is refused
  (`expr-wrapper-equality`).

**Probe.** A throwaway selector change admitted the from-ast wrapper shape
anywhere in `phase1NewExpression`. Every file still has a legacy
`<module-init>` afterwards, each at a different next refusal:

| file | next refusal after admitting the wrapper |
| --- | --- |
| `JSON/stringify/value-number-object.js` | `vardecl-let-closure` (function expression) |
| `Object/create/15.2.3.5-4-116.js` | `expr-ident-not-in-scope` `Object` |
| `Object/getPrototypeOf/15.2.3.2-2-23.js` | `expr-ident-not-in-scope` `Object` |
| `RegExp/prototype/exec/S15.10.6.2_A2_T5.js` | `expr-ident-not-in-scope` `RegExp` |
| `String/prototype/charCodeAt/S15.5.4.5_A1_T6.js` | `throw-module-scalar-unboxed` (dynamic `var x`, #7281's out-of-scope case), then a method call on the wrapper |
| `String/prototype/concat/S15.5.4.6_A1_T6.js` | same |
| `String/prototype/split/argument-is-regexp-…-abc.js` | `regexp-constructor-unsupported` |
| `String/prototype/split/call-split-hello-…-hello.js` | `vardecl-module-storage-unrepresentable` (`__split = __string.split(…)`) |
| `String/prototype/substring/S15.5.4.15_A2_T6.js` | `expr-module-scalar-method` (`__string.substring(…)`) |
| `String/S15.5.5.1_A4_T1.js` | `condition-module-value-nonbool` (`!__str__instance.hasOwnProperty(…)`), then `with` |

The `Object` / `Array` files (`Object/S15.2.1.1_A1_T3`, `Object/S15.2.2.1_A5_T4`,
`strict-does-not-equals/S11.9.5_A7`) need a `new Object(v)` lowering. That is
ToObject over an arbitrary value. Legacy builds it inline through
`emitObjectCoercion` (`src/codegen/expressions/calls-guards.ts:662`, reached
from `new-builtin-globals.ts:1201`), so there is no callable runtime helper the
IR could call. `S11.9.5_A7` also compares wrappers by identity (`!==`), which
the selector refuses on purpose (`expr-wrapper-equality`).

**Expected zero-legacy delta of the bounded admission: 0.**

## Conclusion — stopped at step 1 (per the brief)

Each file needs at least one further piece:

1. **Wrapper values as general extern objects.** Storage in a script var,
   methods called on a wrapper receiver (`.substring`, `.split`,
   `.hasOwnProperty`, `.charCodeAt`), and identity comparison. These are new
   `extern:Object` receiver paths, not a constructor-admission arm.
2. **`new Object(v)`.** A ToObject lowering, which first needs legacy's
   inline `emitObjectCoercion` extracted into a callable helper.
3. **Unrelated blockers:** `Object` / `RegExp` as identifiers, function
   expressions, the RegExp constructor, and the dynamic-binding throw (#7281
   follow-up).

None of these moves a file alone, so the constructor arm should not land on
its own: it would add selector surface for zero claimed units.

Suggested follow-ups, in order of reach (not filed):

- (1) as its own issue: wrapper `extern:Object` values through the existing
  extern receiver arms;
- (2) as a legacy helper extraction (`__to_object`) that both paths call.

## Implementation Plan

None for this id. The measurement above is the deliverable. Quality criterion
(had it gone ahead): one parameterised arm keyed by constructor brand, next to
`selectorPrimitiveWrapperConstruction`, with no second wrapper recognizer.
