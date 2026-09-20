---
id: 6644
title: "standalone: a class extending a LINKED provider class inherits no statics, has no [[Prototype]] link to its parent class object, and `instanceof` across the link answers `false` even for a directly-constructed provider instance"
status: in-progress
sprint: current
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
goal: standalone
parent: 5383
requested_by: ttraenkler/fable-lead
created: 2026-09-19
# (#5383 S66, 2026-09-19) Grants restated HERE rather than left to #5383/#6640:
# CI diffs the MERGE PREVIEW against `main`, where neither grant covers these
# paths (the stranded-grant class). All growth below is this change-set's own,
# measured at the branch base 930ab332f4.
#
# +6 LOC / +5 function LOC in `call-namespace-static.ts` is the ENTIRE
# call-site splice: two lines of code plus their rationale comment. The whole
# mechanism lives in the new leaf `standalone-linked-static-inheritance.ts`;
# what stays in the god-file is the one decision point the new arm must be
# spliced into — the class-static call ladder, which is where §15.7.14 step 6
# has to be answered because that is where an own static is resolved and
# shadowing decided. Splitting `compileNamespaceStaticCall` (3,390 LOC) is a
# refactor of long-standing code this change does not otherwise touch.
#
# +24 LOC in `property-access-dispatch.ts` is the twin splice on the READ side
# (`emitClassStaticMemberRead`'s last arm, before `PA_FALLTHROUGH`) plus its
# rationale; the emission itself is in the leaf.
#
# +9 LOC / +8 function LOC in `expressions.ts` is the third splice, on the
# COMPUTED read (`S[k]`): `compileExpressionInner`'s element-access arm is the
# one chokepoint that owns the existing lowering the new arm WRAPS — the arm is
# deliberately a superset of that lowering rather than a re-derivation of the
# class-object static surface (the #5820 regression is what re-derivation costs),
# so it has to sit where that lowering is called.
#
# (#5383 S67, 2026-09-19) +10 LOC / +9 function LOC in `call-tail-dispatch.ts`
# is the fourth and last splice, on the COMPUTED CALL (`S[k](...args)`): the
# element-access CALL ladder is the one chokepoint where a spread-bearing call
# has to be diverted, because every arm below it marshals a FIXED arity and so
# hands the spread's source array over as a single argument. It is three lines
# of code plus the rationale, and the mechanism itself lives in the leaf
# `standalone-linked-static-inheritance.ts`. Splitting `compileTailDispatch`
# (2,149 LOC) is a refactor of long-standing code this change does not
# otherwise touch.
#
# (#5383 S67, 2026-09-19) +35 LOC in `new-super.ts` and +30 LOC / +25 function
# LOC in `class-bodies.ts` are the runtime-spread `super(…)` arm. Both are
# splices into long-standing code plus their rationale:
#  - `new-super.ts` parameterises `compileNativeConstructRuntimeArgv` on the
#    CALLEE push (a captured heritage global cannot be named as an expression)
#    and exports the result. The alternative — a second copy of the driver
#    prelude, guards and argv builder in the leaf — is the duplication #5383
#    S34 wrote that function to avoid.
#  - `class-bodies.ts::compileSuperCall` is the ONE program point where a
#    SuperCall's argument list is known, so the runtime-length arm has to sit
#    there; it replaces a five-line “decline and evaluate for effect” stub.
# Splitting either long-standing function is a refactor this change does not
# otherwise touch.
loc-budget-allow:
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/expressions.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/class-bodies.ts
#
# +14 in `collectClassDeclaration` and +11 in `compileStatementInner` are the
# two splice points of the IDENTIFIER-heritage arm, both already reduced to a
# single call into `standalone-dynamic-parent-class.ts`: the heritage-arm
# classification (which must sit in the `extends <Identifier>` ladder, AFTER the
# host-constructible-builtin and extern-class arms decline, or it would change
# `classBuiltinParentMap`'s representation) and the ClassDefinitionEvaluation
# capture (which must sit in the nested-class statement arm, because that is the
# one program point where the parameter the heritage names is in scope).
# Splitting either long-standing function is a refactor this change does not
# otherwise touch.
func-budget-allow:
  - src/codegen/class-bodies.ts::compileSuperCall
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  - src/codegen/class-bodies.ts::collectClassDeclaration
  - src/codegen/statements.ts::compileStatementInner
  - src/codegen/expressions.ts::compileExpressionInner
---

# #6644 — static inheritance + cross-link `instanceof` through a provider heritage

## Target (S66 dispatch)

The four remaining `subclassing-ignored` rows, all `fail` on the S65 head
(`930ab332f4`):

- `test/built-ins/Temporal/PlainDate/from/subclassing-ignored.js`
- `test/built-ins/Temporal/Duration/from/subclassing-ignored.js`
- `test/built-ins/Temporal/Duration/prototype/abs/subclassing-ignored.js`
- `test/built-ins/Temporal/ZonedDateTime/prototype/add/subclassing-ignored.js`

## Mechanism 3 — cross-link `instanceof` (landed)

### Root cause (reduced, not assumed)

`(new NS.Base(1)) instanceof NS.Base` answered **`false` for a DIRECTLY
constructed provider instance**, which is what #6640 pinned as a control and
#6643 named as the second blocker behind every row (`assertPlainDate` /
`assertDuration` open with `assert(x instanceof Temporal.X)`).

Decomposed against the real two-module fixture on the branch base
(`.tmp/s66/probes/p3.mts`, standalone + `hostBridge: "off"`):

| probe | base |
| --- | --- |
| `typeof T` | `function` |
| `typeof T.prototype` | `object` |
| `Object.getPrototypeOf(V) === T.prototype` | `true` |
| `T.prototype.isPrototypeOf(V)` | `true` |
| `Object.prototype.hasOwnProperty.call(T, 'prototype')` | **`false`** |
| `V instanceof T` | **`false`** |

Every ingredient of §7.3.20 already crossed the seam. The ONE step that missed
was the own-property **gate** in `__instanceof_dynamic`
(`native-dynamic-instanceof.ts`): `hasOwnProperty(T, "prototype")` answers
`false` for a provider-minted class object, because the consumer's own-property
bag is a module-local `ref.test` ladder that a foreign struct matches nowhere.
The helper therefore fell past BOTH `prototype` arms to the closure identity
edge (`__closure_proto_of`, module-local by construction), missed there too, and
returned the documented conservative `false`.

### The fix

A new last-resort arm, `linkedPeerPrototypeArm`, spliced at the tail of both the
callable and the not-callable branches: when the linked provider's
`__js2wasm_link_callable_kind` reports the target as a function object, read
`Get(C, "prototype")` through `__extern_get` (whose peer `memberGet` arm already
answers) and run the existing §7.3.20 steps 3 + 5–7 tail unchanged.

Three properties make the blast radius what it is:

- **Nothing is emitted** unless the module CONSUMES a standalone provider
  (`standaloneLinkBoundaryPeerIndex` returns `undefined` otherwise) — so the
  whole byte corpus, the provider modules themselves, and the entire JS-host
  lane are untouched.
- **Placed LAST**, after every local answer has declined, so it can only replace
  a `false` that was a miss — it can never pre-empt an answer the consumer could
  give itself.
- **`callableKind != 0`, not bit 0 alone.** A provider CLASS publishes
  construct-only under `fillStandaloneLinkBoundaryLateTerminals`' encoding, and
  a class object is precisely the target every `x instanceof Temporal.Foo` names.
  (This is the one place #6643's `linkedForeignCallableBitInstrs` — which masks
  bit 0 for §20.2.3's IsCallable — is the wrong predicate.)

A consumer-owned closure asked about here costs nothing: the peer's
`__extern_get` answers `null` for a value it does not own, so the arm falls
through to the same conservative `0`.

## Mechanism 1 — static inheritance through the heritage (landed)

### Root cause

#6640/S64 made a `class S extends NS.Base {}` construct through the provider,
so its INSTANCES are provider-minted and every inherited instance read and
method call already worked. The CLASS OBJECT got nothing: `S` is an ordinary
compiled class object with no [[Prototype]] edge to `NS.Base` (§15.7.14 step 6),
so a static `S` does not itself declare resolved nowhere. Measured on the S65
head with the two-module fixture and, against the real `@js-temporal/polyfill`
provider, in #6643's `.tmp/s65/probes/p24.js`.

### The fix — `src/codegen/standalone-linked-static-inheritance.ts`

The forward link, evaluated where it is needed: the heritage EXPRESSION
recorded by #6640 is re-compiled at the consuming site and the member question
is put to it through the ordinary `__extern_get`, whose peer `memberGet` arm
(#5383 S2d) already answers for a provider-owned receiver. Three splices, each
the LAST arm of its ladder:

| spelling | splice |
| --- | --- |
| `S.m` (read) | `emitClassStaticMemberRead`'s last arm, before `PA_FALLTHROUGH` |
| `S.m(...)` (call) | the class-static call ladder in `compileNamespaceStaticCall` |
| `S[k]` (computed read, and with it every computed CALL incl. spread) | `compileExpressionInner`'s element-access arm |

Why re-compiling the expression rather than caching it: the heritage of a
property-access-linked class is a read of a module-level binding, so evaluating
it is free of observable effects (the #6640 gate admits property/element ACCESS
only). An IDENTIFIER heritage is different and gets a capture global — see
mechanism 2.

`prototype`, `name`, `length` and `constructor` are never forwarded: §15.7.14
gives a derived class its own, and forwarding would hand back the PARENT's —
a new wrong answer rather than a missing one. An own static always shadows,
because every own-surface arm runs first.

**`this` binds to the PARENT class object, not `S` — a deliberate bound.**
§15.7.14 would bind `S`; that value is a consumer-side `$S` struct the provider
cannot decode, so binding it would make a provider static that reads `this`
(`static from(x) { return new this(x) }`) fail outright rather than answer.
Binding the parent produces exactly the "subclassing is ignored" result the
Temporal rows assert, and every Temporal static ignores `this` altogether.

The computed arm WRAPS the existing element-access lowering rather than
re-deriving the class-object static surface (`r = <existing lowering>`; only a
null/undefined `r` asks the parent). Re-deriving would be strictly weaker — own
statics live across the #5195 sidecar, `staticProps` globals and callable static
fields, which is exactly the #5820 regression. It is restricted to a
side-effect-free KEY (identifier or string literal) because the fallback
evaluates the key a second time and §13.3.3 evaluates it once, and it refuses
any class that declares an own static (see the trap note under "Pre-existing
defects observed").

## Mechanism 2 — an IDENTIFIER heritage, with a captured parent value (landed)

#6640's residual 2: `class MySubclass extends construct {}` where `construct` is
a function PARAMETER — test262's `checkSubclassConstructorUndefined` /
`checkThisValueNotCalled` shape. That arm is shared with every
`extends <builtin>` spelling, so the widening runs only after the
host-constructible-builtin and extern-class arms have both declined;
`classBuiltinParentMap` is untouched.

The half S64 could not have reused: the heritage VALUE is a parameter, in scope
at exactly ONE program point — the class declaration's own statement. The
synthesized constructor and the static-inheritance arms are different wasm
functions, so the value is captured there into a per-class module global
(`__linked_parent_<C>`, written by `statements.ts`'s nested-class arm) and every
consumer reads that global. A property-access heritage mints no global and keeps
re-compiling.

The predicate is purely SYNTACTIC — "does this identifier name a formal of an
enclosing function?" — because a linked namespace member is typed `any` (no type
to discriminate on) and `class-bodies.ts` is on the raw-checker ratchet. It
**refuses anything it cannot capture** (it requires a `ClassDeclaration` in a
`Block`, which is what the statement hook sees): claiming without capturing
would turn today's harmless independent root struct into a `null` instance,
which is a regression, whereas declining is not.

## Witness — `tests/issue-6644-link-static-inheritance-instanceof.test.ts`

File-copy revert of the nine touched files to `930ab332f4`, same fixture,
base → fix. **All ten teeth flip; all eighteen controls are identical on both
trees.**

| expression | base | fix |
| --- | --- | --- |
| `typeof Sub.from` | `undefined` | `function` |
| `Sub.from(3).get()` | `!called value is not a function` | `3` |
| `Sub.tag()` | `!called value is not a function` | `base` |
| `Sub['tag']()` | `null` | `base` |
| `mk(NS.Base).get()` | `!called value is not a function` | `4` |
| `mk(NS.Base).a` | `undefined` | `4` |
| `mkStatic(NS.Base, 'from').get()` | `!Cannot read properties of undefined` | `6` |
| `(new NS.Base(1)) instanceof NS.Base` | `false` | **`true`** |
| `NS.Base.make() instanceof NS.Base` | `false` | **`true`** |
| `(new Sub(2)) instanceof NS.Base` | `false` | **`true`** |

The last three were pinned as CONTROLS in
`tests/issue-6640-link-extends-provider-class.test.ts`, deliberately, to keep
that slice's residual claim honest; this change flips them, and #6640's own
witness and issue file are updated in the same change-set so neither is left
asserting a state that no longer holds.

Controls held: an own static still shadows (`SubOwn.tag()` → `own`), a derived
class keeps its own `prototype` / `name`, ordinary LOCAL `extends` and its static
inheritance are untouched, and `Object.getPrototypeOf` of a CLASS OBJECT stays
`false` for the LOCAL case too.

## Real rows — they do NOT move, and the two remaining blockers are located

`JS2WASM_TEMPORAL_CACHE=.test262-cache/s66-3`, four-file run plus canaries:

| row | base | fix |
| --- | --- | --- |
| `PlainDate/from/subclassing-ignored.js` | `TypeError: called value is not a function` | unchanged |
| `Duration/from/subclassing-ignored.js` | same | unchanged |
| `Duration/prototype/abs/subclassing-ignored.js` | same | unchanged |
| `ZonedDateTime/prototype/add/subclassing-ignored.js` | same | unchanged |
| `PlainDate/compare/use-internal-slots.js` (canary) | `pass` | `pass` |
| `PlainDateTime/compare/use-internal-slots.js` (canary) | `pass` | `pass` |
| `PlainDate/from/argument-object-valid.js` (canary) | `fail` (`SameValue(«null», «undefined»)`) | unchanged |

What DID move against the real provider is large, and it is what makes the
remaining blockers visible. `.tmp/s66/probes/p24.js` (helper 3 replicated
inline), fix tree:

```
[typeofSubFrom=function]   (base: undefined)
[subFrom=2000]             (base: TypeError: called value is not a function)
[called=false]             (correct — the subclass ctor is not invoked)
[subFromComputed=2000]     (base: null)
[gpoSub=false]             (unchanged — residual 3 below)
[newSub=NULL]              (unchanged — residual 4 below)
```

`.tmp/s66/probes/p7.js` runs the three real helpers separately:
`[h1=ok][h2=ok][h3!TypeError: called value is not a function]` — helpers 1 and 2
pass, and helper 3 is the whole of what is left for both `from/*` rows.

`.tmp/s66/probes/p8.js` / `p9.js` narrow helper 3 to exactly two residuals:

| shape | answer |
| --- | --- |
| `S.from(lit)`, no own ctor | `2000` |
| `S[m](lit)`, no own ctor | `2000` |
| `S[m](...args)`, no own ctor | `TypeError: year is required` |
| `typeof S[m]` inside the harness's own method shape | `undefined` |
| `C.from(...args)` directly on the provider (control) | `2000` |

## Residuals — measured, not assumed

1. **A linked subclass with an EXPLICIT CONSTRUCTOR is not reached by the
   computed read.** `typeof S[m]` is `"function"` for
   `class S extends construct {}` and `undefined` for
   `class S extends construct { constructor(...a) { super(...a) } }`, in the same
   enclosing shape (`.tmp/s66/probes/p9.js`, cases `e`/`f` vs `i`). The NAMED
   spelling is unaffected — `S.from(3)` answers correctly for a class with an
   explicit constructor — so the class IS claimed as a linked-dynamic-parent
   class and mechanism 2 is not the problem.

   **The discriminator is NOT the constructor, and it is not yet isolated.**
   Three further probes say so and they do not agree on a single trigger:

   - `.tmp/s66/probes/p11.mts` (two-module fixture): an explicit constructor —
     fixed-arity or rest — changes NOTHING. `typeof SubCtor["tag"]`,
     `SubCtor["tag"]()` and the same shapes nested in a function declaration
     with an identifier heritage all answer correctly.
   - `.tmp/s66/probes/p12.mts` (same fixture): inside an object-literal METHOD
     body the computed read declines (`undefined`) with or without a
     constructor, while the NAMED read in the identical shape answers
     `function`.
   - `.tmp/s66/probes/p8.js` (real provider, test262 file): the object-literal
     method shape DOES resolve (`typeof S[m]` → `function`, case `e`).

   So the arm's class-name resolution (`classExprNameMap.get(text) ?? text`) is
   shape-sensitive in a way the NAMED arm's is not — the named arm gets
   `resolvedClass` from the property-access dispatch, which already handles the
   #4618/#4646 scoped-synthetic identity that a class declared in a nested or
   never-collected scope carries. Routing the computed arm through the same
   resolution is the obvious next step, but it is a HYPOTHESIS, not a
   measurement, and the three probes above must be made to agree before it is
   acted on. **This is the first blocker for both `from/*` rows.**
2. **Calling the resolved provider static with a RUNTIME SPREAD passes the array
   itself.** `S[m](...a)` reaches the provider's `from` with the argument vector
   rather than its single element (`TypeError: year is required`), while the
   same spread applied to a DIRECT provider static (`C.from(...a)`) is correct.
   So the defect is in the dynamic-callee spread path, which this slice makes
   reachable for the first time for this receiver; it is not in the read arm.
   **This is the second blocker for both `from/*` rows.**
3. **`Object.getPrototypeOf(<class object>)` is unmodelled on this lane** — for a
   LOCAL derived class too (`Object.getPrototypeOf(LocalDerived) === LocalBase`
   is `false`). Pinned as a control in the witness, precisely so the linked case
   answering `false` is not mistaken for this slice's gap. #6625's
   `isClassObject` terminal answers a narrower question (base classes only, and
   it tells the consumer to produce `%Function.prototype%`); a parent-aware
   answer is its own residual there.
4. **`super(...<runtime spread>)` still leaves `this` unbuilt** — #6640's
   residual 3, unchanged. Measured: `class S extends construct { constructor() {
   ++called; super(...cargs) } }` gives `called === 1` (correct) and
   `new S()` → `null`. **This is the blocker for the `abs` / `add` rows**, which
   reach `checkSubclassConstructorUndefined` before helper 3 is ever relevant.
   #5383 S34's `__native_construct_argv` driver is the follow-up.

### Pre-existing defects observed (not this slice's, not widened)

- `C["staticName"]()` on a class that DECLARES that static is an uncatchable
  `illegal cast`, **including for a purely local class with no link at all**
  (`.tmp/s66/probes/p10.mts`: `LocalOwn["tag"]()` traps while `LocalOwn.tag()`
  is fine). `tryEmitLinkedStaticComputedRead` refuses any class with an own
  static for exactly that reason, so the arm neither causes nor widens it.

## Expectations updated elsewhere

Two committed expectations elsewhere pinned states this slice changes, both for
the better, and both are updated here with a pointer to this issue:

- `tests/issue-6640-link-extends-provider-class.test.ts` asserted
  `(new NS.Base(3)) instanceof NS.Base === "false"` and the subclass twin, as
  deliberate residual controls. Mechanism 3 makes both `true`; #6640's residual
  1 is marked RESOLVED in its issue file.
- `tests/issue-6623-standalone-subclass-tag-collision.test.ts`'s
  field-HAVING-provider CONTROL asserted
  `threw:called value is not a function` — #6623 recorded that dispatch as
  failing "for an unrelated reason", a separate mechanism it sized out of
  scope. That mechanism is #6640's residual 2, which mechanism 2 fixes, so the
  control now answers `called`. #6623's own TEETH (the guard it actually
  protects) are unchanged and still answer `OK`.

## Validation

- **Full four-family + regression battery**, 3,684 rows
  (`.tmp/s66/battery/`, provider cache `s66-3`), every group diffed against the
  S65 head: **0 pass→fail, 0 fail→pass, 0 missing, in all thirteen** —
  `PlainDate` 120, `Duration` 120, `PlainDateTime` 120, `ZDT` 120, `A` 1250,
  `B` 205, `C` 349, `D` 300, `E-unlinked` 300, `E-linked` 300, `F-class` 250,
  `F-methoddef` 100, `F-objproto` 150. The four Temporal families hold at
  **459/480** (117 / 108 / 117 / 117) and the whole-battery pass count holds at
  **3,081** — the S64/S65 numbers.
- **Equivalence gate**: 22 failing / 1720 passing / 22 known-failures — the
  expected triple, no new regressions.
- **Witness sweep, Node 22.22.2 AND Node 25.9.0**: `tests/issue-66*.test.ts`
  `tests/issue-6484-*` `tests/issue-6493-*` → 48 files / 274 tests passed on
  both; `tests/issue-6617-*` `tests/issue-6622-*` `tests/issue-6623-*` → 3
  files / 26 tests passed on both.
- **Byte corpus A/B** (84 modules × {gc, standalone}) against a TRUE base run
  (the nine touched files file-copy-reverted to `930ab332f4`, re-measured,
  restored): **0 status flips, 0 sha flips** — `gc` byte-identical and
  standalone growth **0 bytes**. The Temporal provider re-emitted the identical
  **3,334,356 B** artifact under the identical key `a11c84e556193459`, so this
  slice is consumer-side only.


## S67 — residuals 1, 2 and 4 closed; the two `from/*` rows advance to a different, pre-existing blocker

Branch `issue-5383-standalone-temporal-s67`, base `ab6e22f345` (the S66 head).

### Residual 1 — the discriminator was a class-NAME COLLISION, not the enclosing shape

S66 left this un-isolated because three probes disagreed. They agree under one
explanation, and it is not the one the hypothesis named.

`tryEmitLinkedStaticComputedRead` (and the class-static CALL ladder) resolved
the receiver with `classExprNameMap.get(text) ?? text`. That is NAME-keyed, and
a name is not an identity: #4618's `mintScopedClassIdentity` gives every
same-named class but the FIRST a per-site synthetic (`__anonClass_S_4`), and
#4646 mints it lazily for the scopes the collection pass never walks — a
class/object-literal METHOD body, a sibling block. So the bare name resolves to
a DIFFERENT declaration.

For these arms that is not a precision nicety but a **wrong answer**, because a
captured IDENTIFIER heritage stores its parent in a per-class module global
(`__linked_parent_<C>`): keying on the name reads the TWIN's global. Measured on
the branch base with the two-module fixture (`.tmp/s67/probes/p31.mts`) — two
same-named classes in two object-literal methods, with DIFFERENT parents:

| call | base |
| --- | --- |
| `oB.go(NS.Other, 'tag')`, before the owner has ever run | `null` |
| `oA.go(NS.Base, 'tag')` (the owner) | `base` |
| `oB.go(NS.Other, 'tag')`, after it | **`base`** — the WRONG parent |

That third row is the whole of S66's "shape sensitivity": an inherited static
resolved whenever some earlier call happened to have written the shared global
with a compatible value, and declined (`undefined`) otherwise. `.tmp/s67/probes/p30.mts`
separates the two candidate causes directly — a UNIQUELY-named class inside an
object-literal method answers `function` on the base tree (so the shape is
innocent), while a name-colliding one in the same shape answers `undefined`.

**The fix** (`resolveLinkedStaticClassName`): resolve by DECLARATION identity
through `ctx.oracle.valueDeclarationOf` — a per-site synthetic is the identity
outright; a declaration that OWNS its source name keeps the name; a colliding
twin with no synthetic minted yet is REFUSED rather than guessed. A cheap exact
gate (`classLinkedDynamicParentExpr.size === 0`) keeps the oracle query off
every element access in every module with no linked provider.

### Residual 2 — a runtime spread is a RUNTIME length, and the call was fixed-arity

The computed read hands back a plain externref callee; the CALL of that value is
lowered by `calls.ts::tryEmitInlineDynamicCall` (measured — that is the arm that
fires). Its marshalling is `expr.arguments.length` locals, one per AST node, so
a spread contributes exactly ONE value: the source array. Measured on the base
with a provider static that echoes its arguments (`.tmp/s67/probes/p32.mts`):

| call | base |
| --- | --- |
| `NS.Base.two(...A2)` directly on the provider (control) | `two:p,q:2` |
| `Sub[m](...A2)` where `Sub extends construct` | `two:p,q,undefined:1` |

The one-element case masks itself (`"one:" + ["p"]` prints what `"one:" + "p"`
prints), which is why S66 saw it only as the real provider's `year is required`.

**The fix**: ship the whole call through the boundary's
`__apply_closure(__extern_get(P, ToPropertyKey(k)), P, argv)` terminal — the
same one the NAMED form already used — whose argv is a runtime vector, and
expand the spread with #6616's shared `tryEmitSpreadHostArgs`. **Gated on a
spread being PRESENT**: without one the existing lowering is already correct, so
no call site that works today gains an instruction. The NAMED form stopped
refusing spreads for the same reason.

### Residual 4 — `super(...<runtime spread>)` now builds `this`

The fixed-arity construct driver cannot serve a runtime-length argument list, so
`compileSuperCall`'s linked arm declined and only evaluated the arguments for
effect — `called` was already 1 and `new S()` was `null`. #5383 S34's
`__native_construct_argv` driver takes an args VECTOR plus a runtime count and
carries the SAME boundary-construct arm, so its body is now parameterised on the
callee push (a captured heritage global cannot be named as an expression) and
reused here. Null NewTarget-prototype, for the same reason the fixed-arity arm
passes one: the PROVIDER picks the prototype its own constructor would.

Measured, `.tmp/s67/probes/p38.mts`, base → fix: `mkCaptured(NS.Base,[5])`
`1/NULL` → `1/5`.

### Real rows — helper 3 passes; the `from/*` rows move to a DIFFERENT blocker

`JS2WASM_TEMPORAL_CACHE=.test262-cache/s67-2`, four rows plus canaries:

| row | S66 head | S67 |
| --- | --- | --- |
| `PlainDate/from/subclassing-ignored.js` | `TypeError: called value is not a function` | `Test262Error: SameValue(«null», «undefined»)` |
| `Duration/from/subclassing-ignored.js` | same | same as above |
| `Duration/prototype/abs/subclassing-ignored.js` | same | unchanged |
| `ZonedDateTime/prototype/add/subclassing-ignored.js` | same | unchanged |
| `PlainDate/compare/use-internal-slots.js` (canary) | `pass` | `pass` |
| `PlainDateTime/compare/use-internal-slots.js` (canary) | `pass` | `pass` |
| `PlainDate/from/argument-object-valid.js` (canary) | `fail` (`SameValue(«null», «undefined»)`) | unchanged |

`.tmp/s67/probes/p7.js` against the real provider now answers
`[h1=ok][h2=ok][h3=ok][inline=2000/called=false]` — **all three helpers of
`checkSubclassingIgnoredStatic` pass**, which was the whole of what #6644 was
asked to unblock. `.tmp/s67/probes/p24.js`:
`[typeofSubFrom=function][subFrom=2000][called=false][subFromComputed=2000][gpoSub=false][newSub=NULL]`
— unchanged from S66 apart from the two residuals below.

The two `from/*` rows now stop **later**, on the SAME failure the canary
`PlainDate/from/argument-object-valid.js` already had on the base tree:
`temporalHelpers.js`'s `canonicalizeCalendarEra` line 140,
`assert.sameValue(eraName, undefined)`, with `eraName` arriving as `null`. So
this is a pre-existing `undefined`-becomes-`null` defect on an argument path,
not something this slice introduced — it was simply unreachable while helper 3
threw first.

## Residuals after S67 — measured

1. **A rest-forwarded call does not happen at all.** `const O = { fwd(...args)
   { return this.echo(...args); }, echo(a,b,c,d){…} }` — `O.fwd(1,"s",[2],fn)`
   answers `undefined` while `O.echo(…)` answers `number/string/object/function/4`
   (`.tmp/s67/probes/p34.js`). `temporalHelpers.js` routes EVERY
   `checkSubclassingIgnored*` entry point through exactly that shape
   (`checkSubclassingIgnoredStatic(...args) { this.checkStaticInvalidReceiver(...args); … }`),
   which is why calling the three helpers separately passes and calling the
   combined one does not. This, plus the `undefined`→`null` argument defect
   above, is what the two `from/*` rows now stop on. It is a general
   dynamic-callee/rest-forwarding spread gap, not a linked-boundary one: the
   same probe fails with no provider in sight.
2. **`f(...a)` on a dynamic callee.** `function callSpread(f,a){ return f(...a) }`
   delivers the wrong argument (`.tmp/s67/probes/p37.js`), and
   `var g = S[m]; g(...a)` answers `null` (`.tmp/s67/probes/p32.mts`). Same
   mechanism as (1) — `tryEmitInlineDynamicCall` is fixed-arity. S67 fixed only
   the linked-static computed CALL, which is the shape helper 3 writes.
3. **`instance[method](...methodArgs)` on a subclass instance** — the shape
   `checkSubclassConstructorUndefined` uses, and therefore the blocker the
   `abs`/`add` rows now stop on (still `called value is not a function`). The
   receiver is a user-class instance, so `elemAccessReceiverIsUserClass` claims
   it before the spread-capable `__extern_method_call` arm is reached.
4. **`new X(...<runtime spread>)`** is an uncatchable `illegal cast`, for a
   purely LOCAL class too (`.tmp/s67/probes/p38.mts`: `mkLocalSpread([9])`
   traps on both trees). Pre-existing, unrelated to the link, unchanged here.
5. **`Object.getPrototypeOf(<class object>)`** — unchanged from S66's residual 3.
6. **`C["ownStatic"]()`** — unchanged; the computed arm still refuses any class
   with an own static, and the pre-existing local-class trap is neither caused
   nor widened.
