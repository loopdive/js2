---
id: 6488
title: "standalone: `x.toPrecision(p)` on a number PRIMITIVE through an `any` receiver throws `called value is not a function` — `__extern_method_call` has no number-primitive arm"
status: done
completed: 2026-09-14
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
goal: standalone-gap
parent: 5383
assignee: ttraenkler/s23-lane
created: 2026-09-14
---

## Problem

Under `--target standalone`, a method call on a **number primitive** whose
static type is `any` throws `TypeError: called value is not a function` for
every `Number.prototype` member, even though the member's native body exists and
the identical call on a statically-typed receiver works.

Measured on this branch's base — ONE standalone module, no polyfill, no link
(`.tmp/s23/c1.mjs` via `.tmp/s23/single.mjs`):

```js
(1234.5678).toPrecision(3)                       // "1.23e+3"       ✓
function f(x, p) { return x.toPrecision(p); }
f(1234.5678, 3)                                  // TypeError: called value is not a function
```

`__extern_method_call` dispatches `ref.test $Object` → resolve-and-apply, ELSE
the vec / closure-prop arms, ELSE `buildProtoNamedMethodMissArm`'s terminal
miss. A bare number primitive (`$box_number` / i31) is none of those three, so it
reaches the terminal, whose consult is the #4160/#4176 proto-index store — the
table of members a MODULE installed on a builtin prototype. The BUILTIN members
of `Number.prototype` are not in it, the consult answers null, and #4221's
absent-callee guard turns that into the TypeError.

This is the FOURTH distinct cause behind the `called value is not a function`
bucket in #5383's linked Temporal lane (S18 #6483 reverse method-call hop, S20
#6485 dynamic `new (<call>)`, S21 #6486 per-name ladder nominal guard). All
**nine** of the bucket's rows in the post-S22 sample fire this one cause, and
all nine reduce to the same missing member: the polyfill's exact-arithmetic
helper calls `n.toPrecision(k)` on a number primitive —

```js
var o = n.toPrecision(a);
return { div: r * Number.parseInt(o.slice(0, a - t), 10), … };
```

## Acceptance criteria

- `x.toPrecision(p)` through an `any` receiver answers the §21.1.3.5 result,
  including the no-argument, non-finite, negative, `e < -6` and `p` out-of-range
  (RangeError) cases.
- A member the module installed on `Number.prototype` still WINS over the
  builtin (§10.5 OrdinaryGet).
- `(5).nosuch()` still throws the §13.3.6.2 step-5 TypeError.
- No other receiver brand moves; the gc lane is byte-identical.

## Fix

`src/codegen/number-primitive-method-call.ts` (new): a `block` + `br_if 0` arm
unshifted onto `__extern_method_call`, in the `native-proto-method-call.ts` /
`ta-dyn-method-call.ts` shape.

1. `__typeof_number(recv)` — `ref.test $box_number ∨ ref.test i31`, so a Number
   WRAPPER never enters the arm and keeps the `$Object` route it already takes.
2. Decline (fall through) when the #4160/#4176 proto-index store answers for the
   name — that is the module's own `Number.prototype` write, and §10.5 says it
   outranks the builtin.
3. `__extern_get(%Number.prototype%, name)` on the identity-stable
   `$NativeProto` singleton; null ⇒ decline.
4. `__apply_closure(m, recv, args)` with the ORIGINAL primitive as `this`, which
   is what §21.1.3.5's `thisNumberValue` reads.

Three gates keep it off every module that does not need it: `ctx.standalone`, a
cached AST scan for a member CALL named `toPrecision`, and every delegate
resolving. A module with no such call compiles byte-identically — the 42-module
corpus moves 0 of 84 artifacts.

**Ordering is load-bearing in both directions**, and each half was measured
rather than reasoned:

- Built during the source scan, `buildLazyNativeProtoGetInstrs` finds no
  `__protoidx_companion` in `funcMap` yet, skips the companion mint, and the
  singleton's dynamic member reads all miss.
- Built AFTER `unshiftExternGetProtoMethodArm`, the brand is not in that pass's
  minted/seeded set, so `__extern_get` has no ladder entry. The first cut did
  exactly this: the arm was emitted, the receiver test passed (verified with a
  probe throw spliced into the arm), and resolution answered null on every
  call — a fix that measured as a complete no-op.

So the singleton is materialized in `prepareNumberPrimitiveMethodCallArm`,
called BETWEEN those two passes, and it also takes #4619's
`ensureWrapperProtoDynamicMember` mint: `__extern_get`'s `$NativeProto` ladder is
assembled from the brand's MINTED members, and a module that only CALLS
`x.toPrecision(p)` never names `Number.prototype.toPrecision`, so nothing else
mints it.

## Scope — `toPrecision` only, and the narrowness is measured

All three §21.1.3 numeric-format methods report `called value is not a function`
through an `any` receiver on the base. Widening the member list to `toFixed` /
`toExponential` was **tried and measured**: they resolve to
`ensureStandaloneNativeMethodClosure`'s `refusalBodyFallback` stand-in and the
call answers `"Number.prototype.toFixed is not yet implemented in --target
standalone"` — a different TypeError, not a working call. Only `toPrecision` has
a reflective native body (`number-proto-format.ts`, #5269 J-1). The other two are
left exactly as they are on the base; wiring their reflective bodies is a
separate slice.

`toString` is absent for the opposite reason: `x.toString()` through an `any`
receiver already answers correctly on the base. Its radix spelling
`x.toString(16)` does not, and is a separate residual.

## Residuals (measured on the new label, not fixed here)

| shape | base | new |
| --- | --- | --- |
| `x.toFixed(d)` / `x.toExponential(d)`, `any` receiver | TypeError | unchanged (no reflective body) |
| `x.toString(16)`, `any` receiver | TypeError | unchanged |
| `({toPrecision: f}).toPrecision(3)` — object-literal own method | TypeError | unchanged |
| `new Number(5); o.toPrecision = f; o.toPrecision(2)` — own slot shadowed by a same-named class method elsewhere in the module | wrong answer | unchanged |
| `"abc".toPrecision(3)` / `true.toPrecision(3)` | TypeError | unchanged |
