---
id: 6640
title: "standalone: `class S extends <linked-provider class>` has NO real inheritance at all — no super()-threaded construction, no inherited method dispatch, no instanceof — root-causing the PlainDate/PlainDateTime `compare` use-internal-slots pair"
status: blocked
sprint: current
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
goal: standalone-gap
parent: 5383
requested_by: ttraenkler/senior-dev
# (#5383 S64, 2026-09-19) This slice adds a capability that did not exist on the
# standalone lane at all: `super(...)` through a linked-provider parent, plus the
# synthesized derived constructor and the heritage-arm recording that feed it.
# The three grown functions are the three existing decision points the new arm
# must be spliced into — `collectClassDeclaration` (heritage classification),
# `compileClassBodiesInner` (synthesized derived ctor) and `compileSuperCall`
# (explicit `super`). Splitting any of them is a refactor of long-standing code
# this change does not otherwise touch, and would make the diff harder, not
# easier, to review against the measurements in `## S64`.
func-budget-allow:
  - src/codegen/class-bodies.ts::collectClassDeclaration
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/class-bodies.ts::compileSuperCall
---

# #6640 — standalone `extends` across the provider link is unimplemented, not just buggy

## Target (S56 dispatch)

`test/built-ins/Temporal/PlainDate/compare/use-internal-slots.js` and the
`PlainDateTime` sibling. Both `class AvoidGetters(Date|DateTime) extends
Temporal.Plain(Date|DateTime) { get year() { throw new CustomError(); } ... }`
then assert `compare(one, two)` ignores the getters (uses internal slots).
Both fail on `aec4fe5ba2` (S54 head) with an uncaught non-`Error` object
(`String(e) === "[object Object]"`).

## Root cause (fully reduced, real provider, no speculation)

`class-bodies.ts::collectClassDeclaration`'s heritage-detection loop only
wires up a real parent (`parentClassName`/`parentStructTypeIdx`,
`classParentMap`) for an `Identifier` or `ClassExpression` heritage
expression that resolves to a LOCAL class declaration. A property-access
heritage into a linked provider namespace — `class S extends Temporal.PlainDate
{}`, exactly this test's shape — falls into the standalone/wasi `else` arm
that ONLY marks `ctx.classDynamicUnresolvedHeritageSet.add(className)` (added
by #6623/S36, for a narrower `getPrototypeOf` false-positive fix). No
construction, method-dispatch, or brand-check machinery exists for this shape
at all under `--target standalone`/`wasi` — the comment at that call site
says so explicitly ("has NO standalone/wasi handling at all").

Consequence, confirmed by direct probes against the real
`@js-temporal/polyfill` provider (`.tmp/s56/repro3.js`, `JS2WASM_TEMPORAL_CACHE=s56-1`):

```js
class AvoidGettersDate extends Temporal.PlainDate {}
const one = new AvoidGettersDate(2000, 5, 2);
one.toString()   // "[object Object]" — NOT the inherited PlainDate.prototype.toString
one.year         // undefined — NOT even a throw; the getter never fires, plain miss
Temporal.PlainDate.compare(new Temporal.PlainDate(2000,5,2), one)  // throws, e.constructor undefined
```

`AvoidGettersDate` compiles as a **fully independent root struct** with no
compiled relationship to `Temporal.PlainDate` whatsoever:

- `super(2000, 5, 2)` does not thread through to the provider's real
  `PlainDate` constructor — no internal ISO-date slot is ever installed
  (WeakMap-keyed or otherwise) for `one`.
- Method lookup does not walk up to `Temporal.PlainDate.prototype` — `one`
  has no inherited methods at all; `one.toString()` falls through to the
  generic `Object.prototype.toString`-shaped default (`"[object Object]"`).
- `one instanceof Temporal.PlainDate` is `false` (separately confirmed,
  `.tmp/s56/repro2.js`): `Object.getPrototypeOf(AvoidGettersDate) ===
  Temporal.PlainDate` is `false`, `Object.getPrototypeOf(AvoidGettersDate.prototype)
  === Temporal.PlainDate.prototype` is `false`. (`Object.getPrototypeOf(one)
  === AvoidGettersDate.prototype` IS `true` — the LOCAL, single-module part of
  class construction is fine; only the cross-module LINK is missing.)

The polyfill's `compare()` internally brand-checks its arguments (directly or
via `ToTemporalDate`'s "already a PlainDate" fast path) and, finding `one`
unrecognized, falls back to property-bag coercion — reading `.year`/`.month`/
`.day`, which the test's overridden getters throw from. The thrown
`CustomError` (a plain function, no `Error` prototype) propagates uncaught and
renders as `[object Object]` when the harness stringifies it. This is a
downstream SYMPTOM of the missing link, not a separate bug in `compare()` or
in `instanceof`'s dispatch (`compileInstanceOf`/`collectInstanceOfTags` in
`typeof-delete.ts` are working exactly as designed against the
`classParentMap`/`classTagMap` they are handed — those maps simply never
receive an entry for this heritage shape).

## Why this is bigger than an instanceof fix

Fixing only `instanceof` (e.g. by teaching `collectInstanceOfTags` to treat an
unresolved-heritage class as compatible with its resolved linked-provider name)
would make `one instanceof Temporal.PlainDate` answer `true` while `one` STILL
carries no real internal date slots and STILL has no working inherited
methods — the polyfill's `compare()` would then take its "already a
PlainDate" fast path and read `one`'s (nonexistent) internal fields, most
likely trapping or reading garbage rather than throwing the informative
`CustomError` it does today. A point-fix at the `instanceof` site would very
plausibly turn a clean, easily-diagnosed test262 `fail` into a `compile_error`
or a WasmGC trap — a worse regression than the status quo, in a family (`class
… extends <linked>`) already flagged as architecturally fragile by #6623's own
"Traps" section.

A real fix needs, at minimum:

1. **`super(...)` must construct through the provider's actual constructor**
   for the linked base, with `new.target` correctly identifying the LOCAL
   subclass (so the provider's own `NewTarget`-based prototype selection, if
   any, still resolves to `AvoidGettersDate.prototype`) — i.e. a standalone
   analogue of the JS-host `hasDynamicHostParent`/extern-class-parent path
   (`class-bodies.ts` L1120-1141), which is explicitly gated OFF for
   standalone/wasi today.
2. **Method dispatch must walk into the provider's real prototype object**
   for any member `AvoidGettersDate` does not itself declare — a
   cross-module `[[Prototype]]` chain that is presently nonexistent for this
   shape (confirmed above: `Object.getPrototypeOf(AvoidGettersDate.prototype)
   !== Temporal.PlainDate.prototype`).
3. **`instanceof`/brand-check compatibility**, once (1) and (2) exist to make
   it a TRUE statement rather than a compile-time convenience.

(1) and (2) are the actual load-bearing gap; #6623's own "Residual" section
already named a narrower, ADJACENT third mechanism (a `getPrototypeOf`
boundary-terminal fall-through gap for values returned from a method call on
an unresolved-heritage receiver) as out of scope for its own slice, for the
same reason: it needs its own synthetic-probe budget and is a different
mechanism than what that slice fixed. This issue's gap is one layer more
fundamental than that one — #6623 assumed a receiver whose STRUCTURE at least
resembles the linked class; here the receiver never gets a real Wasm-level
tie to the provider at all.

## Reduction artifacts

- `.tmp/s56/repro1.js` — `assert.sameValue(one instanceof Temporal.PlainDate, true)` fails (`false` vs `true`), isolates the brand-check symptom.
- `.tmp/s56/repro2.js` — full prototype-chain dump: confirms the LOCAL half of construction is correct (`Object.getPrototypeOf(one) === AvoidGettersDate.prototype` = `true`, `one.constructor === AvoidGettersDate` = `true`) and the CROSS-MODULE half is entirely absent (both static and prototype `[[Prototype]]` links to the provider read `false`).
- `.tmp/s56/repro3.js` — confirms no inherited method dispatch (`toString` gives the generic default, not the provider's) and no internal-slot construction (`one.year` is `undefined`, not a getter throw — the getter override itself never gets exercised on the direct-property-read arm, only inside `compare()`'s internal coercion path).
- Root-cause site: `src/codegen/class-bodies.ts`, `collectClassDeclaration`, the property-access/`else` heritage arm (~L1160), comment block "(#6623, #5383 S36)".
- Downstream consumers reading the (empty) `classParentMap`/`classTagMap` entries: `src/codegen/typeof-delete.ts::compileInstanceOf`/`collectInstanceOfTags` (confirmed NOT the bug — correctly report `false`/no-tag for a class genuinely unlinked).

## Why parked rather than attempted here

S56's dispatch budget (~2.5h tool time) is sized for a point defect, not a new
cross-module construction/dispatch capability. The fix surface here overlaps
directly with #6623's own explicitly-deferred residual (same file, same
heritage arm, same "no standalone handling at all" gap) and — per that
issue's own "Traps" section — this general area has already produced one
false-positive regression from an incomplete first attempt (the field-less
tag-collision bug #6623 itself fixed). A speculative narrow fix risks
trading a clean `fail` (informative `CustomError` propagation) for a WasmGC
trap or `compile_error` on this and any other test that constructs a
subclass of a linked provider class and then calls an inherited method or a
static method that brand-checks it — a MUCH larger blast radius than the two
target rows (Temporal ships dozens of `subclassing-ignored.js` /
`compare/*` / `equals/*` files with the identical `extends
Temporal.PlainXxx` shape).

## Suggested follow-up scope (for whoever picks this up)

Design + implement the standalone analogue of the JS-host
`hasDynamicHostParent`/extern-class-parent construction path
(`class-bodies.ts` L1120-1141) for a property-access heritage that resolves
to a LINKED PROVIDER class: a real `super(...)` → provider-constructor call,
a cross-module `[[Prototype]]` chain for both the constructor object and its
`.prototype`, and instance method dispatch that falls through to the
provider's prototype methods. This is the same shape #6623's Residual
section already flagged as a third, unreduced mechanism — worth scoping
together rather than as two separate slices, since both live in exactly this
heritage arm.
