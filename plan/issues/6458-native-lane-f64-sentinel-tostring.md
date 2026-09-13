---
id: 6458
title: "The f64 absence sentinel still stringifies as `\"NaN\"` in the native-strings and standalone lanes"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

[#6423](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6423-absent-number-property-stringifies-as-nan)
fixed ToString of an UNDEF-SENTINEL-branded f64 — `String(o.absentNumberProp)`
printing `"NaN"` instead of `"undefined"` — but the helper it added,
`emitNumberToStringSentinelAware` (`src/codegen/coercion-engine.ts`), is
**js-host-only by construction**. In `standalone` / `wasi` /
`native-strings-host` it returns the plain `call number_toString`, exactly as
before.

That was a deliberate, evidence-driven narrowing, not an oversight — see the
`## Resolution` on #6423. The first cut also routed `compileNativeConcatOperand`
and the native template span through the helper; the merge group then breached
the standalone host-free pass floor (#2097) at `pass=35567, mark=35686,
delta=-119`, attribution was ambiguous, and the js-host gate is what made the
question answerable (standalone binaries became byte-identical to the parent,
verified by hash).

## Why this is not simply "apply the same patch to two more arms"

The native lanes have branded-f64 producers the js-host lane does not, and they
are *common*:

* `for-of` over a numeric vec yields `{kind: "f64", undefSentinel: true}` —
  `src/codegen/statements/loops.ts` ~L1987, `readElemType`.
* Native generator IteratorResult `value` reads carry the same brand —
  `src/codegen/generators-native-consumer.ts` ~L1168.

So in those lanes the brand does **not** mean "an absent property"; it means
"this slot may hold `undefined`", and an ordinary `for (const x of [1,2,3])
s += x` flows through the same arms. Any fix has to keep those printing `"1"`,
not `"undefined"` — the sentinel test is a value test, so it is correct in
principle, but the blast radius is the whole numeric-vec iteration path rather
than one property read.

There is a second, mechanical hazard specific to these lanes: the helper's
`then` arm pushes `stringConstantExternrefInstrs(ctx, "undefined")`, which in
native-strings mode materialises a `$NativeString` and widens it with
`extern.convert_any`, and the caller's tail immediately does
`any.convert_extern; ref.cast $AnyString` (`emitNativeStringRefFromExternref`).
Whether that round trip is exact — `$NativeString` vs `$AnyString` — was never
measured. `nativeStringLiteralInstrs` can also emit a `call` to a materialiser
function, which is a mid-body function-index dependency the js-host arm does not
have.

## Acceptance criteria

1. `String(o.p)` / `` `${o.p}` `` / `o.p + ""` answer `"undefined"` for a
   genuinely-absent number-shaped slot in the standalone and native-strings
   lanes, matching the js-host behaviour #6423 landed.
2. Anti-vacuity, and this is the risk: `for (const x of [1, 2, 3]) s += x` still
   produces `"123"`, a native generator's non-terminal `value` still
   stringifies as its number, and a genuine `NaN` still prints `"NaN"`.
3. **A standalone test262 measurement, not a dogfood one.** The 17-suite dogfood
   A/B is entirely js-host (`target: "gc"`) and is structurally blind to this
   change; the gate that catches it is the standalone host-free pass floor
   (#2097), which only runs in the `merge_group` shard matrix. Record the
   standalone pass count before and after.
4. Regression test failing on the parent and passing with the fix, exact counts
   both ways, in the standalone lane.

## Notes

Whether this is worth doing at all is a fair question to answer first: the
defect's only measured impact is through the dynamic `__extern_get` property
read, which is a js-host construct. If no standalone/native path can produce a
genuinely-absent number-shaped read, criterion 1 is unreachable and the right
outcome is `wont-fix` with that reasoning recorded — which is itself worth
establishing, since the asymmetry is currently undocumented anywhere but the
helper's doc comment.
