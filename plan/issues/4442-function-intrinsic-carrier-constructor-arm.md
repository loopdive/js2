---
id: 4442
title: "Self-contained %Function% carrier + the <fn>.constructor arm (R6 of #4440)"
status: done
completed: 2026-08-15
sprint: 78
assignee: ttraenkler/claude-es5-standalone
created: 2026-08-15
updated: 2026-08-18
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: function-properties
goal: standalone-gap
related: [4440, 4437, 2860, 2660]
origin: "2026-08-15 wave 9 — #4440's R6 residual, with its measurement and narrowing."
loc-budget-allow:
  # All the LOGIC is in the new subsystem module `function-intrinsic-carrier.ts`
  # (the arm's body, the module-kind predicate, the receiver predicate). What
  # lands in these two is the wiring that can only live where the dispatch
  # happens, and it was shrunk twice before asking for the allowance — the
  # arm's body was moved OUT of the dispatcher into the new module for exactly
  # this reason (#3102's "add code to the subsystem module" rule):
  #  - property-access-dispatch.ts +6: a 2-line call to
  #    `tryEmitFunctionValueConstructorRead` + 2 lines of comment, plus the
  #    import. The arm must sit between the existing `any`-receiver `__tag` arm
  #    and the #3006 builtin arm, so it cannot move to another function.
  #  - expressions/identifiers.ts   +3: the bare `Function` read now calls the
  #    SHARED emitter (one changed line), plus its import and a 2-line note
  #    saying why. Routing this read through the same emitter as the
  #    `.constructor` arm is the entire mechanism, so it has to be here.
  - src/codegen/property-access-dispatch.ts
  - src/codegen/expressions/identifiers.ts
func-budget-allow:
  # The same two wiring edits, seen per-function.
  #  - tryConstructorPrototypeIdentity 300 -> 304: this function IS the
  #    `.constructor` dispatch ladder (a sequence of arms, one per receiver
  #    shape); a new receiver shape is one more arm and there is nowhere else
  #    it can go without changing arm ORDER, which is load-bearing here.
  #  - compileIdentifierCore +2: the import line and one changed call.
  - src/codegen/property-access-dispatch.ts::tryConstructorPrototypeIdentity
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
---

# #4442 — self-contained `%Function%` carrier + `<fn>.constructor`

## Problem & prior evidence (READ #4440's issue file R6 + finding 2 FIRST)

`<function value>.constructor` answers `undefined` for every AOT-compiled
closure (never implemented); runtime-eval-tier callables answer correctly.
#4440 built the arm two ways and measured **+9/−1 over the 509-file
`built-ins/Function` directory** — but did NOT ship it, because the working
route (a synthetic bare `Function` identifier read) resolves through
`js2wasm:runtime-eval`, silently ending host-freeness for every
`.constructor`-reading module (#2860; no gate measures this). The narrowing:
`compileIdentifier`'s `Function` resolution in
`src/codegen/expressions/identifiers.ts` (`emitStandaloneIntrinsicFunctionValue`).

## Implementation Plan

1. Build a SELF-CONTAINED `%Function%` carrier: a realm-stable native object
   (the `emitBuiltinNamespaceObject` / lazy-singleton pattern used for
   Array/Object namespace values) that is identity-stable with what
   `f.constructor` must return AND with what a bare `Function` identifier
   read yields in a module WITHOUT the runtime-eval provider linked. In a
   module WITH the provider, identity must match the provider's intrinsic
   (that equality is what #4440's `__builtin_ctor_Function` attempt failed —
   measure it explicitly this time, both provider-linked and provider-free).
2. Re-add the `.constructor` arm on function-valued receivers reading that
   carrier; A/B the 509-file directory (target ≥ #4440's +9/−1, ideally
   fixing the −1: `S15.3.2.1_A1_T10`) and a provider-free probe asserting the
   module emits NO `js2wasm:runtime-eval` import for a plain
   `f.constructor` read.
3. Controls per the campaign methodology: base copies at first edit; both
   arms yours; gc/host byte-identity; #4436/#4437/#4440 pins green.

## Acceptance criteria

- `f.constructor === Function` for AOT closures in both provider-linked and
  provider-free modules, with NO runtime-eval import added to provider-free
  modules; ≥ +9/0 on the 509-file A/B; zero control regressions.

## Implementation record (2026-08-15)

### One premise of the plan above turned out to be unsatisfiable — read this first

The plan asks for a carrier "identity-stable with what a bare `Function`
identifier read yields in a module WITHOUT the runtime-eval provider linked",
and the acceptance criterion asks for `f.constructor === Function` "in both
provider-linked and provider-free modules". **In a provider-free module that
comparison cannot be written.** Reading the bare `Function` value is itself an
`intrinsic-value` boundary site with `providerDisposition: "required"`
(`src/ir/runtime-eval-boundary-plan.ts`), so the moment a source spells
`Function` as a value the module is no longer provider-free. The two halves of
the criterion are the same lever.

That is not a technicality to route around — it is *why* `.constructor` is the
only demand for `%Function%` that a host-free module can make, and therefore
what the provider-free arm exists to serve. The criterion was met in the form
that is actually reachable, and both halves were measured rather than argued:

| module kind | what "identity" means there | verdict |
| ----------- | --------------------------- | ------- |
| provider-LINKED | `f.constructor === Function` is writable, and must be TRUE | **true** for AOT closures, folded `new Function(<const>)`, `new Function(null)`, dynamic `new Function`, and `Function.prototype.constructor` |
| provider-FREE | the equality is unwritable; the reachable guarantee is a single identity-stable `%Function%` with the §20.2.2 shape and **zero imports** | **one carrier** for every function value in the module, `name` `"Function"`, `length` 1, `typeof` `"function"`, import list `[]` |

The one place the provider-free kind CAN name `%Function%` — `globalThis.Function`,
which the plan classifies as a member name and therefore not a site — is the
single measured regression, R1 below.

### What the two rejected attempts actually shared

#4440's R6 lists two fixes and two different reasons for dropping them. They
are ONE reason. `%Function%` had **no single emitter**, so the two sides of
`f.constructor === Function` were free to resolve differently:

| attempt | `.constructor` resolved to | bare `Function` resolved to | outcome |
| ------- | -------------------------- | --------------------------- | ------- |
| 1 — `__builtin_ctor_Function` | the new carrier | the provider intrinsic (unchanged) | two self-consistent objects that are not each other → equality still false |
| 2 — synthetic `Function` identifier | the provider intrinsic | the provider intrinsic | equality true (+9/−1) — and the provider import now rides into every `.constructor`-reading module |

So the fix is not "a carrier" and not "a synthetic read". It is: **make one
emitter own `%Function%`, and let it choose per MODULE.**

### The mechanism

`src/codegen/function-intrinsic-carrier.ts` is that emitter. It dispatches on a
single module-level fact from `ctx.runtimeEvalBoundaryPlan`, built from the
whole program by `buildIrRuntimeEvalBoundaryPlan` **before any lowering runs**,
so two reads in one module cannot take different arms:

| does the module read the BARE `Function` value? | `%Function%` is | why that arm |
| ----------------------------------------------- | --------------- | ------------ |
| YES (an `intrinsic-value` site named `Function`) | `emitStandaloneIntrinsicFunctionValue` (today's route) | must stay CALLABLE — `var F = Function; new F("return 42")` loads the value from the binding at the construct site (`resolvesToGlobalFunctionAlias`); a plain `$Object` carrier has no [[Call]], so serving it here would trade an identity bug for a call bug. It must also equal the value the bare read yields. |
| NO | `emitBuiltinConstructorIdentity(ctx, fctx, "Function")` | self-contained #3006 singleton; emits `__new_plain_object` / `__defineProperty_value`, which are DEFINED functions, never imports. |

#### The predicate is narrow ON PURPOSE, and the first cut was measurably wrong

The first implementation asked the broader question —
`callableBoundaryRequired`, "does this module touch the runtime-eval boundary
at all?" — and the identity-matrix probe caught what that costs:

| `var z = eval("1"); function g(){} … g.constructor …` | answer | imports |
| ------------------------------------------------------ | ------ | ------- |
| base                                                    | (no arm) | `[]` |
| broad predicate                                         | correct | **`[js2wasm:runtime-eval]`** |
| shipped predicate                                       | correct | `[]` |

A foldable `eval("1")` links no provider on base, and the broad predicate made
it link one — silently adding the import that stopped #4440's fix from
shipping, in a shape no conformance number would have shown. The narrow
question is also the CORRECT one: the only thing the provider's `%Function%`
buys is agreeing with a bare `Function` read, and a module that never spells
`Function` has nothing to agree with. The provider's own answer for an
interpreted function (the marker's `constructor` field) is overridden by the
arm uniformly, so such a module stays self-consistent.

This needed one additive field on the plan — `IrRuntimeEvalSite.intrinsicName`
— because `intrinsic-value` conflates a bare `eval` read with a bare `Function`
read. It is recorded at the classification site rather than re-derived by a
second scanner: the classification has non-obvious carve-outs
(`isDirectCalleeIntrinsicValue`, and the `Function.prototype.call.bind(…)`
chain that test262's `propertyHelper.js` opens with — deliberately NOT a site,
after a measured ~24 MB binary delta), and a copy of them would drift. Those
carve-outs now work FOR this arm: a propertyHelper-including module keeps the
self-contained carrier, while `Function.prototype.constructor` — which IS a
site — correctly takes the provider route.

Two consumers call it: the bare `Function` identifier read
(`expressions/identifiers.ts`, previously calling the provider route directly)
and the new `.constructor` arm (`property-access-dispatch.ts`).

**Why the provider-free arm cannot leak an import, structurally.** The boundary
plan counts a bare `Function` VALUE read as a site (`intrinsic-value`,
`providerDisposition: "required"`). So a module that reaches the self-contained
arm provably contains no bare `Function` read that could disagree with it. That
is also why the free arm is reachable at all: `.constructor` is the only way to
demand `%Function%` without naming it.

### The `.constructor` arm

Lives in the property-access dispatcher, not in the own-property surface:
`constructor` is INHERITED (§20.2.3.1 puts it on `Function.prototype`), so
`getOwnPropertyNames` / `hasOwnProperty` / gOPD are deliberately untouched
(#4436/#4437's own-property stratum is unchanged). It fires when the receiver's
static type is function-like — call signatures, OR the ambient `Function`
interface, which is the load-bearing half: `new Function(…)` is typed `Function`
and lib.d.ts gives that interface no call signature, so a call-signature test
alone would miss exactly the family this exists for.

It DECLINES when the module writes or deletes a `constructor` property anywhere
(`moduleTouchesConstructorProp`): an own `constructor` must shadow the
inherited one and the arm never consults the receiver's own properties. Class
VALUES are excluded — `C.constructor` is also `%Function%`, but a class value
has its own `.constructor` lowering and widening into it is unmeasured here.

### Why `builtin-proto-constructor.ts` was NOT extended

`hasBuiltinProtoConstructorCarrier` still declines `Function`, deliberately.
Adding it there routes `Function.prototype.constructor` (and its gOPD
descriptor) to `emitBuiltinConstructorIdentity` UNCONDITIONALLY — i.e. to the
self-contained carrier even in a provider-linked module, which is exactly
attempt 1's split identity re-introduced through a second door. The
property-access arm covers `Function.prototype.constructor` because
`Function.prototype` is typed `Function`; the gOPD path is left as a residual.

### Measurements

Every run below was executed in this worktree, both arms mine. `.tmp/base/`
revert copies were captured at the FIRST edit; the arms are flipped by
`.tmp/to-base.sh` / `.tmp/to-new.sh` inside ONE script (`.tmp/ab-509.sh`) so no
edit can land between them. The quickjs eval provider is held CONSTANT across
arms — its cache key is the compiler-BUNDLE hash and the bundle is not rebuilt
between arms, so the delta isolates the user-module change instead of mixing in
a re-compiled provider.

> **One discarded run, recorded because it is the cheap mistake here.** The
> first base run was launched and then edited into: the batch driver spawns a
> fresh process per batch, so every batch after the first edit compiled with
> the NEW source while being labelled `base`. It was thrown away, not
> reconciled. A second run lost a shard file mid-flight to the worktree's
> isolation sync (it deletes files under the worktree); results now go to the
> session scratchpad, and `ab-509.sh` refuses to print a delta unless BOTH arms
> produced exactly one line per pool file.

The 509-file directory was measured THREE times on the new side — with the
first (broad) predicate, with the shipped (narrow) one, and once more after the
arm's body was moved into the subsystem module for the LOC gate. **All three
produce the same 19 FAIL→PASS files and zero PASS→FAIL**, which is the
prediction the narrowing implies (every flipped file names `Function` in its
assertion, so it is provider-linked under either predicate) and the expectation
the refactor implies (the identity-matrix binaries are byte-for-byte the same
size before and after it).

**Batch runs of this size carry about one file of in-process noise, and it is
not always in the same direction.** The driver does not restore host builtins
between `runTest262File` calls, so a neighbour's pollution can turn a later
compile into an error. Two instances were seen, on different files and in
different runs (`Function/prototype/caller/prop-desc.js` FAIL→COMPILE_ERROR;
`S15.3.2.1_A2_T2.js` PASS→COMPILE_ERROR). **Both were re-run in ISOLATION and
both matched base** (`FAIL` and `PASS` respectively), and each was scored
correctly by the other two full runs. The +19/−0 below is the figure all three
runs agree on once those single slots are resolved; the raw batch totals were
357, 357 and 356.

#### The 509-file `built-ins/Function` directory — **338 → 357, +19 / −0**

Target was ≥ +9/0 (#4440's rejected arm was +9/−1). Every flip is a
`f.constructor === Function` assertion:

```
S15.3.2.1_A1_T2 T3 T4 T5 T6 T7 T11 T12      (8)
S15.3.2.1_A3_T2 T4 T5 T7 T8 T11 T12 T13 T14 (9)
S15.3.2_A1                                   (1)
Function/prototype/constructor/S15.3.4.1_A1_T1 (1)
```

**Why +19 and not +9.** #4440's base had only 3 of the 28-file
`S15.3.2.1_A{1,3}_T*` family failing; this branch's base has 20. The extra 17
are NOT a #4440 regression — they are the provider's own identity split, which
this branch's base exhibits and #4440's did not measure: the base failure
signature for e.g. `A1_T2` is

```
Expected SameValue(«[object Object]», «[object Object]») to be true
```

i.e. BOTH sides are real objects and they are different ones. The bare
`Function` read resolves through `qjsPublish` (the realm's `Function` object,
memoised per handle), while an interpreted function's `.constructor` field is
`qjsIntrinsicFunction` (a marker wrapping `qjsFunctionTarget`) — two distinct
markers. The `.constructor` arm sidesteps that entirely by never consulting the
receiver, which is why the whole family moves rather than the three files
#4440's route could reach.

#### The identity matrix (both module kinds, both arms, imports beside every answer)

`.tmp/probe-matrix.mts`, run on BASE and on NEW. `1` = the assertion holds.

| probe | base | #4442 | imports (both arms) |
| ----- | ---- | ----- | ------------------- |
| **provider-FREE** — `g.constructor` is an object | 0 | **1** | `[]` |
| `g.constructor.name === "Function"` | 0 | **1** | `[]` |
| `g.constructor.length === 1` | **THREW** (read of `undefined`) | **1** | `[]` |
| `typeof g.constructor === "function"` | 1 | 1 | `[]` |
| `g.constructor === h.constructor` | 1 *(as `undefined === undefined`)* | **1 *(same carrier)*** | `[]` |
| `g.constructor === Object` is false | 1 | 1 | `[]` |
| arrow's / class-method's `.constructor` is the same object | 1 *(tautology)* | **1 *(genuine)*** | `[]` |
| an own `g.constructor = 7` write still wins | 1 | 1 | `[]` |
| `g.constructor === globalThis.Function` | 1 *(tautology)* | **0** | `[]` |
| **provider-LINKED** — `g.constructor === Function` | 0 | **1** | `[js2wasm:runtime-eval]` |
| `new Function("return 1").constructor === Function` | 0 | **1** | `[js2wasm:runtime-eval]` |
| `new Function(null).constructor === Function` | 0 | **1** | `[js2wasm:runtime-eval]` |
| `new Function(<dynamic>).constructor === Function` | 1 | 1 | `[js2wasm:runtime-eval]` |
| `Function.prototype.constructor === Function` | 0 | **1** | `[js2wasm:runtime-eval]` |
| `var F = Function; new F("return 42")()` | 42 | 42 | `[js2wasm:runtime-eval]` |
| two bare `Function` reads are the same object | 1 | 1 | `[js2wasm:runtime-eval]` |
| `eval("1")`-only module + `.constructor` | 0 | **1** | **`[]` both arms** |

Two rows deserve to be read carefully rather than counted:

- **The tautology rows.** Several base `1`s are `undefined === undefined`. The
  matrix pairs each of them with a witness (`name`, `length`) that a pair of
  absent values cannot satisfy, because "both sides absent" is exactly how
  #4440's attempt 1 looked green from one side.
- **`globalThis.Function` goes 1 → 0**, and this is the one honest cost. Base
  was accidentally right (both sides `undefined`); now the LHS is a real
  carrier and the RHS is still `undefined`. Neither answer is spec-correct —
  §20.2 says both are `%Function%` and the comparison is true. Recorded as R1
  with the mechanism; it cost nothing in 733 measured files.

#### Controls (all runs mine, same A/B harness)

| control | pool | base | #4442 | diff |
| ------- | ---: | ---: | ----: | ---- |
| **stride sample**, every 102nd file of a 13,127-file pool (`language/{statements,expressions}/{class,function,arrow-function,object,generators}` ∪ `built-ins/Function` ∪ `Object/{gOPN,gOPD,defineProperty,keys}` ∪ `Reflect`) | 128 | 104 | 104 | **status lines byte-identical (`diff` empty)** |
| **targeted `.constructor`-reading sample**, every 4th of the 410 files outside `built-ins/Function` that read a `.constructor` property | 96 | 58 | **59** | +1 / −0 (`Object/prototype/toString/symbol-tag-non-str-proxy-function.js`) |
| **gc/host sha256 byte-identity** — 23 files (`examples` ∪ `website/playground/examples`) plus a 4-file corpus written for this change (function decl, class method, arrow, `.constructor.name`) | 27 | — | — | **all 27 sha256s identical**; expected by construction (both the arm and the emitter return early unless `ctx.standalone`) and measured rather than asserted |

#### The two files that did NOT flip, and the one status change

| file | verdict | why |
| ---- | ------- | --- |
| `S15.3.2.1_A1_T10` (`new Function(null)`) | still FAIL, **but at a later assertion** | the `.constructor` line now passes; it stops at `assert.sameValue(f(), undefined)` with `SameValue(«null», «undefined»)`. The folded `null`-body function RETURNS `null` instead of `undefined` — #4440's fold, not this arm. Recorded as R2. |
| `S15.3.2.1_A3_T15` | same, identical signature | same cause. |
| `Function/prototype/caller/prop-desc.js` | `FAIL` → `COMPILE_ERROR` in ONE batched run | **instrument noise** — see the note above; isolation re-run gives base's own `FAIL` + `caller should be an own property`, and two other full runs scored it `FAIL`. |
| `S15.3.2.1_A2_T2.js` | `PASS` → `COMPILE_ERROR` in ONE batched run | same, and this one WOULD have been a regression if taken at face value. Isolation re-run on the shipped tree: **`PASS`**; the other two full runs also scored it `PASS`. Recorded rather than quietly dropped, because "one PASS→FAIL" is exactly the kind of line that gets rounded away. |

### A pre-existing defect found on the way, deliberately NOT fixed here

`<x>.constructor === undefined` answers **true even when `.constructor` is a
real object**, and it does so on BASE: measured `new Set().constructor ===
undefined` → true on the unmodified tree, while `typeof` and truthiness on the
same expression both say "object". So the comparison lowering for this shape,
not the `.constructor` read, is wrong. It is unchanged by this slice (identical
both arms) and is recorded as R3 rather than folded in — it is a strict-equality
lowering question with its own blast radius.

## Residuals, with owners

| id | residual | why it is not fixed here | owner |
| -- | -------- | ------------------------ | ----- |
| **R1** | `g.constructor === globalThis.Function` is now `false` in a provider-free module (base: accidentally `true`, as `undefined === undefined`). §20.2 wants `true`. | `globalThis.Function` puts `Function` in MEMBER-NAME position, which the boundary plan deliberately does not count as a site — so the module stays provider-free and the member read still answers `undefined`. The fix is symmetrical and cheap in principle (route a `globalThis.Function` / `this.Function` member read through `emitStandaloneFunctionIntrinsicValue`, which would answer the carrier host-free in exactly these modules), but it widens the arm from property-access-on-a-function to global-object member reads, and that surface is unmeasured here. Cost measured: 0 files across the 733 A/B'd. | **unowned — narrow follow-up** |
| **R2** | `S15.3.2.1_A1_T10` / `_A3_T15` still fail — at a LATER assertion. `new Function(null)`'s folded function returns `null` where §14.2 wants `undefined`. | Not a `.constructor` defect: the `f.constructor` line now passes and the file stops at `assert.sameValue(f(), undefined)` with `SameValue(«null», «undefined»)`. This is #4440's `null`-body fold producing a body whose completion value is `null`. | **unowned — #4440's fold** |
| **R3** | `<x>.constructor === undefined` compares true against a real object (pre-existing; see above). | A strict-equality lowering question, identical on both arms. Fixing it inside this slice would put an unmeasured comparison change behind a measured identity change. | **unowned** |
| **R4** | `gOPD(Function.prototype, "constructor")` still has no descriptor. | `builtin-proto-constructor.ts` was deliberately NOT extended — see above: routing `Function` there would serve the self-contained carrier UNCONDITIONALLY, re-introducing attempt 1's split identity in provider-linked modules through a second door. The right shape is for that module to call the same `%Function%` emitter, which is a follow-up with its own descriptor-surface measurement. | **unowned** |
| **R5** | Generator / async functions answer `%Function%`, where §27.3 wants `GeneratorFunction` / `AsyncFunction`. | The arm keys on the receiver's static type, which has call signatures for all of them. Base answered `undefined`, so no assertion that passed can start failing on a WRONG value — only on a differently-wrong one; the 128-file stride control (which includes `language/statements/generators`) is byte-identical. Fixing it needs the mint-site declaration, not the type. | **unowned** |
| **R6** | `.constructor` on an `any`-typed receiver holding a function still answers via the `__tag` route or `undefined`. | The arm is static-type-keyed. The runtime counterpart is an `__extern_get` arm in the shape of #4223's wrapper arm; it is a separate, measurable slice. | **unowned** |
| **R7** | In a provider-LINKED module every `<fn>.constructor` read emits a fresh indirect-eval call to evaluate the source `"Function"`. | It is exactly what a bare `Function` read already costs, so the arm adds no NEW mechanism — but a `.constructor` read in a loop now pays it per iteration. Memoising the intrinsic in a module global is a contained follow-up with its own (perf) measurement. | **unowned** |

## Gates

`typecheck`, `check:stack-balance`, `check:ir-fallbacks`,
`check:oracle-ratchet` (**+0/+0** across 4 changed `src/codegen` files — the two
predicates read `ts.Type` objects the dispatcher already has, and add no
`checker.getTypeAtLocation` / `ctx.checker` call), `biome lint` — all OK.
`check:loc-budget` and `check:func-budget` need the allowances in this file's
frontmatter (rationale in the comments there); with them, both OK.

## Vitest

- `tests/issue-4442.test.ts` — new, **13 tests**, split deliberately into a
  provider-FREE describe that asserts the IMPORT LIST (the observable #4440's
  fix failed and no gate measures) and a provider-LINKED describe that runs
  through the real provider seam (`scripts/test262-import-object.mjs`).
- `tests/issue-4440.test.ts` — its `f.constructor` pin FLIPPED, per the
  instruction written at that site ("when the `%Function%` carrier lands … this
  assertion flips"). It now asserts the carrier's shape rather than
  `=== Function`, because that file's `runStandalone` instantiates against an
  EMPTY import object and writing `Function` there would make the module
  provider-linked — the split this issue introduces, restated as a test
  constraint.
- Controls, all green: `issue-4440` (14), `issue-4437` (19), `issue-4436` (23),
  `es5-standalone-ctor-identity`, `issue-2026-constructor-identity-any`,
  `issue-4223` — **56 + 37 + 13 = 106/106**.
