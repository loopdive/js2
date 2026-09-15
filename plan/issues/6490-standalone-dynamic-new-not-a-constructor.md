---
id: 6490
title: "standalone: `new <runtime value>(…)` on a callable with NO [[Construct]] returns an object instead of throwing — §13.3.5.1 step 5 was never implemented in the dynamic construct driver"
status: in-progress
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
goal: standalone-gap
parent: 5383
assignee: ttraenkler/s25b-lane
created: 2026-09-15
loc-budget-allow:
  # 2026-09-15 (#6490): INHERITED red, restated here — not growth this change
  # made. This PR touches only `src/codegen/**`; `src/runtime.ts` is 19,822 vs a
  # 19,601 ceiling against `origin/main` (8c9b65b389) because main's post-merge
  # baseline refresh has not caught up with an earlier slice's landed growth.
  # The grant lives in an issue file this PR does not modify, so CI's
  # merge-preview base would report it as a STRANDED grant and fail `quality`.
  # Restated verbatim rather than fixed: re-splitting `runtime.ts` is not this
  # slice's work, and lowering the number by editing the baseline is forbidden
  # (main is its sole writer, #3131).
  - src/runtime.ts
func-budget-allow:
  # 2026-09-15 (#6490): same inherited red, same rationale —
  # `buildImports` is 308 vs a 300 ceiling against `origin/main`. Untouched by
  # this PR.
  - src/runtime.ts::buildImports
---

## Problem

Under `--target standalone` (and WASI), `new <runtime VALUE>(…)` **silently
constructs an object** when the callee is callable but has **no [[Construct]]** —
an arrow, a static or prototype method, an object-literal method, a built-in
function, or a foreign function whose `__boundary_object_callable_kind`
publishes bit 1 without bit 2. §13.3.5.1 EvaluateNew step 5 requires a
**TypeError**.

test262 spells this `built-ins/Temporal/**/not-a-constructor.js` — **123 files
corpus-wide**. Its message is

```
Test262Error: Calling as constructor
  Expected a TypeError to be thrown but no exception was thrown at all
```

Measured on this branch's base:

| probe | spelling | base | spec |
| --- | --- | --- | --- |
| `.tmp/s25/p1.mjs` (ONE module, no link) | `nw0(PD.compare)` | `no-throw` | TypeError |
| | `nw0(PD.prototype.ident)` | `no-throw` | TypeError |
| | `nw0(arrow)` | `no-throw` | TypeError |
| | `nw0(Math.max)` | `no-throw` | TypeError |
| `.tmp/s25/p2.mts` (across the link) | `new NS.PD.compare()` | `no-throw object` | TypeError |

## Root cause

`__native_construct_<N>` (`src/codegen/native-construct.ts`, #3981) implements
§10.2.2 OrdinaryCallEvaluateBody and **nothing else**. Its tail is
unconditional:

```
proto  = suppliedProto ?? callee.prototype
self   = Object.create(proto)
result = __call_fn_method_<N>(self, callee, …)
return IsObject(result) ? result : self
```

Every arm ABOVE that tail — proxy carrier, `$Proxy`, class-object identity, link
boundary, runtime-eval marker — answers for a callee that **has** [[Construct]].
Nothing answered for one that does not, so such a callee fell into the tail,
`Object.create` succeeded, the body ran as an ordinary call, and `new` evaluated
to an object.

## Fix

`src/codegen/construct-is-constructor-guard.ts` (new), spliced into
`fillNativeConstructDrivers` immediately before the ordinary tail — i.e. after
every arm that answers for a constructible callee has declined.

**Why INSIDE the driver, not at the call site.** §13.3.5.1 evaluates the
constructor (step 2) and the ARGUMENT LIST (step 4) **before** the IsConstructor
test (step 5). The call site already spills callee and every argument into
locals before it emits `call <driver>`, so the driver's entry is the first
program point where that exact order holds — and it is ONE place instead of one
per call site. The witness test pins this: the arguments still run, once, left
to right, before the throw.

**Why `__reflect_is_constructor` is the right predicate.** It is the same
predicate test262's own `isConstructor.js` harness reads through
`Reflect.construct(function(){}, [], f)`, and the second assertion of every
`not-a-constructor.js` row already passes — so the corpus itself is the evidence
that it answers correctly here. Probed directly (`.tmp/s25/p3.mjs`):

| callee | `__reflect_is_constructor` | spec |
| --- | --- | --- |
| `function f(){}` decl / expr / IIFE result | yes | yes |
| built-in ctor `Set`, bound plain fn | yes | yes |
| static method, prototype method, object-literal method | no | no |
| arrow, bound arrow, `Math.max` | no | no |

The one disagreement found was a class VALUE answering "no" — but only in a
module with **no** dynamic-`new` site at all, because `classObjectIdentityArms`
is gated on `classConstructWanted`, which `markClassValueConstructSite` turns on
at exactly the sites that reach this driver. Inside the driver the class arms are
therefore always present, and a class value has additionally already returned
from the class-construct arm several instructions earlier.

**Three conservative narrowings**, because a wrongly-firing guard turns working
code into a hard throw — a far worse regression than the defect:

1. `__typeof_function` must say `"function"`. A carrier the predicate cannot
   classify but that does not present as a function keeps its previous
   (possibly wrong) result rather than becoming a throw. The guard is therefore
   strictly a "callable but not constructible" rule; `new {}` is out of scope.
2. The runtime-eval interpreted-callback marker is exempt — a branded struct the
   predicate has no arm for, which the driver's own marker tail constructs
   through via `__apply_closure`.
3. No-JS-host lanes only (`usesNativeJsErrors`). The JS-host lane routes dynamic
   `new` through `__construct_closure` and never reaches here; it is also the
   only lane where building the throw would need a late IMPORT, which cannot be
   added at fill time.

**Byte-neutrality / reserve-then-fill.** The throw is a real `TypeError`
INSTANCE (`buildThrowJsErrorInstrs`) built at the CALL SITE during ordinary
expression compilation — the same discipline `reserveNativeConstructDriver`
already uses for `protoKeyInstrs`, and for the same reason: it touches the
string-constant and error-constructor machinery, which must not run at finalize.
A module that never compiles a dynamic `new <value>` site never arms the
template, so `constructIsConstructorGuard` returns `[]` and the driver emits
exactly the bytes it emitted before.

## Result — four standalone Temporal families, 120 rows each, base vs branch

Every row was run **solo at a 60 s compile budget on BOTH trees** (this family
sits ON the 15 s batch cap, so a batch-budget cell would measure the cap and not
the compiler). Consequence: the table has **no `compile_error` cell** and no
`timeout` cell on either side — every one of the 960 cells is `pass` or `fail`,
and the slowest cell in the whole matrix is 22.6 s.

| family (first 120 files) | base pass | branch pass | Δ | pass→fail | fail→pass |
| --- | --- | --- | --- | --- | --- |
| `built-ins/Temporal/PlainDate/**` | 101 | 103 | +2 | 0 | 2 |
| `built-ins/Temporal/Duration/**` | 97 | 99 | +2 | 0 | 2 |
| `built-ins/Temporal/PlainDateTime/**` | 104 | 106 | +2 | 0 | 2 |
| `built-ins/Temporal/ZonedDateTime/prototype/**` | 102 | 102 | 0 | 0 | 0 |
| **total** | **404** | **410** | **+6** | **0** | **6** |

**Zero pass→fail, so there is nothing to explain.** The six that moved are
exactly the six `not-a-constructor.js` rows in the sample
(`{PlainDate,Duration,PlainDateTime}/{compare,from}/not-a-constructor.js`).
ZonedDateTime is flat because the sample is its `prototype/**` subtree, which
carries no `not-a-constructor.js` file.

The delta is **surgical in the bucket histogram too**, which is the stronger
statement: aggregating the 480 base rows and the 480 branch rows by
digit-normalised error message, the bucket
`Test262Error: Calling as constructor Expected a TypeError to be thrown but no
exception was thrown` goes **6 → 0**, and **every other one of the 40 residual
buckets is unchanged, count for count**.

## Controls

(filled in below as they complete)

## Witness test

`tests/issue-6490-dynamic-new-is-constructor.test.ts`, six cases, measured on
BOTH trees by file-copy revert of `src/codegen/native-construct.ts` and
`src/codegen/expressions/new-super.ts`. On base **3 fail / 3 pass**; on the
branch **6 pass**.

Unlike #6489, **both** the single-module and the linked arms are witnesses: this
defect is a property of the DRIVER, not of callee ownership, so it reproduces
with no link at all. The linked arm additionally covers the foreign-function
path, where the callable/constructible distinction arrives as a `callableKind`
BITMASK rather than as a closure the module owns.

Base-tree answers, recorded inline in the file:

| case | base | branch |
| --- | --- | --- |
| single module, `new` on arrow / static / proto / literal method / `Math.max` | `obj/obj/obj/obj/obj` | `TypeError` ×5 |
| single module, bound arrow / bound plain fn | `obj/obj` | `TypeError/obj` |
| single module, ten constructible callees | `obj` ×10 | `obj` ×10 |
| single module, constructed VALUES (`9/7/3/object/undefined`) | identical | identical |
| single module, `Reflect.construct` + `Array#map` species | identical | identical |
| linked, arguments evaluated before the throw (base-11 fingerprint) | 146 | 146 |
| linked, `new NS.PD(5)` control | 5 | 5 |
| linked, `new NS.PD.{compare,from}()`, `new NS.PD.prototype.ident()`, `new NS.arrow()` | 0 / 0 / 0 / 0 | 1 / 1 / 1 / 1 |

Two things the file records that are NOT claims of this fix:

- **The spelling trap.** The callee must arrive as a FUNCTION PARAMETER
  (`nw0(F) { return new F(); }`). The obvious alternative — a registry read,
  `const C = reg["%K%"]; new C()` — does NOT reach this driver in a single
  module: it falls to `emitDynamicNewFallback`'s tag dispatch, whose only
  candidates are module-local CLASSES, so a plain function or a built-in answers
  `null` there on BOTH trees. A test written that way would assert `null` and
  never exercise the guard at all. Measured, not reasoned: the first cut of this
  file was written that way and four of its six cases were vacuous.
- **A pinned residual.** A built-in `Set` constructed through the dynamic driver
  answers `undefined` for `.size` on both trees — its internal slot is not wired
  up on this path. Recorded so that fixing it fails this file loudly instead of
  leaving a stale expectation.

## Claim

`node scripts/claim-issue.mjs --check 6490` → `#6490 is UNASSIGNED
(read origin/issue-assignments)`. This session cannot write a claim — all
GitHub pushes return 403. `check:issue-ids:against-main` passes, so the id is
free on `main`.

## Gate reds inherited from `origin/main` (NOT caused by this change)

Recorded rather than fixed, per the slice brief:

- `check:compiler-boundaries` → `inventory-valid-architecture-incomplete`
  (exit 1). This PR does fix the part it created: the new module
  `src/codegen/construct-is-constructor-guard.ts` is classified in
  `scripts/compiler-boundaries.json`, which takes the gate from
  `invalid-inventory` (`unclassified-module` + two `unclassified-target`) back
  to the pre-existing `inventoryValid: true, graphComplete: false` state.
- Under `LOC_GATE_BASE=origin/main`: `src/runtime.ts` 19,822 > 19,601 and
  `src/runtime.ts::buildImports` 308 > 300. Both untouched by this PR; the
  grants are restated in this file's frontmatter so CI's merge-preview base does
  not see them as stranded.
