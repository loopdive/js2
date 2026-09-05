---
id: 4506
title: "standalone representation: fnctor instances become $Objects — retire the bespoke $__fnctor_<F> struct population (unlocks #4480 R1/R3/R4, isPrototypeOf, dynamic expando)"
status: in-progress
sprint: current
created: 2026-08-15
updated: 2026-08-23
loc-budget-allow:
  # (S2, +49) The two new `classifyUse` arms are 8 lines of code; the rest is
  # the rationale for WHY an `isPrototypeOf` argument and an `in` right operand
  # were invisible to every existing clause (the namespace arm requires an
  # IDENTIFIER receiver, and no real spelling of `isPrototypeOf` has one), plus
  # the measured rows each arm unblocks. This file IS the escape gate's
  # decision record — every existing clause in it carries the same weight of
  # comment, and a clause whose reason is not written down is the exact defect
  # #4123 recorded here (an arm that silently diverged from `classifyUse`).
  - src/codegen/fnctor-escape-gate.ts
  # (S1, +15) ONE early-return arm in `moduleGlobalWasmType` plus the paragraph
  # that says why slot typing and lowering MUST agree (a widened slot whose
  # site keeps the struct is a wrong answer, not a missed row). The decision
  # logic lives entirely in the new module `fnctor-instance-object-slot.ts`;
  # only the hook can live here, because this function is the authoritative
  # module-global slot typer and the arm's POSITION in its cascade is
  # load-bearing.
  - src/codegen/declarations.ts
  # (S1, +4 net) The site half of the lowering gate MOVED OUT to the shared
  # predicate; what is added here is the cache-HIT arm that asks the same
  # question before `funcConstructorMap` can strand an approved site on the
  # struct. Net growth is 4 lines; the comment delta is the rewritten
  # cache-order note, which changed meaning (the old MISS was safe, the new one
  # would not be).
  - src/codegen/expressions/new-super.ts
func-budget-allow:
  # (S1, +19) The cache-hit reconstruct arm has to sit immediately before the
  # `funcConstructorMap` lookup inside this (already-oversized, #3399) driver —
  # that ordering IS the fix. Hoisting it out means hoisting the whole
  # `new`-dispatch chain, which is #3399's refactor and must not ride along
  # with a value-representation change.
  - src/codegen/expressions/new-super.ts::compileNewExpression
  # (S1, +14) Same shape, seen from the function that owns module-global
  # registration: `moduleGlobalWasmType` is a closure declared inside
  # `collectDeclarations`, so an arm added to it counts against the outer
  # function. Splitting it is #3399's refactor.
  - src/codegen/declarations.ts::collectDeclarations
  # (S1, +1) Publishing `siteCtorName` costs one `Map` declaration, one
  # `.set`, and one field in the returned object inside the analysis driver.
  # It exists precisely so the slot typer does NOT re-run a raw-checker symbol
  # query of its own (the oracle-ratchet class of query), and it can only be
  # populated where the resolution already happened.
  - src/codegen/fnctor-escape-gate.ts::analyzeFnctorEscapeGate
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
es_edition: 5
language_feature: object-representation
goal: standalone-gap
related: [4480, 3976, 2660, 4464]
origin: "2026-08-15 #4480 S2 finding — the single change that retires its R1/R3/R4 together is shrinking the bespoke-struct population (#3976-style conversion applied to fnctors). Filed per lead decision (option a) closing #4480 at +3."
---

# #4506 — fnctor instances as $Objects

## Problem

`new F()` for a user function lowers to a bespoke `$__fnctor_<F>` WasmGC
struct with typed fields and NO `$proto` slot and NO expando storage. #4480
S2 papered the [[Prototype]] question with a static per-constructor answer,
but the representation wall remains and blocks, measured:

- `F.prototype.isPrototypeOf(i)` — the native walk `ref.test (ref $Object)`
  fails on the bespoke struct (#4480 R4, `it.fails`-pinned, plus the #2660
  escape-gate demotion evidence recorded in native-is-prototype-of.ts).
- Dynamic expando writes/reads on instances; descriptor semantics on
  instances (#4479's lane stops at `$Object` receivers).
- `[[Construct]]`-return and typed-field value-rep rows misattributed to
  #4480 (S13.2.2_A12: `this.id = 0` types the slot f64, later string write
  wrongs it — the #4480 report's read of the residual corpus).
- #4455 R3 (static accessors need the class OBJECT as $Object) is the class
  twin of this fnctor problem.

## Additional blocked rows routed here (from #4484, 2026-08-16)

The missing `{}` -> `Object.prototype` [[Prototype]] edge alone blocks:
`instanceof/S11.8.6_A1`, `A2.4_T1/_T4`, `in/S8.12.6_A2_T1/_T2`,
`types/object/S8.6.2_A1/_A2` — #4484's family-D `in` guard lands but flips
nothing until this edge exists. Object-literal chain linkage is in scope
here alongside the fnctor conversion.

## Direction (read #4480's Design section + #3976's record first)

#3976 already converted CLASS elements to own-property installs while
keeping nominal structs for dispatch — its issue file documents why the
class object is NOT an `$Object` and what depends on `ref.test` dispatch
(`emitDynamicNewFallback`). The fnctor conversion must either:

- (a) mint instances AS `$Object`s (typed fields become property-table
  entries; escape-gate fast paths become an optimization tier for
  non-escaping instances), or
- (b) extend the bespoke structs with `$proto` + expando side-table slots,
  keeping typed fields (halfway; smaller blast radius; leaves gOPD/descriptor
  semantics partial).

Decide by measurement: count modules in the ES≤5 corpus where the bespoke
representation's fast path is actually load-bearing (perf lane exists in
benchmarks/) vs rows blocked by it. Record the decision matrix in this file
before implementing.

## Plan

1. Brief: plan/method/es5-standalone-agent-brief.md. Read #4480 Design,
   #3976 record, #2660 escape gate, new-super.ts receiver mint (#4464).
2. Measure the decision matrix (above).
3. Slice: (S1) representation change behind the escape gate's existing
   classification — non-escaping instances keep structs, escaping ones get
   $Objects; (S2) [[Prototype]] link at mint via the #4480 global; (S3)
   retire #4480's static getPrototypeOf arm in favor of the real field.
4. Full sweep floor: the #4480 823-file scope + built-ins/Object (descriptor
   interplay) + fn-family pins + equivalence per-file loop; byte-identity on
   modules with no `new <fn>` sites.

## Acceptance criteria

- #4480 R4's it.fails pin flips to passing; ≥10 rows across the
  isPrototypeOf/construct-return/value-rep families; zero regressions on the
  #4480 sweep scope; decision matrix recorded.

---

## Decision matrix — measured 2026-08-22, before any implementation

All figures below come from runs this agent executed on branch `issue-4506`
(base `d0ae8a947`), `--target standalone`, with the lowering gate in
`compileNewFunctionDeclaration` temporarily instrumented (`JS2WASM_LOG_4506=1`,
a `console.error` line reporting the gate verdict per `new F()` site — removed
before commit). Corpus: the **405 files** under `test262/test/language` +
`built-ins/Object` that construct a function declared in the same file
(static scan; 27,135 files scanned). 391 of them reached codegen with ≥1
fnctor site.

### The premise the issue was filed on is WRONG in one important way

The issue says `new F()` "lowers to a bespoke `$__fnctor_<F>` struct with …
NO expando storage", and treats the conversion as unbuilt. Measured on the
base, the conversion (#2660 S3a, `__object_create(F.prototype)`) **is already
built and already fires** — it just almost never reaches its own emission:

| outcome for a `new F()` site (629 sites, 391 files) | n | % |
| --- | ---: | ---: |
| escape gate classifies `reconstruct` (clause A ∧ B) | 579 | 92.1 % |
| `keep-static` (no dynamic consumer found) | 39 | 6.2 % |
| **`keep-typed` (a typed own-field consumer — the #1888 hot path)** | **11** | **1.7 %** |
| of the 579 approved, the S3a lowering FIRES | 464 | 80.1 % |
| of the 579 approved, it DECLINES | 115 | 19.9 % |

and the decline reasons are not evenly spread:

| why an APPROVED site keeps the bespoke struct | n |
| --- | ---: |
| **the binding's Wasm slot is not externref** | **97** |
| non-empty constructor body | 9 |
| constructor arguments | 9 |
| (rows overlap; 115 distinct sites in 115 files) | |

So the dominant blocker is neither the analysis nor the emission. It is that
`fnctorNewResultConsumedAsExternref` refuses to return an externref into a slot
allocated from the checker's nominal instance type `(ref null $__fnctor_F)` —
and it is RIGHT to refuse; doing otherwise `ref.cast`-traps. The slot simply has
to be allocated as externref for the sites the lowering will convert.

### (a) mint instances AS `$Object`s vs (b) extend the bespoke struct

**Verdict: (a), and the measurement that decides it is the 1.7 %.**

| | (a) instances ARE `$Object`s | (b) add `$proto` + expando slots to `$__fnctor_<F>` |
| --- | --- | --- |
| population where the typed fast path is load-bearing and (a) is refused | **11 sites / 1.7 %** — and the escape gate already excludes exactly these (`keep-typed`), conservative-closed | same 11 sites keep working, but so does everything else — no yield either |
| mechanism | already shipped (#2660 S3a) and exercised on 464 sites today; the ONE `$Object.$proto` walk serves it | a SECOND `[[Prototype]]` carrier |
| reflective surface (`isPrototypeOf`, `in`, gOPD, `hasOwnProperty`, for-in, delete, descriptors) | free — every native already answers for an `$Object` | each native needs a new identity-guarded arm for the struct family |
| struct-shape risk | none — `$__fnctor_<F>` is left untouched for every non-converted site | changes every closed fnctor struct shape ⇒ re-enters the #1100/#2009 iso-recursive canonicalization hazard, and every `ref.test (ref $__fnctor_F)` site (instanceof, pinned reads, `emitDynamicNewFallback`) |
| precedent | #3976 did exactly (a) for class prototypes: **+479 of 539** rows | #3976's own plan proposed (b)'s shape for class prototypes and **measured it at 0 of 816** before replacing it |

(b) is also strictly weaker on the thing this issue exists for: the native walk
`__isPrototypeOf` opens with `ref.test (ref $Object)` on the VALUE, so adding a
`$proto` FIELD to the struct does not make the walk see it — the walk itself
would have to learn the second carrier, which is the "six natives' worth of
semantics behind identity guards" that #3976 priced at zero.

**Not measured, stated as such:** the perf lane was not run. The hot-path
argument for (a) is structural, not a benchmark: the gate's clause B excludes
every site with a typed `struct.get` own-field consumer, so a converted site has
no typed field read to move onto `__extern_get`. (Precision note — an
empty-bodied ctor does NOT imply a field-less struct: the #3927 *flow-grown*
scan appends presence-tracked **externref** fields for out-of-ctor
`inst.p = v` writes. Those are not the f64/i32 typed slots the #1888 floor
protects, and clause B still excludes any site that reads one typed.)

### What that makes the first slice

Not "write the conversion" — the conversion exists. **Make the binding slot
agree with it**, which is the #2660 S3b binding-retype narrowed to exactly the
sites the already-validated S3a lowering converts. Everything else in the
matrix follows from that.

---

## S1 + S2 as implemented (2026-08-23) — +2 / −0, and the bar is NOT met

Branch `issue-4506`, one commit. The work is landed and verified; the
acceptance bar (**≥10 rows**) is **not** met — **measured +2** — and the reason
is a finding, recorded in full below rather than rounded away.

### Decision needed (mirrors the #4480 precedent)

The evidence says the ≥10 estimate was an over-attribution, not a shortfall in
the work — the issue's own premise counted blocked *sites*, and a blocked site
is not a blocked row. Left `in-progress` rather than `done`, because this agent
will not mark an issue done against a bar it did not clear. Two options:

- **(a) Accept and re-scope at +2.** The representation is now correct for the
  population the escape gate approves, inert on a 300-file random harness
  control, and every remaining row in the named families has a *measured* other
  cause with an owner (Residuals R1–R7). Re-point the row target at R2 (a wrong
  boolean, cheap, two-lane) and R1 (the non-empty ctor body).
- **(b) Keep open and continue with R1 + R2 in this issue.** R1 is the last
  mechanical blocker inside this issue's own framing (9 of 115 blocked sites);
  R2 is not — it reproduces with no constructor anywhere and belongs to
  `isPrototypeOf` dispatch.

Recommendation: **(a)**, plus a new issue for R2 (which also reproduces on
`--js-host`, so it needs a two-lane acceptance test).

### Root cause

**S1 — the conversion was gated on a SLOT nobody had widened.** See the
decision matrix: 97 of 178 escape-gate-approved sites in the measured corpus
declined for that reason alone. `fnctorNewResultConsumedAsExternref` reads the
binding's REAL allocated Wasm slot type and refuses to return an externref into
anything else — correctly, since that would `ref.cast`-trap. Nothing allocated
the slot as externref, because the module-global typer derives it from the
checker's nominal instance type `(ref null $__fnctor_F)`.

Also part of S1, and NOT cosmetic: the reconstruct decision is per-SITE while
`funcConstructorMap` is per-FNCTOR, so a non-approved sibling `new F()` that
compiled first stranded every later approved site on the cached struct ctor
without ever reaching the gate. That was a tolerable MISS while every slot was
struct-typed. Once the typer widens a slot on the strength of the predicate it
becomes a WRONG answer — a fnctor struct `extern.convert_any`'d into an
`$Object` slot, where every dynamic read fails its `ref.test $Object`.

**S2 — a [[Prototype]] chain walk was not classified as a dynamic consumer.**
`classifyUse` (fnctor-escape-gate.ts) had no arm for either of the two spellings
that walk the chain *over the instance*:

- `<anything>.isPrototypeOf(inst)` — the `Object.*`/`Reflect.*` namespace arm
  requires `callee.expression` to be an IDENTIFIER, and no real spelling of this
  call has one (`Object.prototype.isPrototypeOf(i)`, `F.prototype.isPrototypeOf(i)`,
  `proto.isPrototypeOf(i)` all have a property-access receiver). The argument
  fell through to `neutral`.
- `<key> in inst` — the parent is a `BinaryExpression` whose `right` is the
  instance; the only existing BinaryExpression arm matches `EqualsToken`.

So a fnctor whose ONLY dynamic use is the walk classified `keep-static`, kept
the bespoke struct, and the walk's opening `ref.test (ref $Object)` failed on
it — i.e. **the wrong boolean, from the exact call the substrate exists to
serve.** This is #4480's R4 with its cause named: R4 blamed the escape gate,
and the escape gate is where the fix is, but the mechanism is the
CLASSIFIER, not the `approvedNames` narrowing R4 pointed at.

### Fix

- New module `src/codegen/fnctor-instance-object-slot.ts` owns ONE site-level
  predicate `newExpressionReconstructsAsObject` (standalone ∧ escape-gate
  approved ∧ empty ctor body ∧ no ctor args ∧ not an Array-carrier prototype ∧
  no attribute install on `F.prototype`). It deliberately asks nothing about the
  slot, so it is decidable identically in `collectDeclarations` and in codegen —
  which is what makes the typer and the lowering provably agree.
- `declarations.ts::moduleGlobalWasmType` gains one arm: a module-scope
  `var x = new F()` the predicate converts gets an externref slot.
- `new-super.ts` consults the shared predicate in BOTH the cache-miss gate and
  (new) the cache-hit arm. The slot-type check is left exactly where it was —
  it is the load-bearing safety check, and keeping it means a shape the typer
  does not widen (a function-local binding, a parameter, a `return`) still
  degrades to the struct instead of trapping.
- `fnctor-escape-gate.ts` publishes `siteCtorName` (site → constructor name) so
  the predicate needs no raw-checker symbol query of its own, and `classifyUse`
  gains the two chain-walk arms.

### The ONE regression the A/B found, and why it is excluded rather than fixed

`language/expressions/assignment/8.14.4-8-b_1.js` went pass → fail:

```js
function foo() {}
Object.defineProperty(foo.prototype, "bar", {value: "unwritable"});
var o = new foo();
o.bar = "overridden";           // sloppy mode: §10.1.9 says this is a no-op
assert.sameValue(o.hasOwnProperty("bar"), false);
```

§10.1.9 OrdinarySetWithOwnDescriptor: a set whose PROTOTYPE carries a
non-writable data property of that name creates no own property. Our `$Object`
`[[Set]]` does not implement that lookup. On the bespoke struct the write was
dropped for an unrelated reason (no such slot), so the answer was right by
accident.

**The gap is general to `$Object`, not to this conversion** — the same shape
written with `Object.create` has it on the base as much as on the branch
(probed both ways). So the right fix is in `[[Set]]`, and this slice instead
DECLINES the conversion for the population that can observe it: a fnctor whose
`.prototype` receives `Object.defineProperty`/`defineProperties`/`freeze`/`seal`.
Re-measured: the row is back to pass, and the other 12 attribute-installing
files in the sweep scope are unmoved.

## Test Results

Every run below was executed by this agent on branch `issue-4506`, base
`d0ae8a947`, `--target standalone` through `tests/test262-runner.ts`. The BASE
arm is the same tree with `new-super.ts`, `fnctor-escape-gate.ts` and
`declarations.ts` restored from `.tmp/base-*.ts` file copies (no `git stash` —
shared ref stack, other agents active).

### Scoped standalone A/B — 2,268 files, both arms mine

Scope = the 821 files corpus-wide that construct a function declared in the same
file (the whole population this change *can* touch, by construction) ∪
`language/statements/function`, `language/expressions/{function,new,in,instanceof}`,
`language/types/object`, `built-ins/Object/{getPrototypeOf,prototype/isPrototypeOf,create}`
∪ **300 seeded-random files from the rest of the corpus** as a harness-regression
control (the widening changes `approvedNames`, which the harness's own
`Test262Error` lives in reach of).

| arm | pass | fail | CE | skip |
| --- | ---: | ---: | ---: | ---: |
| base | 1,690 | 460 | 18 | 100 |
| branch | **1,691** | 459 | 18 | 100 |

Flip list — **+2, and after the exclusion above, −0**:

- `language/types/object/S8.6.2_A1.js` fail → pass (S2: `FooObj.prototype.isPrototypeOf(obj__)`)
- `language/types/object/S8.6.2_A2.js` fail → pass (S1: an inherited read on an instance that is also written to)
- `language/expressions/assignment/8.14.4-8-b_1.js` — regressed in the first
  measurement, **restored** by the attribute-install exclusion; re-run on the
  final tree, together with the 12 other attribute-installing files in scope,
  all unmoved.

### Behavioural A/B — a 19-case semantic probe set, both arms

Exactly one case differs, and it is an improvement:

| probe | base | branch |
| --- | --- | --- |
| `i.phylum = "own"; delete i.phylum;` then `i.phylum` (inherited resurfaces) | **wrong** | **correct** |

The other 18 (own/inherited `hasOwnProperty`, `in`, `Object.keys`, for-in, gOPD,
`propertyIsEnumerable`, delete, identity, `typeof`, `String(i)`, prototype-method
call and `this`, two-instance isolation, expando enumeration) are **identical on
both arms**, including three that are WRONG on both — see Residuals.

### Pins

- `tests/issue-4506.test.ts` — **22 green** (4 S1, 6 S2, 5 controls, 4 measured
  `it.fails` residuals + their 3 positive controls).
- Controls, all A/B'd where they fail:
  - `issue-4480` (19), `issue-2660-s3`, `issue-2660-part1`, `issue-2660-m3`,
    `issue-2660-fnctor-escape-gate`, `issue-4437`, `issue-4442`, `issue-4436`,
    `issue-4460` — green.
  - `issue-2660-s2-fnctor-prototype-object` — 10/11; the single failure
    ("non-reconstruct fnctor (no `new`) keeps existing prototype behaviour")
    **fails IDENTICALLY on base**. It is a stale negative pin from the S2 era
    that #4480 S1's never-constructed widening superseded, not a regression here.
  - `issue-4440` (2) and `issue-4456` (9) — **identical 11 failures on base**
    under `JS2WASM_EVAL_ENGINE=interpreter` with the refusal provider built.
    (Without that tier they show 16 failures on both arms, all
    `quickjs provider is not built` / `f is not defined` — the brief's
    eval-tier artifact, not a result.)
- `tests/equivalence/`, per-file (never one invocation — OOM): `issue-799-prototype-chain`
  (5), `issue-4123-param-receiver-proto-method` (10), `new-expression-spread` +
  `spread-in-new-expressions` (9), `wrapper-constructors` +
  `iterator-protocol-custom` (12) — green. `new-non-constructor` has 2 failures
  that are **identical on base** (A/B'd by this agent, not inherited from
  #4480's note).
- Gates: `typecheck`, `prettier --check`, `biome lint`, `check:oracle-ratchet`
  (`getTypeAtLocation +0, ctx.checker +0` across 4 changed files),
  `check:loc-budget` + `check:func-budget` (green with the frontmatter
  allowances above), `check:codegen-fallbacks`, `check:stack-balance`,
  `check:coercion-sites`, `check:pushraw`, `check:any-box-sites`,
  `check:host-import-policy`, `check:dead-exports`, `check:ir-fallbacks` — all
  green.

### Against the acceptance bar — short, and the reason is the finding

The bar asked for ≥10 rows; the measured result is **+2**. As in #4480, the gap
is what the corpus contains, not an unfinished implementation:

- **A blocked SITE is not a blocked ROW.** 97 sites were unblocked by the slot
  widening, in ~97 files — but most of those files use `function Foo(){}` as a
  throwaway helper (an iterator-return stub, a `throw` payload, a
  `Symbol.species` carrier). Converting the instance changes nothing they
  assert. The 97 is a mechanism number; this issue's premise treated it as a
  row forecast, and that is the same over-attribution #4480 recorded.
- **The rows that remain in the named families are blocked by THREE other
  causes**, each measured and each with its own owner — see Residuals. None of
  them is the instance representation, which is now correct for the population
  the gate approves.

## Residuals — measured, with the probe that isolates each

| id | shape | measured state | why it is not this slice |
| --- | --- | --- | --- |
| R1 | `in/S8.12.6_A2_T2` — `function Robin(){this.name="robin"}; Robin.prototype=__proto; "phylum" in new Robin` | fail | The lowering still requires an EMPTY constructor body. Running a real body with `this` bound to the `$Object` is the next slice (9 of the 115 blocked sites). `it.fails`-pinned. |
| R2 | `<plain object>.isPrototypeOf(v)` for a NAMED receiver — `var P={q:1}; var o=Object.create(P); P.isPrototypeOf(o)` | **answers false, wrongly** | **Not a fnctor problem: it reproduces with no constructor anywhere.** `"q" in o` is true in the SAME module, so the chain is live. WAT-decoded on this branch: the ARGUMENT compiles to `ref.null extern` (the call is `global.get <P>; …; ref.null extern; call $__isPrototypeOf`), i.e. `compileExpression` returned VOID for a module-global identifier in this one dispatch. Blocks `S13.2.2_A1_T1`/`_T2`. This is the general form of the wrong boolean #4480 recorded on 2026-08-20 for `<UserFn>.prototype`, which also reproduces on `--js-host` — so its fix needs a two-lane test. `it.fails`-pinned. |
| R3 | `i.hasOwnProperty(<inherited key>)` on a fnctor instance | **answers true, wrongly** | Base answers true too, and so does an arg'd constructor whose site is never converted. `Object.hasOwn` and `gOPD` answer CORRECTLY on the same receiver in the same module, so the own-property table is right and the `hasOwnProperty`/`propertyIsEnumerable` DISPATCH is what consults something chain-aware. Pre-existing; `it.fails`-pinned with the A/B table. |
| R4 | `for (k in <fnctor instance>)` with an inherited enumerable property | counts 0, should count 1 | Identical on both arms; the `Object.create` control counts 1 on both. Same auto-minted-prototype family as R3. `it.fails`-pinned with its control. |
| R5 | `Object.getPrototypeOf(F.prototype) === Object.prototype` | false | The auto-minted prototype object (`__new_plain_object`) is left with a null `$proto`, so the chain stops one link early. #3976 recorded the identical gap for CLASS prototypes and deferred it; the two should be fixed together. `it.fails`-pinned. |
| R6 | `[[Set]]` through a non-writable inherited data property | creates an own property | General `$Object` gap (§10.1.9), not fnctor-specific — see "the ONE regression" above. This slice EXCLUDES the observable population instead of faking it. |
| R7 | `S13.2.2_A8_T1`/`_T2` (`__instance is not a function`) | fail | `[[Construct]]` return-value semantics — #4464's family, already routed there by #4480. |

**Direction for the successor, in priority order:** R2 first (a wrong boolean,
cheap to isolate — the WAT above names the exact instruction), then R1 (the
non-empty ctor body, which is the remaining mechanical blocker), then R3/R4/R5
as one auto-minted-prototype lap.
