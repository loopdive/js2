---
id: 4480
title: "standalone substrate: every function owns a real `.prototype` object linked to its instances — the recurring blocker behind F3/#4455-R3/R4/Array-A1 (~25+ rows)"
status: done
completed: 2026-08-15
sprint: 78
created: 2026-08-15
updated: 2026-08-18
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

## Status — closed at +3 per lead decision (option a, 2026-08-15 23:20)

Lead decision: accept and re-scope. S1+S2 are correct, verified (+3/−0 over
1,332 files), inert on the 509-file control, and documented. The misattributed
S13.2 rows belong to value-representation / [[Construct]]-return families. The
representation slice that retires R1/R3/R4 together is filed as **#4506**.

## Original status note (agent, pre-decision)

S1 and S2 are landed and verified (two commits, 1,332 files swept, +3 / −0).
S3 (`F.prototype = obj` re-points the slot per construction site) was **not
attempted**. The issue is left `in-progress` rather than `done` because the
stated acceptance bar (**≥15 rows**) was **not met — measured +3** — and this
agent will not mark an issue done against a bar it did not clear.

The decision that needs a human is which of these the bar should become,
because the evidence says the original number was an over-attribution rather
than a shortfall in the work (details in Test Results):

- **(a) Accept and re-scope.** The substrate is correct, documented, and
  inert on 509 control files. Re-file the ~10 misattributed `S13.2.*` rows
  against value representation / `[[Construct]]` return semantics, where
  their root causes actually are, and close this at +3.
- **(b) Keep open for the representation work.** The one change that would
  retire R1, R3 and R4 together is shrinking the bespoke `$__fnctor_<F>`
  struct population so instances ARE `$Object`s (#3976-style conversion
  applied to fnctors). That is a separate XL slice, not a continuation of
  this one.

Recommendation: (a) plus a new issue for the representation work. Do not
re-run S1/S2 — they are done and pinned.

## Root cause

Two distinct causes, one per slice. Neither is "the walk is broken".

**S1 — the carrier was gated to a population §13.2 does not recognise.**
`resolveUserFnctorName` only admitted fnctors the #2660 escape gate had
*approved for reconstruction*, i.e. constructors with ≥1 `reconstruct`-classified
`new F()` site. §13.2 steps 16–18 give a `.prototype` object to EVERY function,
including one that is never constructed — and that is the population the
S13.2_A1 / S13.2_A4 rows live in. Worse than missing: for a never-constructed
fnctor the base did not merely lack the object, it answered a DIFFERENT one than
the program had just assigned (`F.prototype = p; F.prototype === p` → false),
because the read and the write resolved through different mechanisms.

A second, independent S1 cause: the `=== undefined` observation is compiled by
`property-nullish-read.ts`, which bypasses `property-access-dispatch.ts`
entirely and reads through `__get_member_*` / `__extern_get`. So the ONE arm
that materialises the automatic object never ran on that route, and a single
module could answer `typeof F.prototype === "object"` and
`F.prototype === undefined` at the same time — exactly what `S13.2_A1_T1`
asserts.

**S2 — the instance has no `$proto` field to link.** A `new F()` does not
lower to an `$Object`; it lowers to the bespoke `$__fnctor_<F>` WasmGC struct
minted by `new-super.ts`, and that struct has no prototype slot. Measured in
the emitted WAT: the native `__isPrototypeOf` / `__getPrototypeOf` walk opens
with `ref.test (ref $Object)` on the value, the struct fails it, and the loop
exits before its first iteration. The result is not just a missing link — S1
made the module contradict ITSELF, `F.prototype` answering the new global while
`Object.getPrototypeOf(i)` answered something else.

## Fix

- **S1** (`expressions/fnctor-prototype.ts`, `property-nullish-read.ts`):
  widen `resolveUserFnctorName` with a third arm for fnctors with NO `new F()`
  site in the module, filtered to ORDINARY functions
  (`isOrdinaryFunctionSymbol` — a generator's `.prototype` is
  `%GeneratorPrototype%` and is already answered correctly further down the
  dispatch, so admitting one here would shadow a right answer with a wrong
  one). Install the §13.2 step 10 `constructor` back-ref inside
  `emitFnctorProtoGet` — the single shared mint point — with
  `{writable, !enumerable, configurable}`, declining wherever the identifier
  read is not provably the `__fn_closure_<name>` singleton. Add the
  interception to the `=== undefined` route so both routes share one object.
- **S2** (`fnctor-instance-prototype.ts`, one 5-line hook in
  `call-builtin-static.ts`): answer `Object.getPrototypeOf(i)` from the same
  global when `i` is provably a `new F()` instance, using the per-constructor
  struct type as a static [[Prototype]]. Two conditions, stated once — see the
  Design section.

## Test Results

All runs below executed on this branch by this agent (`--target standalone`,
`tests/test262-runner.ts` standalone lane); base is `793b5c0e1`, the
merge-base the S1 snapshot was taken against.

### Scoped standalone sweeps (base vs S1+S2, both runs mine)

Base is the code at `0e47b7ae0` — this branch immediately before the #4480
work, i.e. the same tree with the five touched files reverted and
`fnctor-instance-prototype.ts` removed. Both directions of every swap were
executed as file copies; no `git stash` was used (shared stack, other agents
active).

| scope | files | base | S1+S2 | flips |
| --- | --- | --- | --- | --- |
| `language/statements/function` + `language/expressions/function` + `language/expressions/new` + `built-ins/Object/getPrototypeOf` + `built-ins/Object/prototype/isPrototypeOf` | 823 | pass 647 / fail 173 / CE 3 | pass **650** / fail 170 / CE 3 | **+3, zero regressions** |
| `built-ins/Function` | 509 | pass 252 / fail 243 / CE 14 | pass 252 / fail 243 / CE 14 | **0 changed either way** |
| **total swept** | **1,332** | | | **+3 / −0** |

Flip list (all three from S1's widened carrier):

- `language/statements/function/S13.2_A1_T1.js` fail → pass
- `language/statements/function/S13.2_A1_T2.js` fail → pass
- `language/statements/function/S13.2_A4_T1.js` fail → pass

The `built-ins/Function` row is the CONTROL, and it is the one worth keeping:
509 files whose statuses are identical in both directions, i.e. the change is
inert on the whole `Function.prototype` surface rather than merely
"probably fine". It was swept precisely because it had been left out of the
first scope.

A focused re-run of the 76-file `language/statements/function/S13.2*` family
gives the same answer independently: base pass 45 / fail 30 / CE 1 →
S1 pass 48 / fail 27 / CE 1, the same three files, no regressions.

### Against the acceptance bar — this is SHORT, and the reason is a finding

The bar asked for **≥15 rows**; the measured result is **+3**. That gap is
not a partially-done implementation, it is what the corpus turned out to
contain, and the evidence is above:

- The issue's premise was that ~25 rows are blocked on the prototype
  substrate. Reading the 27 remaining `S13.2*` failures individually shows
  most are **not** prototype-linkage rows at all: `S13.2.2_A12` wants
  `obj.id === "id_string"` and gets `0` (a typed-field value-representation
  bug — `this.id = 0` types the slot f64 before `this.id = func()` assigns a
  string); `A7_T1`/`A8_T1`/`A8_T2`/`A15_T1..T4` are `[[Construct]]`
  return-value semantics (#4464 F2); `A18_T1/T2` are `arguments.callee`.
  Those were counted toward this issue by their file names, not by their
  root cause.
- `isPrototypeOf` is thin in the corpus generally: **63 files** in all of
  test262 mention it, **7** in this issue's scope. It cannot carry 15 rows.
- The two isPrototypeOf rows that ARE prototype-linkage rows
  (`S13.2.2_A1_T1/T2`) need a **function-valued** prototype, which
  `(ref null $Object)` cannot hold, and would still fail their CHECK#2 even
  if CHECK#1 were folded.

So the honest reading is: the substrate is now correct and documented, and
the ~25-row estimate was an over-attribution. The remaining mass in this
family belongs to value representation and `[[Construct]]` return semantics,
which is where a successor should aim — see Residuals.

### Pins

- `tests/issue-4480.test.ts` — 19 tests green (13 from S1, 5 new S2 pins,
  plus R5). Includes the ordering pin that `Object.getPrototypeOf(F)` still
  reports %Function.prototype%.
- `tests/issue-4464.test.ts` — 20 green; its F3 `it.fails` residual was
  flipped to a passing `it` because S1 closed it.
- Named fn-family controls: `4436`, `4437`, `4440` (56 green), `4442`
  (13 green), `4456`, `4460`, `4464` (20 green) — all green under
  `JS2WASM_EVAL_ENGINE=interpreter`.
- **Eval-tier note:** `4442` and `4464` fail on this container under the
  DEFAULT engine with `quickjs provider is not built`. Verified as
  environment, not regression, by an A/B: the same 6 + 5 failures occur with
  every #4480 file reverted. Building the refusal provider
  (`npx tsx scripts/build-runtime-eval-provider.mjs --refusal-only`) and
  running under `JS2WASM_EVAL_ENGINE=interpreter` makes both files fully
  green.
- `tests/equivalence/` (per-file, scoped to what the diff can touch):
  `issue-799-prototype-chain`, `issue-4123-param-receiver-proto-method`,
  `wrapper-constructors`, `function-name-length`,
  `nested-function-recursion`, `new-expression-spread`,
  `spread-in-new-expressions`, `iterator-protocol-custom` — all green.
  `new-non-constructor` has 2 failures **that predate this work** (A/B'd
  against the reverted tree: identical 2 failures).
- Gates: `typecheck` clean; LOC + function budgets pass with the two
  frontmatter allowances above; `check:oracle-ratchet` reports
  `getTypeAtLocation +0, ctx.checker +0` across the 5 changed codegen files.

## Residuals

| id | shape | why it is still absent | owner |
| --- | --- | --- | --- |
| R1 | `var H = function(){}; new H(); H.prototype` | `H` IS constructed but is not escape-gate-approved (`keep-typed`/`keep-static`), so its instances live in a struct the global is not linked to. Answering would be WRONG, not merely late. | shrink the bespoke-struct population (#3976-style conversion) |
| R2 | `var G = function(){}; G.prototype.constructor === G` | the back-ref needs the `__fn_closure_<name>` singleton, which this shape's identifier read does not go through; the read is answered by the plain-object `.constructor` fold instead. `S13.2_A4_T2`. | #4480 successor |
| R3 | `F.prototype = <a function>; P.isPrototypeOf(new F())` | `$Object.$proto` is typed `(ref null $Object)`, so a closure struct cannot be stored in it. A representation limit; widening the field perturbs the canonical rec-group boundary (#2514). `S13.2.2_A1_T1/T2`. | value-representation |
| R4 | `F.prototype.isPrototypeOf(i)` | **the blocker is the escape gate, not the walk.** Writing the call is itself a dynamic method use on `F`'s prototype, so #2660 demotes `F` and the `.prototype` read stops coming from the global. Instrumented: `struct=108 resolve=undefined`, versus `struct=17 resolve=F` for the same module read through `Object.getPrototypeOf`. A `ref.test` arm was written and measured unreachable, then removed rather than shipped as dead code. | #2660 escape-gate |
| R5 | S2 under a whole `F.prototype = p` reassignment | condition 2 declines by design — one mutable global cannot model "the value captured at construction". | S3 (per-site capture) |
| — | `S13.2.2_A7/A8/A12/A15/A17` (~10 rows) | NOT prototype linkage: `[[Construct]]` return-value semantics and typed-field value representation (`this.id = 0` then `this.id = "s"` types the slot f64). | #4464 / value-representation |

Each of R1–R5 has an `it.fails` pin in `tests/issue-4480.test.ts`, so a
successor that fixes one is told by a failing test rather than having to
re-derive the shape.

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


## 2026-08-20 — R4 also reproduces on the JS-HOST lane

R4 is framed as a standalone substrate problem owned by the #2660 escape gate.
Measured on `main` 2026-08-20, it reproduces **identically on `--js-host`**:

```js
function A() {}
var a = new A();
A.prototype.isPrototypeOf(a);   // false on BOTH lanes — must be true
```

Controls, also run on **both** lanes, both correct on each:

```js
var proto = {}, o = Object.create(proto);
proto.isPrototypeOf(o);                      // true
Object.getPrototypeOf(o) === proto;          // true
Object.getPrototypeOf(a).isPrototypeOf(a);   // true
Object.getPrototypeOf(a) === A.prototype;    // true
```

So the chain walk is correct for any genuine `$Object` receiver on both lanes;
only the `<UserFn>.prototype` **receiver spelling** is wrong, and it is wrong in
js-host too — where the #2660 escape gate and the `$Object.$proto` walk are not
the mechanism.

**Consequence:** R4's "owner: #2660 escape-gate" is incomplete. Either there is a
second, host-side cause producing the same wrong boolean, or the shared cause
sits above both lanes. A fix validated only on standalone would leave the js-host
lane silently wrong, so R4's successor needs a **two-lane** acceptance test.

Worth stressing what class this is: no throw, no refusal, no compile error — just
the wrong boolean, from a plain-JS idiom. It is also **context-dependent**: a
module that first evaluates `Object.getPrototypeOf(a) === A.prototype` then gets
`true` from the same call, so any regression test for it must be a **bare**
module or it will pass while the bug is live.

(Originally filed separately as #4581 before the "(#4480 S2, NOT taken)" comment
at the call site was found; #4581 is retired as a duplicate and points here.)
