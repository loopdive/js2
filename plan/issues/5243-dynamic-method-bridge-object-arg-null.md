---
id: 5243
title: "An object argument through the dynamic method bridge arrives as null — ISO calendar dateAdd's destructuring parameter throws 'Cannot destructure null or undefined'; blocks all Temporal arithmetic single-module"
status: done
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: max
requested_by: ttraenkler/fable-lead
assignee: ttraenkler/senior-dev-5243
created: 2026-08-31
completed: 2026-08-31
# Growth allowance for the record materializer + its rationale comment in
# src/codegen/type-coercion.ts, and for the new regression test. The materializer
# is the general fix for "a failed shape test must never silently coerce to
# null" (see ## Root cause); it cannot be expressed more compactly without
# dropping either the shape gate or the null/undefined preservation, both of
# which are load-bearing.
# The record materializer unboxes a numeric field it just read off the host
# object (`__extern_get` → `__unbox_number`), which is +2 occurrences in
# type-coercion.ts. It cannot be routed "through the coercion engine": this IS
# the coercion engine's externref→struct arm, and the two occurrences are the
# import registration plus the post-flush name re-resolution the shift
# discipline requires. Identical vocabulary to the tuple materializer 1,300
# lines above it.
coercion-sites-allow:
  - src/codegen/type-coercion.ts
loc-budget-allow:
  - src/codegen/type-coercion.ts
  - tests/issue-5243-bridge-object-arg-null.test.ts
  - tests/dogfood/temporal-global-harness.mjs
  - tests/issue-4628-temporal-global.test.ts
---

# #5243 — dynamic method bridge nulls an object argument

## Problem

After #5242 (PR #5354) gave class values a constructor bridge, every
single-module Temporal arithmetic row (`add`/`subtract`, object or string
argument) lands on `TypeError: Cannot destructure 'null' or 'undefined'`,
thrown by the ISO calendar's
`dateAdd(e, {years = 0, months = 0, weeks = 0, days = 0}, i)` — its second
argument arrives **null** through the dynamic method bridge chain
`__extern_method_call` → `__call_fn_method_3` → `__anon_0_dateAdd`.

Control (dev-5242b): `add({days: 1})` constructs no Duration at all and fails
with the same message and a byte-identical stack on #5354's base — so this is
an argument-marshalling gap on the dynamic METHOD bridge, pre-existing and
independent of the constructor path. Adjacent to #5221's through-line (a
slot/shape mismatch silently coerced to null) and to #5221 defect 6 (call-site
specialisation of forwarding params).

## Direction

Reduce non-Temporal: a method with a destructuring-with-defaults object
parameter, called through the dynamic bridge (`any` receiver / 3-arg
`__call_fn_method_3` shape) with a real object argument. Establish where the
null appears: the bridge's argument coercion (`callArgCoercionInstrs` family),
the `__anon_*` specialised param type rejecting the shape (ref.test →
ref.null), or the method-3 dispatcher's marshalling. Fix at the general site;
never let a failed shape test coerce to null silently.

## Acceptance criteria

1. Non-Temporal reduction answers correctly; `tests/issue-5243-*.test.ts`
   failing on base with controls.
2. Single-module: `Temporal.PlainDate.from("2020-03-04").add({days:1}).toString()`
   → `"2020-03-05"`, `.subtract({days:1})` → `"2020-03-03"`. Update harness
   KNOWN_GAPS/SUPPORTED honestly; provider lane may stay blocked by #5225.
3. No regressions in the issue-5221…5242 family + linker family; equivalence
   gate at baseline. Gates green.

## Notes

- Found by dev-5242b (PR #5354 "Reported, NOT fixed" item 1) with control.
  This is now THE single-module blocker for Temporal arithmetic conformance.
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-31.

## Root cause (measured 2026-08-31, base = `origin/issue-5242-class-value-ctor-bridge` @ 93972f5691)

**The dynamic method bridge was the messenger, not the cause.** The argument was
already `null` before it reached `__extern_method_call` — proved by logging the
host-side arg list at the dispatch point: `dateAdd nargs=3 object,object:null,string`.

The null is minted in `coerceType`'s `externref → ref/ref_null` arm
(`src/codegen/type-coercion.ts`). An object literal with a **spread** has no
statically closed shape, so `objectLiteralSpreadTakesHostPath` builds it on the
HOST and hands back an `externref`; the enclosing function's **inferred** type
is nevertheless the concrete `__anon_*` record struct. The two meet in that arm,
its `ref.test` fails (a host object is not a WasmGC struct), and the fallback
was a bare `ref.null` — a silently wrong value whose failure surfaces wherever
it is next used.

In `@js-temporal/polyfill` that is exactly

```js
function Wr(e) { const t = qr(e), n = …; return { ...t.date, days: n }; }
```

whose inferred return type is `__anon_37 {days:f64, years:externref,
months:externref, weeks:externref}`. `Wr`'s null then travels as the second
argument of `calendar.dateAdd(date, duration, options)` and detonates in the ISO
calendar's destructuring parameter.

Non-Temporal reduction (`tests/issue-5243-bridge-object-arg-null.test.ts`), base
vs after:

| probe | base | after |
| --- | --- | --- |
| `spreadIsObject` — read the record, call nothing | `"NULL"` | `"3/1"` |
| `spreadIsObject2` — a DIFFERENT caller shape | `"NULL"` | `"5/4"` |
| `viaBridge` — dynamic 3-arg method call | THREW `Cannot destructure 'null' or 'undefined'` | `"D\|1,2,0,3\|constrain"` |
| `viaBridgeOtherShape` — same forwarding param, other shape | same throw | `"T\|0,0,0,5\|reject"` |
| `viaDirect` — statically resolved call, the CONTROL | same throw | `"D\|1,2,0,3\|constrain"` |

The `viaDirect` row is why the fix is not in the bridge: with no dynamic
dispatch at all, base fails identically.

## Fix

`buildRecordFromExternref` in `src/codegen/type-coercion.ts`: when the target is
a compiler-minted anonymous record shape, rebuild it from the host object's own
properties by name (`__extern_get`) instead of pushing `ref.null`. Deliberately
narrow — `__anon_*` only, no supertype, ≤32 fields, ordinary property names, no
erased type brands, no non-nullable `ref` field, host targets only. Everything
else keeps today's null.

Two semantics stated because they are not free:

- **null / undefined / a non-object stay `ref.null`** (guarded by
  `__extern_is_object`) so `RequireObjectCoercible` still throws in the callee's
  destructure guard. Fabricating a zero-filled record out of `undefined` would
  hide a real spec error.
- **The result is a COPY** — writes through it do not reach the host object.
  That is the same trade the vec (#2831) and tuple (#1161) materializers next
  door already make, against a `null` that supports no read at all.

## Temporal, measured with a fresh `JS2WASM_TEMPORAL_CACHE` per lane

| lane / row | base | after |
| --- | --- | --- |
| provider `add("P1D")` | THREW `Cannot destructure 'null' or 'undefined'` | **`"2020-03-05"`** — promoted to the harness's asserted `SUPPORTED` set as `arithmeticAddString` |
| provider `add({days:1})` / `subtract` / `with` | `WebAssembly.Exception` | unchanged — #5225's object-literal-across-the-seam lane |
| single-module `add({days:1})` / `subtract({days:1})` / `add("P1D")` | THREW the destructure null | no longer throws; answers `"2020-03-04"` (unchanged date) — see below |
| single-module `with({year:2021})` | `"2021-03-04"` | `"2021-03-04"` |
| single-module `new Duration(0,0,0,1)` | `"P1D"` | `"P1D"` |

## Reported, NOT fixed — #5244's root cause, now localized

The single-module arithmetic rows stop throwing but answer the unchanged date
because a **second, independent** defect owns them: `sn(e)`
(ToTemporalDuration) constructs through the intrinsics registry,
`new (ce("%Temporal.Duration%"))(…)` — #5242's class-VALUE constructor mirror —
and every constructor argument after the first is lost. Measured on one build:

| observation | result |
| --- | --- |
| mirror `[[Construct]]` trap receives | `args=10 [0,0,0,1,0,0,0,0,0,0]`, `bridgeArity=10` — correct |
| `instance.exports.__class_construct_Duration_10(11,…,20)` called DIRECTLY from JS, read back through Wasm | `11,12,13,14,15` — **correct** |
| the instance that same trap hands back to Wasm | `11,0,0,0,0,0,0,0,0,0` |
| control: `new Temporal.Duration(11,…,20)` (statically resolved, no mirror) | `11,12,…,20` |

So the emitted bridge is correct and the trap's inputs are correct; the loss is
between the trap's `ctorBridge.fn(…)` result and what the Wasm caller observes.
Two hypotheses were tested and **disproved**: it is not `__argc` default-param
plumbing (forcing `__argc = params.length` in the bridge changed nothing), and
it is not a bridge-arity mismatch (only `__class_construct_Duration_10` exists).
Left for #5244.
