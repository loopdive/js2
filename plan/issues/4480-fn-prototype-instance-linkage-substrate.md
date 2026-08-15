---
id: 4480
title: "standalone substrate: every function owns a real `.prototype` object linked to its instances — the recurring blocker behind F3/#4455-R3/R4/Array-A1 (~25+ rows)"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
es_edition: 5
language_feature: function-prototype
goal: standalone-gap
related: [3976, 4464, 4455, 2660, 4437]
loc-budget-allow:
  # +6 lines: ONE import and a 5-line dispatch hook. The `Object.getPrototypeOf`
  # arm itself lives in the new subsystem module
  # `src/codegen/fnctor-instance-prototype.ts`; only the hook can live here,
  # because this file owns the `Object.getPrototypeOf` dispatch and the arm's
  # POSITION in it is load-bearing (after the top-level-function arm so
  # `Object.getPrototypeOf(F)` still reports %Function.prototype%, before the
  # ES5 value arm so a `new F()` binding is not first mapped through
  # `ES5_OBJECT_PROTOTYPES`). A first cut put the 27-line body inline; it was
  # moved out in response to this gate, leaving the minimum the dispatch needs.
  - src/codegen/expressions/call-builtin-static.ts
func-budget-allow:
  # Same +5 lines as the LOC allowance above, seen from the function that owns
  # the `Object.getPrototypeOf` dispatch. The arm cannot be hoisted out of this
  # function without hoisting the whole dispatch chain it must sit inside, which
  # is #3399's refactor, not this issue's.
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
origin: "2026-08-15 ES5-standalone session — root-cause fan-out. Four independent agent waves hit this same wall and each recorded it as a residual: #4464 F3 (8 files) + F2-residual (7), #4455 R3/R4, S13.2.2_A1/S13.2_A1 isPrototypeOf family."
---

# #4480 — fn.prototype auto-object + instance [[Prototype]] linkage

## Problem

§13.2 steps 16–18: every function gets an own `.prototype` object whose
`constructor` points back, and §13.2.2 [[Construct]] links `new F()`
instances to that object. Standalone has neither: `__func.prototype` answers
undefined/null, `F.prototype.isPrototypeOf(new F())` is false,
`Object.getPrototypeOf(instance) === F.prototype` fails, and reads at `new`
sites typed from the checker leak nulls/NaN (the #4464 F2-residual
signature). Four waves independently filed this as their blocking residual —
it is the highest-leverage single substrate gap in the ES5 bucket
(~25 directly-measured rows; more behind them).

## What already exists (read ALL before designing)

- `emitLazyProtoGet` (class prototypes as singleton `$Object` globals) — the
  CLASS half of this substrate already works; `D.prototype.__proto__`
  chaining is #4455 R4's known gap.
- `closure-prototype-edge.ts` (#2660 M3) — prototype-edge handling for
  closures; the natural home or neighbor for the new carrier.
- `function-instance-meta*.ts` (#4437) — the PROVEN pattern for attaching a
  per-function slot to closure structs (`$fnmeta` nominal brand, sibling
  families, resolver arm). A `.prototype` slot is the same shape: a lazily
  minted `$Object` hanging off the closure.
- `construct-return-value.ts` + `new-super.ts` (#4464) — `new <fnctor>` now
  mints receivers; the linkage point for instance [[Prototype]] is there.
- #3976 (done) installed class elements as own props — its issue file
  documents why the class OBJECT itself is not an `$Object` (the
  `emitDynamicNewFallback` `ref.test` dispatch depends on nominal structs).
  Do not break that; the fn.prototype carrier must coexist.

## Implementation Plan

1. Design doc FIRST (in this issue file, before code): the carrier (a
  `$fnproto` mut ref slot on closure-with-meta families, or a side table
  keyed like #4437's), lazy mint semantics, `constructor` back-ref, and how
  `new F()` receivers get `[[Prototype]] = F.prototype` (the receiver mint in
  `new-super.ts` is the write point; `Object.getPrototypeOf`/`isPrototypeOf`
  are the read points).
2. Slice S1: `.prototype` READ on user function declarations/expressions
   returns a stable lazily-minted `$Object` with `constructor` back-ref
   (S13.2_A1_T1/T2, S13.2_A4 family flip).
3. Slice S2: `new F()` instance linkage — `isPrototypeOf`/`getPrototypeOf`
   answer the minted object (S13.2.2_A1, Array/S15.4.1_A1-style rows).
4. Slice S3: assignment `F.prototype = obj` re-points the slot; instances
   minted AFTER see obj (S13.2.2_A19_T7/T8).
5. Controls: byte-identity on modules that never touch `.prototype`;
   fn-family pins (4436/4437/4440/4442/4456/4460/4464) green; scoped sweeps
   over `language/statements/function` + `built-ins/Function`.
6. This is XL: ship slices as separate commits; S1+S2 alone clear the
   acceptance bar. Record a real design section — the next wave builds on it.

## Acceptance criteria

- ≥15 rows flip across the S13.2 family + isPrototypeOf rows; zero
  regressions; the design section documents the carrier for successors.

---

## Design — the carrier, and what it can and cannot link

Written after S1+S2, from runs executed on this branch. Read this before
adding a third prototype mechanism; there is exactly one carrier and the
interesting content is the boundary around it.

### The carrier

`ctx.fnctorPrototypeObject` maps a fnctor NAME → a `mut externref` module
global `__fnctor_proto_<F>` (`expressions/fnctor-prototype.ts`). It holds a
real native `$Object`, minted lazily on first use by `emitFnctorProtoGet`,
which is the SINGLE mint point every consumer funnels through:

| consumer | file | what it does with the global |
| --- | --- | --- |
| `F.prototype` READ | `property-access-dispatch.ts`, `property-access.ts` | returns it |
| `F.prototype === undefined` | `property-nullish-read.ts` | returns it (S1 added this route — it bypasses the dispatcher) |
| `F.prototype = rhs` | `expressions/assignment.ts` | `global.set` |
| `F.prototype.p = v` | (no code) | rides the READ — the write lands on the object |
| `new F()` reconstruct | `expressions/new-super.ts` | seeds `$Object.$proto` |
| `x instanceof F` | `native-user-instanceof.ts` | chain-walk operand |
| `Object.getPrototypeOf(i)` | `expressions/call-builtin-static.ts` (S2) | returns it for a bespoke-struct instance |

Module globals are append-only and index-stable, so minting one mid-compile
carries no funcidx-shift hazard (unlike a `call` to a defined helper) — that
is why the carrier is a global rather than a synthesized function.

The §13.2 step 10 `constructor` back-ref is installed INSIDE the lazy-init,
not at the `F.prototype` read site, precisely because the mint point is
shared: installing at any one call site would leave the object without a
`constructor` whenever a different consumer happened to vivify it first.

### The gate — who gets a carrier

`resolveUserFnctorName` decides, and it is the load-bearing predicate in the
whole design. Three arms admit a fnctor:

1. escape-gate `approvedNames` (the #2660 reconstruct population),
2. a fnctor with a runtime `Object.defineProperty(F.prototype, …)` install,
3. **(S1)** a fnctor with NO `new F()` site anywhere in the module.

Arm 3 is the §13.2-steps-16-18 widening and it is safe for a structural
reason, not a lucky one: the hazard the gate exists for is a SPLIT BRAIN
between the object `F.prototype` reads and the object `new F()` links its
instances to, and **a constructor that is never constructed has no instance
to disagree with**. A fnctor that IS `new`'d but was NOT approved
(`keep-typed`/`keep-static`) keeps declining — that population is exactly
where the instance link lives somewhere this global is not, so answering
would be WRONG rather than missing. `Test262Error` is that case, which is why
the −40-floor harness regression the gate comment records stays structurally
excluded rather than excluded by luck.

### The two instance representations, and why only one can be linked

`new F()` has two host-free lowerings:

- **`$Object` with a real `$proto`** — the #2660 S3a reconstruct. Linkable:
  `$Object.$proto` is the one link location and `__isPrototypeOf` walks it.
- **bespoke `$__fnctor_<F>` WasmGC struct** — new-super.ts. **Has no `$proto`
  field at all.** Measured on this branch: even an EMPTY-bodied `function F(){}`
  takes this path once its instance is bound to a `var`.

Everything hard about this issue follows from the second row. The native
walk opens with `ref.test (ref $Object)` on the value, which a
`$__fnctor_<F>` struct fails, so the loop exits before its first iteration
and answers `0`. S1 therefore produced a module that contradicted ITSELF:
`F.prototype` answered the global while `Object.getPrototypeOf(i)` answered
something else.

**S2's fix is to treat the bespoke struct type as a STATIC [[Prototype]]**
(`fnctor-instance-prototype.ts`): the struct is minted per-constructor and
plain functions have no subtyping, so `ref.test (ref $__fnctor_F)` IS the
question "was this constructed by F". That is the same reasoning — and the
same instruction — `native-user-instanceof.ts` already ships for `instanceof`;
S2 states it once so the three read points cannot drift apart.

Two conditions make the static answer sound, and both are enforced in one
place so every consumer inherits them:

1. `resolveUserFnctorName` must resolve `F` — i.e. `F.prototype` READS come
   from the same global. Otherwise the identity would be false in the
   module's own terms.
2. no whole `F.prototype = …` reassignment in the file — the global is one
   mutable cell, so with a reassignment an instance built before it and read
   after it has a [[Prototype]] the global no longer holds. Per-property
   writes (`F.prototype.p = v`) mutate that same object and are explicitly
   NOT reassignments, so the ordinary prototype-method idiom keeps the arm.

### What a successor should NOT do

- Do not widen `$Object.$proto` to `anyref`/`eqref` to admit a
  function-valued prototype. It perturbs the canonical rec-group boundary
  (#2514) and touches every object in the runtime for a two-row family.
- Do not add a second `[[Prototype]]` mechanism beside the global. Every
  read point above already funnels through one mint; a parallel mechanism
  re-opens the split brain the gate exists to prevent.
- Do not widen `resolveUserFnctorName` to the `keep-typed`/`keep-static`
  population without first converting those instances to `$Object`. The
  order matters: representation first, then the gate.

The one high-leverage next step is the opposite direction: **shrink the
bespoke-struct population** (the #3976 class-object conversion applied to
fnctors) so that instances ARE `$Object`s. That single change would retire
R1, R4 and most of R3 at once, and it is why this issue's remaining
residuals are all recorded against the representation rather than against
the walk.
