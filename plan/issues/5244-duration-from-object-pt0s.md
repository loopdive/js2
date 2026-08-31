---
id: 5244
title: "Temporal.Duration.from({days: 1}) answers 'PT0S' — object-form Duration construction loses every field, single-module"
status: done
completed: 2026-08-31
assignee: ttraenkler/senior-dev
sprint: current
priority: medium
horizon: s
goal: core-semantics
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-31
# The dynamic-`new` dispatch ladder gains the `__argc` publication the STATIC
# `new C(…)` site already had (~35 lines, one `if`). It has to live where the
# ladder's arms are built (`emitDynamicNewFallback`), because that is the only
# place that knows which class an arm dispatched to and what its formal count
# is — moving it out would mean re-deriving both.
#
# The `calls-closures.ts` entries are a STRANDED GRANT re-stated, not new
# growth: #5221 granted them and this branch stacks on #5221 → #5241 → #5242 →
# #5243, so CI's merge-preview diff attributes them here while the granting
# issue file is untouched by this PR. Re-stating is the documented remedy.
loc-budget-allow:
  - src/codegen/expressions/new-super.ts
  - src/codegen/expressions/calls-closures.ts
func-budget-allow:
  - src/codegen/expressions/new-super.ts::emitDynamicNewFallback
  - src/codegen/expressions/calls-closures.ts::tryExternClassMethodOnAny
---

# #5244 — `Duration.from(object)` drops all fields

## Problem

`Temporal.Duration.from({days: 1}).toString()` answers `"PT0S"` (a zero
duration) instead of `"P1D"`, single-module, measured by dev-5242b on both
sides of PR #5354 (pre-existing, unchanged by the constructor bridge).
`new Temporal.Duration(0, 0, 0, 1)` answers `"P1D"` correctly, so the loss is
in the `.from(object)` field-extraction path.

The issue was later widened (dev-5243, PR #5357) to "every constructor
argument after the first is lost through the class-value ctor mirror". Both
framings were symptoms; see the root causes below.

## Root cause — TWO independent defects, neither in `ToTemporalDuration`

Measured on the single-module Temporal lane (polyfill + probe concatenated
into ONE module, no provider, no linker), 2026-08-31.

### 1. The dynamic-`new` dispatch ladder never published `__argc`

`src/codegen/expressions/new-super.ts::emitDynamicNewFallback` lowers
`new <runtime class value>(…)` — the shape the polyfill's intrinsics registry
produces, `const t = ce("%Temporal.Duration%"); new t(…)` — into a
`ref.test`-per-class ladder whose arms coerce the pre-evaluated arguments and
`call <Class>_new` directly.

A constructor with parameter DEFAULTS (`constructor(years = 0, months = 0, …)`
— Temporal's `Duration`, ten of them) compiles to a prologue that consults the
mutable module global `__argc` to tell an omitted slot from a supplied one:

```wat
argc := __argc ; __argc := -1
if (argc != -1 && argc <= i) param_i := <default>
```

The STATIC `new C(…)` site publishes that count (`maybeSetArgcForKnownCall`);
the ladder's arms did not. `__argc` is a GLOBAL, so not writing it does not
mean "no defaults" — it means whatever the previously compiled call site left
there. A stale `1` makes the check fire for every parameter past the first, so
the arguments the arm had just coerced onto the stack were thrown away in
favour of the initializers.

That is why the defect looked order-dependent and why it did not reproduce in
a single-probe reduction: with `__argc` still at its `-1` sentinel the same
program is correct.

```js
// single-module Temporal lane, base
const t = ce("%Temporal.Duration%");
const x0 = 0, x3 = 1;
String(new t(x0, x0, x0, x3, x0, x0, x0, x0, x0, x0));  // "PT0S", want "P1D"
String(new t(0, 0, 0, 1, 0, 0, 0, 0, 0, 0));            // "P1D"  (literal args)
```

Fix: the ladder emits `global.set __argc` after the arguments and after
`new.target`, under the same admission `maybeSetArgcForKnownCall` uses
(`funcUsesArguments` ∪ `funcOptionalParams`), so every class without defaults
emits identical bytes. The runtime-argv variant clamps the runtime count to
the arm's formal count with a `select`.

This is the same root cause dev-5242 fixed for the HOST-side bridge in
`__class_construct_<Class>_<arity>` (commit `23bab6240c`, merged into this
branch). Two entry points, one global.

### 2. `__sset_<field>` trapped instead of falling through

`src/codegen/struct-field-exports.ts::buildSetterNestedIfElse` builds the
exported per-field setter as a `ref.test`-per-candidate chain. For a
collision-shaped (`$shape`, #2009) or class-tagged (`__tag`, #4618) candidate
it appended a refinement to the arm's condition with `i32.and`.

`i32.and` is a plain arithmetic operator — Wasm evaluates BOTH operands. The
refinement dereferences the receiver as that candidate (`ref.cast typeIdx`),
so the cast ran for every receiver, **including the ones `ref.test` had just
rejected**. That is an unconditional trap.

The trap surfaced nowhere, because the only caller is `_safeSet`, which
invokes the setter inside a `try`/`catch` labelled "not a field of this
struct's runtime type". So `__sset_<field>` aborted at its FIRST guarded arm
and never reached the arm that owned the receiver; the write landed in the JS
sidecar only, while a compiled `struct.get` kept reading the untouched slot.

Minimal reduction (no polyfill, no host, 4 lines):

```js
function other() { return { years: 0, months: 0, weeks: 0, days: 0 }; }
export function test() {
  other();                                                     // a SECOND record carrying `days`
  const K = ["days"];
  const n = { years: 0, months: 0, weeks: 0, days: 0, hours: 0 };
  const k = K[0];
  n[k] = 7;                                                    // computed write → __extern_set → __sset_days
  return String(n.days);                                       // base "0", want "7"
}
```

Drop `other()` and it passes — one record means no collision shape, so no
guard, so no trap. That is why the defect is invisible in every small
reduction and unavoidable in the polyfill, which carries dozens of records
with a `days` field. It is what made `Duration.from({days: 1})` read `PT0S`:
`ToTemporalDuration`'s `n[st[i]] = r[st[i]]` accumulation loop never reached
the record's slots.

Fix: the refinements move inside an `if (result i32)` gated on `ref.test`, so
a rejected candidate yields `0` and the chain continues to the next arm.

## What was NOT the cause (disproved, do not re-derive)

- `_denseOwnWasmArgs` / the trap's argument marshalling — the trap receives
  and forwards all ten arguments correctly, measured.
- Bridge arity mismatch — only `__class_construct_Duration_10` is emitted.
- The trap's `_wrapForHost` on the construct RESULT — replacing it with the
  raw instance changed nothing (A/B measured).
- The polyfill's slot `WeakMap` — `V.get(instance)` HITs for both a statically
  and a mirror-constructed `Duration`; the slot VALUES were the wrong thing.
- Member-set dispatch (`emitAlternateStructSetDispatch`) — the computed-key
  write never reaches it; it goes through `__extern_set_strict`.
- `#5243`'s `buildRecordFromExternref` — gated to `__anon_*`, never fires on
  a class instance.

### The "arity-independent first-call-wins latch" (dev-5243, `bc979fb1d4`)

dev-5243 characterised the bound-spelling symptom as a latch: a ten-argument
bound construct that itself answers `1…10` still poisons the NEXT ten-argument
bound construct of the same class down to `11,0,0,…`, so it could not be a
cache carrying the first call's arity, nor the `__call_fn_<N>` clamp, nor the
`__construct_closure` struct route — and, they concluded, not ambient `__argc`
either, because a ten-argument interposer leaving `__argc` at 10 did not repair
it.

That last elimination does not hold: an interposer only leaves `__argc` at 10
if `maybeSetArgcForKnownCall` fires for the interposer's own callee, which it
does only for a callee with optionals or `arguments`. The observed behaviour is
the stale-global one — "first call wins, degraded to exactly arity 1" is what a
global pinned by whatever ran before looks like from the outside.

Measured here, on this branch and on the reverted base: the ladder publishing
`__argc` FIXES exactly that symptom in the polyfill —
`Duration.from(new Duration(0,0,0,1))` moves `"PT0S"` → `"P1D"`, and so does
the hand-inlined `new t(re(e,Y), …, re(e,U))` head of `ToTemporalDuration`.
The synthetic two-construct reduction (`.tmp/probe-latch.mts`: three ten-arg
bound constructs of one class in sequence) answers `1…10 | 11…20 | 21…30`
correctly on BOTH sides, i.e. it does not reproduce the latch at all — which is
the same reduction gap recorded above.

## Acceptance criteria

1. `Temporal.Duration.from({days: 1}).toString()` → `"P1D"`; several field
   combinations covered; test failing on base. ✔
2. No regressions in the issue-5221…5243 family. Gates green. ✔

## Measurements — single-module Temporal lane

| probe | base (this branch's merge-base) | after |
| --- | --- | --- |
| `Duration.from({days:1})` | `"PT0S"` | `"P1D"` |
| `Duration.from("P1D")` | `"PT0S"` | `"P1D"` |
| `Duration.from(new Duration(0,0,0,1))` | `"PT0S"` | `"P1D"` |
| `PlainDate.from("2020-03-04").add({days:1})` | `"2020-03-04"` | `"2020-03-05"` |
| `…​.add("P1D")` | `"2020-03-04"` | `"2020-03-05"` |
| `…​.subtract({days:1})` | `"2020-03-04"` | `"2020-03-03"` |
| `…​.add({months:2})` | `"2020-03-04"` | `"2020-05-04"` |
| `…​.until(…)` / `…​.since(…)` | THREW | `"P1D"` |
| `…​.with({year:2021})` | `"2021-03-04"` | `"2021-03-04"` (control) |
| `new Temporal.Duration(0,0,0,1)` | `"P1D"` | `"P1D"` (control) |
| `PlainDate.from("2020-03-04")` | `"2020-03-04"` | `"2020-03-04"` (control) |

## Reported, NOT fixed

- `Temporal.Duration.from({hours:25}).total({unit:"hours"})` and `.round(…)`
  still throw a `WebAssembly.Exception`, single-module, unchanged on both
  sides. Not triaged.
- `Temporal.Now.plainDateISO()` / `Now.timeZoneId()` — unchanged, owned by
  #5221 / #5206 respectively.
- The PROVIDER lane's object-argument rows stay #5225's; this change does not
  move them.

## Notes

- Found by dev-5242b (PR #5354), widened by dev-5243 (PR #5357).
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-31.
