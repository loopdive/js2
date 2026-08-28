---
id: 4406
title: "return-type unboxing ABI: i32/f64-returning callee twins so booleans and numbers cross calls unboxed"
status: in-progress
sprint: current
created: 2026-08-14
priority: high
horizon: xl
feasibility: hard
task_type: perf
area: codegen
related: [4157, 4405]
# (2026-08-28, Phase 4) The admission filter has to land in
# `numeric-property-analysis.ts` because that is where the `numericFunctions`
# verdict is COMPUTED and PUBLISHED — the whole point of the slice is that both
# of the verdict's consumers (`refinedTwinReturnType` and
# `provenNumericOperand`) read one filtered set, so filtering at either consumer
# would reintroduce the disagreement it exists to remove. +65 there is ~50 lines
# of the measured loop-vs-publication rationale (the loop variant costs +19.9 %
# executed boolean boxes) plus the host field's contract; the code itself is 6
# lines. `index.ts` +9 is the two wiring sites the previous phases already used,
# minus the now-dead `analyzeBooleanPropertyNames` import.
# GRANTS RESTATED HERE DELIBERATELY: Phases 0+1/2/3 listed the same paths, but a
# grant is only live in a PR that also modifies this file, so an un-restated one
# is stranded and fails `quality` on CI's merge preview.
# (2026-08-28, Phase 3) The parameter half needs the same shape Phase 1 needed
# and for the same stated reason: §5.1 makes the twin's minting and the
# trampoline's reservation ask ONE function, so `refinedTwinParamTypes` has to
# sit in `typed-this.ts` beside `refinedTwinReturnType` (it reads the private
# `writeOnceMethodKeyOf`), the twin's param list and the shim suppression have
# to land at the minting site in `closures.ts::compileArrowAsClosure`, and the
# published verdict needs a context field plus the same two wiring sites in
# `index.ts` the previous phases used. Everything that COULD move out did: the
# ~210-line analysis, both flag predicates and the census live in the new leaf
# `src/codegen/param-unbox-abi.ts`, which is what holds `typed-this.ts` to +97
# and `closures.ts` to +21.
# (2026-08-27, Phase 0+1) The plan keeps `refinedTwinReturnType` as the SINGLE
# decision point (§3.2/§5.1), so the boolean arm has to land in `typed-this.ts`;
# the shim's brand-driven re-box has to land at the twin's minting site in
# `closures.ts` (§3.3a); the ToBoolean return arm has to land at the one return
# coercion choke point in `statements/control-flow.ts` (§3.3c); the published
# verdict needs a context field and two wiring sites in `index.ts` (§3.1). The
# ~40-line census was moved OUT to the new leaf `src/codegen/ret-unbox-abi.ts`
# rather than granted, which cut the `typed-this.ts` growth from +123 to +44.
loc-budget-allow:
  - src/codegen/typed-this.ts
  - src/codegen/index.ts
  - src/codegen/statements/control-flow.ts
  - src/codegen/closures.ts
  - src/codegen/context/types.ts
  - src/codegen/numeric-property-analysis.ts
func-budget-allow:
  - src/codegen/closures.ts::compileArrowAsClosure
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
---

# #4406 — return-type unboxing ABI

## Problem

Cross-function boxed traffic is the residual every intra-body pass hits and
cannot touch. Measured on the acorn self-parse (#4157 entries 42/44 and the
lever-4 rebuild): `__box_boolean` executes **310,279** times even with the
fusion pass on, because the box happens in a CALLEE (`__call_m_eat_1` et al.
return a boxed boolean) and the unbox/truthy-test happens in the CALLER —
lever 4's decline tally names the shape precisely: prev-call=372 sites,
arm-tail-call=104, plus ~965 local-flow sites that ultimately source from
calls. The same story holds for numbers via `__box_number`/`__unbox_number`
(214,677 executed unboxes, entry 39).

## Shape of the work

For a function whose result is provably always a boolean (i32) or number
(f64) — starting with the emitted helper families (`__call_m_*` boolean
returners, predicate closures) and extending to user closures with proven
numeric results:

1. Emit an **unboxed twin** `<fn>__ret_i32` / `<fn>__ret_f64` alongside the
   externref-returning original (or rewrite the original and shim the boxed
   signature, whichever keeps the call-graph patch smaller).
2. Rewrite call sites whose consumer wants the raw value (truthiness tests,
   arithmetic, comparisons) to call the twin directly — the box/unbox pair
   vanishes across the boundary.
3. Provenance: result-type proof comes from the emitters (for helpers, the
   fill knows the result) and from `ctx.oracle` signatures for user code —
   never the raw checker.
4. Flag-gated (`JS2WASM_RET_UNBOX_ABI`, default OFF), byte-identical off,
   poison probe, census verdict on `__box_boolean`/`__unbox_number`.

## Interlock with #4405

Receiver-type specialisation multiplies this: typed method variants want
typed RESULTS too, or every proven-receiver call still round-trips its return
value through a box. Spec the ABI so #4405's variants can adopt it directly.

## Acceptance criteria

- `__box_boolean` executed count drops below 100k on the acorn lane with the
  flag on (from 310,279); `__unbox_number` materially down from 214,677.
- Checksum 422; scoped equivalence green; flag-off byte-identical.
- Architect spec in this file before implementation (the twin-vs-shim
  decision and the call-graph patch strategy are the load-bearing choices).

> **Amended by the Implementation Plan below (architect, 2026-08-14).** The
> `__box_boolean < 100k` target is **not reachable from return-type work
> alone** — measured, §1.4: only ~15 % of executed boolean boxes are anywhere
> near a call boundary, and the return half of the ABI is *already shipped*
> (as f64, incorrectly — §1.2). See §7 for the amended, measurable criteria.

---

## Implementation Plan

**Architect, 2026-08-14.** Written against `spec-4405-receiver-spec`
@ `12b5b0bb7` (= `recover/levers-integration` + #4405's spec). Every number
below is MEASURED on this tree; §0 is how, §1 is what it corrects.

### 0. Reproduction — the two commands everything here rests on

`.tmp/probe-4406-census.mjs`, modelled on the committed
`tests/dogfood/cold-tail-census.mjs` (same driver, same `checksum =
parse(acorn's own dist).body.length = 422`), plus the `JS2WASM_EXEC_CENSUS`
instrument of `src/codegen/exec-census.ts`:

```js
// .tmp/probe-4406-census.mjs — compile standalone acorn + self-parse,
// then read every `__exec_count_*` exported global.
const result = await compile(`${acornSource}\n${driver}`, {
  fileName: "acorn.mjs", skipSemanticDiagnostics: true,
  target: "standalone", optimize: 0,
});
const { exports } = await WebAssembly.instantiate(await WebAssembly.compile(result.binary), {});
const checksum = exports.__census_run();          // 422
```

```bash
# A — flags OFF (today's default artifact)
JS2WASM_EXEC_CENSUS=__box_boolean,__unbox_boolean,__box_number,__unbox_number,__is_truthy \
  npx tsx .tmp/probe-4406-census.mjs

# B — the tuned-11 + four levers (the configuration the issue's numbers come from)
export JS2WASM_INLINE_PROP_IC=8 JS2WASM_INLINE_TRUTHY_IC=1 JS2WASM_IR_INLINE=on \
  JS2WASM_FUSED_TONUMBER=1 JS2WASM_SMI_FASTPATH=all JS2WASM_LAZY_STR_FLATTEN=1 \
  JS2WASM_ELIDE_PROVEN_NONNULL_TYPEERROR=1 JS2WASM_INLINE_HINTS=1 \
  JS2WASM_SET_MEMBER_F64=1 JS2WASM_RECEIVER_CSE=1 JS2WASM_EXTERN_GET_IC=1 \
  JS2WASM_FLAT_STR_IC=1 JS2WASM_SET_MEMBER_IC=1 JS2WASM_CALL_DISPATCH_IC=1 \
  JS2WASM_UNBOXED_BOOL_FUSE=1 JS2WASM_UNBOXED_BOOL_FUSE_DEBUG=1
```

~55–65 s per compile, `optimize: 0`, `target: "standalone"`, acorn 8.16.0 from
the pinned tarball. **Checksum 422 in every run recorded below.**

| lane | binary B | `__box_boolean` | `__unbox_number` | `__box_number` | `__is_truthy` |
| --- | ---: | ---: | ---: | ---: | ---: |
| A — flags off | 2,558,246 | **333,363** | **883,318** | 489,166 | 997,454 |
| B — tuned-11 + 4 levers | 3,497,429 | **224,339** | **214,677** | 1 | 237,193 |
| C — B minus `INLINE_TRUTHY_IC` | 3,424,094 | 224,339 | 214,677 | — | 878,859 |

Lane B reproduces the issue's **`__unbox_number` 214,677 exactly**, which is
what certifies the flag set above is the one the issue text was measured with.
(`__unbox_boolean` = **2** in every lane — see §1.5, that is not a rounding
artefact, it is a warning.)

### 1. Root cause — five corrections, and one of them is a live miscompile

#### 1.1 The `booleanFunctionNames` fixpoint the brief asks for ALREADY EXISTS

`inferBooleanFunctionNames` (`struct-field-boolean-brand.ts:147-172`) is a
name-keyed greatest fixpoint over `facts.functionsByName`, structurally
identical to `numericFunctions` (`numeric-property-analysis.ts:1267-1279`) —
same `ownReturnExpressions` precondition, same "one non-boolean return kills
the name" rule, same safety counter. Its predicate `expressionIsBoolean`
(`:115-145`) already routes through **`ctx.oracle.isBooleanProducing`** and
`isSyntacticallyBooleanExpr`, so it is oracle-clean.

It runs on **every** standalone compile (`index.ts:4312`, `:7281`) and its
result is **thrown away** — `analyzeBooleanPropertyNames` (`:330-356`) uses it
only as an input to the boolean *property* verdict and returns just the
property set.

Measured on acorn: `functionsByName=322`, **`booleanFunctions=83`**. The 83 are
exactly the predicate family the issue is about: `eat`, `eatContextual`,
`eatChars`, `isContextual`, `canInsertSemicolon`, `hasProp`,
`braceIsBlock`, `shouldParseArrow`, `isSimpleParamList`, plus all 40
`regexp_eat*`.

**So Phase 0 is ~15 lines of plumbing (export it, hang it on `ctx`), not a new
analysis.** Do not write a second fixpoint.

#### 1.2 `numericFunctionNames` ALREADY CONTAINS ALL 83 — so the boolean twins exist TODAY, minted as f64

Measured: `numericFunctions=102`, `booleanFunctions=83`, **intersection = 83,
boolean-only = 0**.

Why: `Prover.isNumeric` deliberately answers TRUE for booleans — the oracle
fast path accepts `fact.kind === "boolean"` (`:950`), `true`/`false` keywords
(`:953`), `!x` (`:958`) and every `BOOLEAN_BINARY` operator (`:970`). The
property loop compensates with an `anyBoolean` filter (`:1319-1322`) and the
grounded-slot loop with `isBooleanish` (`:1373`, `:1379`) — **the
`numericFunctions` loop (`:1267-1279`) has no such filter.**

Consequence, and it is the single most important fact in this file:
`refinedTwinReturnType` (`typed-this.ts:1073`) asks
`ctx.numericFunctionNames?.has(methodName)` and therefore mints an **`f64`**
twin for `eat`, `isContextual`, every `regexp_eat*` — today, default-on, on the
shipped artifact. The return half of this issue's ABI **is already built**; it
is just built with the wrong type.

That is also why the AC's premise is off: those returns are **not** boxed at
the boundary any more. `if (this.eat(tt.comma))` receives an f64 and
`emitToBoolean` lowers it to `|x| > 0` with no helper call at all.

#### 1.3 It is a MISCOMPILE, not just a representation smell — reproduced

`.tmp/probe-4406-boolret.mjs`, the acorn prototype-method idiom:

```js
function P(n) { this.n = n; }
var pp = P.prototype;
pp.eat = function (x) { return this.n === x; };
export function strlen() { var p = new P(5); return ("" + p.eat(5)).length; }
```

| build | `("" + p.eat(5)).length` |
| --- | ---: |
| node | **4** (`"true"`) |
| standalone, default flags | **1** (`"1"`) |
| standalone, `JS2WASM_DIRECT_CALLS=0` | 4 |

`JS2WASM_NUMERIC_TWINS=0` does **not** fix it, so this is not only
`refinedTwinReturnType`: the second consumer of the same unfiltered verdict is
`provenNumericOperand` (`binary-ops.ts:974-1001`), whose call rule (`:993-999`)
treats `<recv>.m()` as a numeric operand whenever the NAME is in
`numericFunctionNames`. Both consumers inherit the missing boolean filter.

acorn's checksum stays 422 because these 83 predicates are only ever consumed
in conditions, where an f64 0/1 and a boolean 0/1 agree. **A corpus that
stringifies, `typeof`s, or `JSON.stringify`s a predicate result gets `1`.**

Route this as its own defect (see §6, Phase 4) — a correctness bug should not
ship behind a perf flag — but #4406 is where it gets found and where the
machinery to fix it lands.

#### 1.4 The `__box_boolean` residual is NOT return traffic — measured producer census

A temporary finalize-time pass (bump one exported i32 global per *consumer
shape* immediately before each `call __box_boolean`; same stack-neutral
discipline as `exec-census.ts`, applied at finalize where
`applyRefNullFixups` can no longer be desynchronised) on lane B with the fuse
off (total `__box_boolean` = 238,653):

| consumer shape | executed | share | what it is |
| --- | ---: | ---: | --- |
| tail of a block/arm | 148,173 | 62 % | the logical-value `if`-merge leaf — lever 4's target |
| `local.get` next | 68,622 | 29 % | **argument position** (box arg N, push arg N+1) |
| `local.set` next | 44,459 | 19 % | stored into a local |
| `call __dc_*` next | 36,151 | 15 % | **last argument of a devirtualized call** |
| `br` next | 19,978 | 8 % | branch-carried merge value |
| `i32.const` next | 12,570 | 5 % | argument position (const arg follows) |
| `return_call` next | 1,760 | 0.7 % | tail-call argument |
| `return` next | **0** | 0 % | **a boxed boolean RETURN — none** |

> **Caveat, state it in the PR:** the buckets sum to 333,286 = **1.40×** the
> authoritative `exec-census` total of 238,653, and I could not reconcile the
> gap (a dedup of shared body arrays — 2,675 of them — changed nothing, so the
> duplication is in dead bodies). Treat the table as a **ranking**, not as
> absolute counts. Reconciling it to the total is Phase 0's checkpoint.

Two conclusions the ranking supports even at 1.4× slack:

1. **`then_return` is literally zero.** There is no boxed-boolean return left to
   remove; §1.2 explains why.
2. **The two big buckets are the logical-value merge (62 %) and ARGUMENT
   passing (29 % + 15 % + 5 %).** The argument half is the *parameter*-type ABI,
   which is the mirror image of what this issue is titled after and is
   explicitly the shape `typed-this.ts:798-810` already documents
   (`this.parseExprOp(…, false, false, forInit)` — "two `false` arguments are
   `i32.const 0` + `call __box_boolean`").

#### 1.5 The numeric half is DONE; the 214,677 `__unbox_number` is #4405's, not this issue's

`JS2WASM_DIRECT_CALLS_DEBUG=1` on this tree:

```
[direct-calls] sites=3976 trampolines=545 twinFills=516 genericFills=29 legacyFills=0
[direct-calls] declined: no-write-once-verdict=208 named-fn-expr=16 uses-arguments=8 ref-typed-param=4
```

**`legacyFills=0`** — `fillDirectCallTrampolines`'s signature-disagreement
degrade (`typed-this.ts:1853-1862`) never fires. So the answer to the brief's
question 5 is: *zero* of the residual `__unbox_number` is "existing f64 twins
not being used at some call sites". Every reserved trampoline reaches its twin
with the refined result. The 214,677 is member-read traffic — `__fnctor_Node`'s
AST payload living in `$resid` — i.e. **#4405 Phase 2**, and this issue should
not claim it.

And `__unbox_boolean` executes **2 times per parse** in every lane. That number
is a warning, not a null: it means the boolean-unbox path is effectively
untested at scale, and Phase 1 is about to route the trampoline legacy arm
through it (§3.3).

### 2. Verdict on the load-bearing choice: TWIN, not shim — and the seam is already there

The brief's twin-vs-shim question is already answered by the shipped #3754
machinery, and the answer transfers to booleans unchanged:

- the **twin** carries the refined result (`closures.ts:3111-3112`, minted with
  `twinResults`);
- the **generic body** keeps its declared `externref` result and gets a
  re-boxing shim instead of a tail call (`closures.ts:3178-3197` →
  `buildTypedThisForwardGuard`'s `boxTwinResult`, `typed-this.ts:339-351`,
  `:372-376`);
- the **trampoline** follows the twin, not the declaration
  (`typed-this.ts:1658-1679`), and `fillDirectCallTrampolines` degrades to the
  legacy dispatcher on any signature disagreement rather than emitting an
  invalid module.

`ctx.directCallTwins` (`typed-this.ts:946-956`) already stores
`params: ValType[]` / `results: ValType[]`, and `ValType` already carries the
boolean brand (`src/ir/types.ts:214` — `{ kind: "i32"; boolean?: true }`). So
**no registry change and no new twin kind is needed**: the entire change is
which `ValType` `refinedTwinReturnType` returns.

The one thing that would justify a shim instead — "the caller cannot consume an
i32" — is false, verified: `emitToBoolean` (`coercion-engine.ts:505`, i32 arm
documented at `:503`) passes an i32 through untouched, and
`coerceType(i32 → externref)` (`type-coercion.ts:2454-2467`) already picks
`__box_boolean` off the brand. **The caller side needs no new emitter for the
truthiness case.**

### 3. Changes

#### 3.1 Publish the boolean-return verdict — `struct-field-boolean-brand.ts`, `index.ts`, `context/types.ts`

- **`src/codegen/struct-field-boolean-brand.ts`** — promote
  `inferBooleanFunctionNames` (`:147`) to an export, or (preferred, one
  traversal) have `analyzeBooleanPropertyNames` (`:330`) return
  `{ properties, functions }` and adapt its two call sites. Keep every type
  query on `ctx.oracle` — this file is already clean and must stay so.
- **`src/codegen/context/types.ts`** — add
  `booleanFunctionNames?: ReadonlySet<string>;` beside
  `numericFunctionNames` (`:2328`) and `booleanPropertyNames` (`:2302`).
- **`src/codegen/index.ts`** — assign it at **both** wiring sites, or the
  single-source and multi-source lanes disagree: `:4306-4316` (the standalone
  single-source path, which already computes the boolean analysis at `:4312`
  purely for `excludeNames` — reuse that call, do not add a third traversal)
  and `:7280-7282`.

#### 3.2 The decision point — `typed-this.ts:1054` `refinedTwinReturnType`

Keep it the **single** decision point (its header at `:1048-1052` records why:
both consumers ask it, so they cannot disagree). Insert the boolean test
**before** the numeric one:

```ts
if (process.env.JS2WASM_RET_UNBOX_ABI !== "1") return numericPathAsToday();
...
if (ctx.booleanFunctionNames?.has(methodName) === true) {
  if (ctx.funcMap.get("__box_boolean") === undefined) return undefined; // shim needs it
  return { kind: "i32", boolean: true };
}
if (ctx.numericFunctionNames?.has(methodName) !== true) return undefined;
return { kind: "f64" };
```

Order matters and is not cosmetic: boolean ⊂ numeric (§1.2), so a numeric-first
test claims all 83 names as f64 and the boolean arm is dead code.

Do **not** subtract the 83 names from `numericFunctionNames` in this PR. That
set has a second consumer (`provenNumericOperand`, `binary-ops.ts:993-999`)
whose behaviour would change with the flag off — see §6 Phase 4.

#### 3.3 The two boxing edges — and the one that is a trap

**(a) `closures.ts:3178-3180`** currently hard-codes the shim's re-box:

```ts
const boxNumberIdx = refinedReturn !== undefined ? ctx.funcMap.get("__box_number") : undefined;
```

It must select on the brand — `__box_boolean` for `{i32, boolean}`,
`__box_number` for `f64`. Keep the existing "read the index HERE, not at
refinement time" discipline (the comment at `:3174-3177` explains it: compiling
the twin may have added late imports and shifted every index).

**(b) `typed-this.ts:1752-1781` `unboxFromExternref` — the trap.** Its
`i32 && boolean` arm (`:1763-1768`) calls **`__unbox_boolean`**, and that helper
is documented at `closure-exports.ts:552-561` as recognising *only* boxed-boolean
carriers — a boolean arriving as the engine's **i31 numeric carrier** makes it
answer false, and that exact bug already "turned true conditions into false
across the closure bridge" once. The arm is **dead today** (nothing produces an
i32-boolean trampoline result — `__unbox_boolean` executes 2×/parse, §1.5) and
goes **live the moment Phase 1 lands**, because `buildLegacyArm`
(`typed-this.ts:1865-1878`) unboxes the dispatcher's externref result to
`t.results[0]`.

Use the same defence `closure-exports.ts` chose: `__unbox_number` +
`i32.trunc_sat_f64_s`, which recognises i31, boxed-number **and** boxed-boolean.
This is the highest-risk line in the whole change and it is invisible to the
acorn lane (that arm is reached only on a `ref.test` miss).

**(c) `coerceType(externref → i32)` (`type-coercion.ts:2195-2205`) is ToNumber +
truncate, NOT ToBoolean.** This breaks the #3754 soundness argument's transfer:
for `f64` the imposed coercion is ToNumber, which is the identity on numbers, so
an imprecise fixpoint costs only performance. For `{i32, boolean}` an imprecise
verdict silently *changes the value* — a return expression that lowered to a
boxed `"abc"` yields `0` (ToNumber → NaN → trunc) where ToBoolean says `1`.
Either add a boolean-target arm that routes through `emitToBoolean`, or state
explicitly in the PR that the proof is trusted; do not leave it implicit. The
`tryEmitTypedThisFieldSet` precedent (`typed-this.ts:519-525`) is the shape to
copy — it normalises through ToBoolean and *then* stamps the brand.

#### 3.4 Caller side — what actually needs doing (much less than the issue text implies)

Verified, no change required:

| consumer | site | already correct because |
| --- | --- | --- |
| `if (call())`, `while`, `?:` cond | `ensureI32Condition` `index.ts:10655` → `emitToBoolean` `coercion-engine.ts:505` | i32 passes through untouched |
| value escapes to externref | `coerceType` `type-coercion.ts:2454-2467` | brand-driven `__box_boolean` |
| `===`/`!==` against `true` | native standalone strict-eq | the brand is what makes `boxedBool === true` hold (`:2456-2460`) |
| the single call-site emitter | `call-receiver-method.ts:347-354` | returns `tryEmitDirectTwinCall`'s `ValType` verbatim as `InnerResult` |

Change required — **Phase 2**: the logical-value merge
(`expressions/logical-ops.ts`) types its `if` as `(result externref)`, so an
i32-returning arm tail re-boxes. That is the 62 % bucket, and it is exactly
lever 4's `arm-tail-call=102` decline (`box-boolean-fuse.ts:207`) plus its
`prev-call=366`. `box-boolean-fuse.ts:61-64` names this issue as the closer.
With i32-returning callees, the arm tails become i32 and either (i) lever 4's
plan succeeds where it declines today, or (ii) the merge is typed `(result i32)`
at emission. Prefer (i) — it reuses a shipped, poison-proven pass.

### 4. What this cannot reach, and the honest arithmetic

Return-type unboxing removes boxes at `then_return` sites. **Measured: 0.**
Phase 2 (merge typing) addresses up to 62 % of the executed boxes but only for
merges whose every leaf fuses. The 29 % + 15 % + 5 % argument buckets need the
**parameter** half of the ABI, which is a different change to the same registry
(`DirectCallTrampoline.params` is `[externref, ...userParams]` by construction —
`typed-this.ts:853`, and the reserve site rejects `ref`-typed params at `:1644`
for a *fixup* reason that does not apply to `i32`).

So: `< 100k` is reachable only if Phases 2 **and** 3 both land. Amended criteria
in §7.

### 5. Interlock with #4405 — compliance, stated explicitly

#4405's spec §5 sets two rules. Both are honoured:

1. **`refinedTwinReturnType` stays the single decision point.** §3.2 adds a
   branch *inside* it; no new call path computes a result type. The trampoline
   reservation (`typed-this.ts:1661`) and the twin minting (`closures.ts:3111`)
   keep asking the same function, so they cannot disagree, and
   `fillDirectCallTrampolines`'s `twinSignatureAgrees` check
   (`typed-this.ts:1853-1862`) remains the backstop.
2. **Variants register in the `directCallTwins`-shaped map.** No new registry;
   `recordDirectCallTwin` (`:946`) already carries `results: ValType[]` and the
   boolean brand rides inside the ValType. When #4405 Phase 3 adds its
   write-side variant, it registers in the same map and this issue's call-site
   rewrite has one place to look.

Conversely, one thing #4406 owes #4405: the boolean verdict (§3.1) is also what
#4405 Phase 2 needs to decide whether a promoted `Node` payload slot is a
boolean i32 or an externref. Land §3.1 first and both phases read it.

### 6. Phasing — four landable PRs

Every phase: `JS2WASM_RET_UNBOX_ABI` default **OFF**; `sha256sum` of the
emitted binary identical to base with the flag off; a poison probe; checksum 422.

> **Byte-identity caveat — the same one #4405's spec §4 states.** The typed-this
> / direct-call machinery is default **ON**, so "flag-off byte-identical" means
> *identical to today's default-on artifact* (**2,558,246 B** flags-off,
> **3,497,429 B** on lane B), not to some untyped baseline.

**Phase 0 — publish the verdict + a census that reconciles (no codegen change).**
§3.1 plus `JS2WASM_RET_UNBOX_STATS=1`: `|numericFunctions|`, `|booleanFunctions|`,
the overlap, and a per-name table of which of the 83 have a write-once verdict /
a twin / a trampoline. Also fix §1.4's instrument so the buckets sum to the
`exec-census` total. Byte-identical **by construction** (nothing reads the new
field) — the `alloc-census.ts` house rule: every `note*` is a statement, never
part of a condition. **Checkpoint:** reproduces `numeric=102 boolean=83
overlap=83 boolean-only=0` and a reconciled producer table. Land first; it is
the instrument the other phases are judged with, and it is cheap.

**Phase 1 — the i32 twin.** §3.2 + §3.3 (a), (b), (c). Small — the diff is
~30 lines across three files — but (b) is the one that can regress a corpus
this lane cannot see. **Checkpoint:** with the flag on, the 83 names' twins
declare `i32`; `legacyFills` still 0; `__unbox_boolean` executed count does NOT
jump (a jump means the legacy arm went live and (b) matters); checksum 422;
`__box_boolean` roughly unchanged (that is EXPECTED — §4 — and saying so up
front is what keeps the phase from reading as a null).

**Phase 2 — the merge/consumer half.** Re-run lever 4 with the flag on and
report the decline delta on `arm-tail-call` (102) and `prev-call` (366) from
lane C. If those buckets close, `__box_boolean` moves; if they do not, say so
and stop — do not build a second merge-typing pass without that evidence.
**Checkpoint:** `__box_boolean` delta on lane B, with the fuse debug tally
before/after.

**Phase 3 — the parameter half (recommend a SEPARATE issue).** The 29/15/5 %
argument buckets. Symmetric change: `boolean`-branded `i32` in
`DirectCallTrampoline.params`, the `ref`-typed-param decline at `:1644` left
alone (its reason is the `applyRefNullFixups` hazard documented at `:798-821`,
which is about `ref`/`ref_null` only — an `i32` param is already legal there,
as `padTypes` proves). This is where the AC's remaining headroom is.

**Phase 4 — the miscompile (separate issue, default ON).** Filter
`isBooleanish` out of the `numericFunctions` loop
(`numeric-property-analysis.ts:1267-1279`), mirroring the property loop's
`anyBoolean` (`:1319-1322`). This changes the default artifact, so it needs its
own regression evidence (full CI, not the acorn lane) — and it must land
**after** Phase 1, or the 83 names lose their f64 twin without gaining an i32
one and the lane regresses.

### 7. Amended acceptance criteria

- **Phase 0**: `booleanFunctionNames` published; census reproduces
  `102 / 83 / 83 / 0` and a producer table that sums to the `exec-census` total.
- **Phase 1**: with `JS2WASM_RET_UNBOX_ABI=1`, the 83 names' twins declare
  `{i32, boolean}`; `legacyFills` stays 0; `__unbox_boolean` executed count
  stays at 2; checksum 422; flag-off byte-identical.
- **Phase 1 correctness**: the §1.3 probe returns **4**, matching node, with the
  flag on.
- **Phase 2**: `__box_boolean` on lane B drops from **224,339**, with the lever-4
  decline tally quoted before/after. A drop below 100k requires Phase 3 — do not
  hold Phase 2 to it.
- **`__unbox_number`**: explicitly **out of scope** (§1.5 — `legacyFills=0`
  proves there is no return-ABI component). Re-target it at #4405 Phase 2.

### 8. Verification plan

1. **Flag off ⇒ byte-identical.** `sha256sum` against base, both lanes (§0 A and
   B). Note the caveat about what "base" means.
2. **Poison probe.** Invert the refined boolean result behind the flag (e.g.
   `i32.eqz` on the twin's return) and confirm the acorn lane **fails** with the
   flag on and **passes** with it off. #4157 entry (22) is the cautionary tale:
   a green run with a poisoned path is proof the path is dead.
3. **Census delta**, flag on vs off, from Phase 0's instrument. Report the whole
   funnel (`names → twins → trampolines → executed boxes`), not the top line.
4. **`__unbox_boolean` watch** — its count is the tripwire for §3.3(b).
5. **Checksum 422** + `success=true` + binary size reported on every run.
6. **Scoped equivalence**: `npm test -- tests/equivalence.test.ts`,
   `tests/dogfood/acorn.test.ts`, and `tests/issue-4157-box-boolean-fuse.test.ts`
   (Phase 2 changes what that pass sees). Do **not** run full test262 locally.
7. **A boolean-escape fixture** the acorn lane cannot provide: stringify,
   `typeof`, `JSON.stringify` and `===`-against-`true` on a predicate result.
   §1.3 shows the lane is blind to exactly this.

### 9. Risks

- **The biggest risk is a dev reading only the issue body and rebuilding
  `inferBooleanFunctionNames`.** §1.1 exists to prevent it; make it the first
  thing the dispatch message points at.
- **§3.3(b) `__unbox_boolean` on the i31 carrier.** Dead arm going live, invisible
  to the acorn lane, with a recorded precedent for the exact failure.
- **§3.3(c) ToNumber ≠ ToBoolean.** #3754's "the refined type is IMPOSED, not
  asserted" argument does **not** transfer unmodified to i32.
- **`fctx.body` is NOT append-only** (#4157 entry 33). Any new emitter that
  assumes it can splice by index will be wrong; ~8 emitters relocate ranges with
  `fctx.body.splice(start)`.
- **Oracle ratchet is change-scoped.** `typed-this.ts` already carries 3 raw
  `ctx.checker.getTypeAtLocation` calls (`:460`, `:486`, `:1380`) and is **not**
  in `scripts/oracle-ratchet-baseline.json`, so *any* added raw-checker call in a
  touched file fails the gate. Everything this issue needs is already on
  `ctx.oracle` (`isBooleanProducing`) or on a plain `Set<string>`.
- **File conflicts.** `typed-this.ts` and `closures.ts` are touched by #4405
  (Phases 1–3) and by the #4491 lever work; `box-boolean-fuse.ts` by #4455's
  in-queue branch. Phase 0 is additive (a new export + two assignments) and
  should land first. Note that this spec's base predates #4455's
  `src/codegen/ic-guard-reuse.ts` and #4157 entry 39 — see #4405 spec §1.3/§1.5.
- **Phase 2 can grow the binary** (lane B is already +37 % over lane A). Measure
  and state it; the standalone floor guards run in the `merge_group`, not on the
  PR.

---

## Slice record — Phases 0 + 1 (2026-08-27)

Implemented against `origin/main` @ `7e0b03ebb7`. Every number below was measured
in a fresh process on that base or on the branch; the plan's own §0 commands were
re-run first and **three of its §1 measurements had drifted** — recorded in full
below, because two of them change what the slice can claim.

### What landed

| plan ref | change | file |
| --- | --- | --- |
| §3.1 | `analyzeBooleanNames` publishes `{ properties, functions }` from the ONE traversal #2847 already runs; `analyzeBooleanPropertyNames` is now a thin view for its `excludeNames` caller | `struct-field-boolean-brand.ts` |
| §3.1 | `ctx.booleanFunctionNames` + both wiring sites (single-source **and** linked) | `context/types.ts`, `index.ts` |
| §3.2 | the boolean arm **before** the numeric one inside `refinedTwinReturnType` — the single decision point is unchanged | `typed-this.ts` |
| §3.3(a) | the generic body's shim picks its re-box helper off the BRAND (`__box_boolean` vs `__box_number`) | `closures.ts` |
| §3.3(b) | the `__unbox_boolean` trap arm is routed past, into the generic `i32` arm's `__unbox_number` + `i32.trunc_sat_f64_s` | `typed-this.ts` |
| §3.3(c) | a boolean-branded return target coerces through `emitToBoolean`, not `coerceType`'s ToNumber + truncate | `statements/control-flow.ts` |
| §6 Phase 0 | `JS2WASM_RET_UNBOX_STATS=1` funnel census, and the flag family, in a new LEAF module | `ret-unbox-abi.ts` (new) |
| §8.2 | `JS2WASM_RET_UNBOX_ABI_POISON=1` | `ret-unbox-abi.ts`, `typed-this.ts` |

`JS2WASM_RET_UNBOX_ABI` is **opt-in** via `optInFlagEnabled` (#4405's helper):
unset ⇒ OFF, and every off-token of the shared rule disables it. §3.3(b) and
§3.3(c) are flag-gated **only** to keep the OFF build byte-identical — a
DECLARED `boolean` return reaches both sites today.

### §0/§1 revalidation — three drifts

**Drift 1 — the plan's two lanes have collapsed into one.** #4157's tuned
eleven are default-ON (`src/perf-flags.ts`), so today's default *is*
approximately the plan's "lane B". Setting the plan's §0 lane-B environment adds
nothing but the four still-default-OFF levers.

| lane | binary B | `__box_boolean` | `__unbox_number` | `__box_number` | `__is_truthy` | checksum |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| plan A — flags off @ `12b5b0bb7` | 2,558,246 | 333,363 | 883,318 | 489,166 | 997,454 | 422 |
| plan B — tuned-11 + 4 levers | 3,497,429 | 224,339 | 214,677 | 1 | 237,193 | 422 |
| **today, default (flag OFF)** | 3,818,402¹ | **291,279** | **224,707** | **1,954** | **239,854** | **422** |
| **today, `JS2WASM_RET_UNBOX_ABI=1`** | 3,816,084¹ | **291,314** | 224,707 | 1,954 | 239,802 | **422** |

¹ with the `JS2WASM_EXEC_CENSUS` instrument installed. Uninstrumented:
**3,818,182 B** default, **3,815,864 B** flag-on (−2,318 B, −0.06 %).

**Drift 2 — §1.3's miscompile witness no longer reproduces. A neighbouring one
does.** The plan's exact probe (`pp.eat = function (x) { return this.n === x; }`,
then `("" + p.eat(5)).length`) now answers **4**, matching node. A predicate
whose body is a bare comparison already carries a boolean-branded i32 through
its DECLARED signature, so `refinedTwinReturnType` declines on it
(`declared.kind !== "externref"`). Cause of the drift: #4414 (done 2026-08-14)
fixed the three stringification consumers that decided boolean-ness from the
static TS type alone and ignored the i32 brand (`compileNativeConcatOperand`
and the template-literal span path in `src/codegen/string-ops.ts`, plus the
`String(x)` i32 arm in `src/codegen/expressions/call-identifier.ts`) — #4414's
own measurement of this repro shows `refined=undefined`, so the twin refinement
was never the producer there, and `JS2WASM_NUMERIC_TWINS=0` fixes this slice's
surviving witness while #4414 measured it as not fixing theirs. The `&&`-of-calls shape — which is acorn's
own idiom (`eatContextual`, `shouldParseArrow`, every `regexp_eat*`) — still
reaches the refinement and still miscompiles:

```js
pp.eq   = function (x) { return this.n === x; };
pp.pred = function (x) { return this.eq(x) && this.eq(x); };
("" + p.pred(5)).length   // node 4 ("true") · standalone default 1 ("1")
```

`JS2WASM_NUMERIC_TWINS=0` fixes it and `JS2WASM_DIRECT_CALLS=0` fixes it, so
§1.2's root cause (no `isBooleanish` filter on the `numericFunctions` loop) is
intact — only its witness moved. `tests/issue-4406-ret-unbox-abi.test.ts` pins
the new one.

**Drift 3 — "all 83 are minted f64" is now "54 of 83 are ALREADY i32b".**
`JS2WASM_RET_UNBOX_STATS=1` on the acorn lane, flag off, reproduces §7's Phase-0
checkpoint **exactly** — `numericFunctions=102 booleanFunctions=83 overlap=83
booleanOnly=0` — but the per-name table it prints says the twins have moved:

| twin result | count | which |
| --- | ---: | --- |
| `i32b` already | **54** | `eat`, `eatContextual`, `isContextual`, most `regexp_eat*` |
| `f64` still | **7** | `isAwaitUsing`, `isSimpleAssignTarget`, `isUsing`, `regexp_eatCharacterEscape`, `regexp_eatLoneUnicodePropertyNameOrValue`, `shouldParseAsyncArrow`, `shouldParseExportStatement` |
| no twin | 22 | no write-once verdict — `refinedTwinReturnType` declines upstream of the boolean arm |

So "the return half of this ABI is already built, just with the wrong type" is
today true of **7** acorn method names, not 83, and the flag's whole effect on
this lane is those seven. That is why the §7 Phase-1 checkpoints are met while
`__box_boolean` does not move.

### Measured against §7's amended criteria

| criterion | result |
| --- | --- |
| **Phase 0** — verdict published; census reproduces `102 / 83 / 83 / 0` | ✅ exact |
| **Phase 1** — with the flag on, the names' twins declare `{i32, boolean}` | ✅ twins `i32Boolean` 54 → **61**, trampolines 53 → **60** |
| **Phase 1** — `legacyFills` stays 0 | ✅ `sites=3976 trampolines=545 twinFills=516 genericFills=29 legacyFills=0`, identical on and off |
| **Phase 1** — `__unbox_boolean` stays at 2 (the §3.3(b) tripwire) | ✅ **2** on and off |
| **Phase 1** — checksum 422 | ✅ on, off, and every off-token |
| **Phase 1** — flag-off byte-identical | ✅ `sha256 87b19d033d804ad8e87b57b82d41f5fa1cbd1b0c10553ac92b9d14cc52dc22b4`, 3,818,182 B — identical from base code and from the branch, and identical under `JS2WASM_RET_UNBOX_ABI_POISON=1` alone |
| **Phase 1 correctness** — the §1.3 probe matches node with the flag on | ✅ via drift 2's witness: 1 → **4**; `typeof`/`JSON.stringify`/`=== true`/false-case all match node |
| **`__box_boolean`** | 291,279 → 291,314 (**+35**, +0.012 %) — the null §4 predicts; the buckets it names are Phases 2/3 |
| **`__unbox_number`** | 224,707, unchanged — out of scope per §1.5 |
| binary size | −2,318 B (−0.06 %); no floor risk |

**Poison probe (§8.2).** Flag on + poison on: the acorn self-parse **fails**
(`RangeError: Maximum call stack size exceeded` inside the parser — an inverted
predicate makes it recurse). Flag on, poison off: checksum 422. Poison alone:
byte-identical to the default. The refined path is live and executed, so none of
the numbers above is a reading of a dead path.

### §3.3(c) — what is closed and what is trusted

The ToBoolean return arm closes the divergence the plan flags: `coerceType`
(`type-coercion.ts`, the `externref → i32` arm) is ToNumber + `i32.trunc_sat_f64_s`
regardless of the boolean brand, so a return expression that lowered to a boxed
`"abc"` would truncate to `0` where ToBoolean says `1`. With the flag on, that
site routes through `emitToBoolean` instead.

What is still **trusted, not proven**: that #2847's name-keyed fixpoint is
sound about "this name returns a boolean". It is the same trust
`numericFunctionNames` already carries default-ON for `provenNumericOperand`,
and `expressionIsBoolean` routes every type question through
`ctx.oracle.isBooleanProducing`. Stating it rather than leaving it implicit, as
§3.3(c) asks.

### Two PRE-EXISTING defects found (not introduced here, not fixed here)

1. **`tests/issue-3754-numeric-return-twin.test.ts` fails 9 of 10 on
   `origin/main` @ `7e0b03ebb7`** — `expected '' to be 'externref'`, i.e. the
   `__dc_P_inc_0_g` trampoline that file reads is no longer emitted for its
   shape. Verified by reverting all six touched files to `HEAD` and re-running:
   same 9 failures. That file is not in a required check, which is why it has
   stayed red.
2. **A mixed boolean/number prototype method consumed by string concatenation
   emits an INVALID MODULE**, identically with the flag on and off and on base:

   ```js
   pp.pred = function (x) { if (x > 100) { return 7; } return this.eq(x) && this.eq(x); };
   ("" + p.pred(5)).length
   // CompileError: struct.get[0] expected type (ref null 6), found call of type (ref null 71)
   ```

   Worth its own issue; `compile()` reports `success: true` and the failure only
   surfaces at `WebAssembly.compile`.

### What remains

- **§6 Phase 2** — the merge/consumer half (`expressions/logical-ops.ts` types
  its merge `(result externref)`; lever 4's `arm-tail-call` / `prev-call`
  declines). Untouched here; re-measure lever 4 with the flag on before building
  anything.
- **§6 Phase 3** — the parameter half (the 29 % + 15 % + 5 % argument buckets).
  Recommend a separate issue, as the plan does; this is where the AC's remaining
  headroom is.
- **§6 Phase 4** — the default-ON `isBooleanish` filter on the
  `numericFunctions` loop. Now cheaper to justify: drift 3 shows only 7 acorn
  names still ride the unfiltered verdict into an f64 twin.
- **§1.4's producer census** was NOT re-measured; its 1.40× reconciliation gap
  is still open, so the plan's consumer-shape ranking remains a ranking.

---

## Slice record — Phase 2, the merge sink (2026-08-27)

Implemented against `origin/main` @ `76c47838e1` (= Phase 0+1's PR #5061 plus
#5076/#5078). Every number below was measured in a FRESH process, on that base
or on this branch, with `.tmp/probe-4406-census.mjs` (§0's driver, checksum
`parse(acorn dist).body.length = 422`) and `JS2WASM_EXEC_CENSUS` installed.

### The lane, restated — the plan's "lane B" no longer needs an env block

Phase 0+1's **drift 1** stands: #4157's tuned eleven are default-ON, so today's
default already *is* approximately the plan's lane B. The one flag lane B still
needs is **lever 4 itself** (`JS2WASM_UNBOXED_BOOL_FUSE=1`, default OFF) — the
pass whose decline tally §6 Phase 2 is scored against. So "lane B" below means
**today's default + lever 4**, nothing else.

| lane (all: standalone, `optimize: 0`, census installed) | binary B | `__box_boolean` | `__is_truthy` | checksum |
| --- | ---: | ---: | ---: | ---: |
| default (no lever 4, flag off) | 3,809,529 | 291,279 | 239,854 | 422 |
| **lane B** — lever 4 on, flag off | 3,799,937 | **275,113** | 237,265 | 422 |
| lane B + `JS2WASM_RET_UNBOX_ABI=1`, Phase 1 only (base code) | 3,797,523 | **275,148** | 237,230 | 422 |
| **lane B + flag on, Phase 2 (this branch)** | 3,797,824 | **256,189** | 237,230 | 422 |

The default-lane 291,279 reproduces Phase 0+1's figure exactly, which is what
certifies the two slices are measuring the same tree.

### Finding 1 — the plan's Phase-2 first step is a NULL, and that is why there is code here

§6 Phase 2 says: *"Re-run lever 4 with the flag on and report the decline delta
on `arm-tail-call` (102) and `prev-call` (366) from lane C. If those buckets
close, `__box_boolean` moves; if they do not, say so and stop."* Run first,
built second. It does not close them:

| lever-4 decline | plan, 2026-08-14 | lane B, flag off | lane B, flag on (Phase 1 only) |
| --- | ---: | ---: | ---: |
| `prev-call` | 366 | **0** | **0** |
| `arm-tail-call` | 102 | 88 | **88** |
| `arm-local.get` | — | 28 | 28 |
| `arm-extern.convert_any` | — | 14 | 12 |
| `arm-local.tee` | — | 10 | 10 |
| `arm-struct.get` | — | 10 | 10 |
| `prev-extern.convert_any` | — | 1,645 | 1,645 |
| `prev-struct.get` | — | 12 | 12 |
| fused sites | — | 162 | 164 |

Two corrections to the plan fall out:

1. **`prev-call` is already zero and was not closed by this issue.** The plan
   read it as the return half's headroom; by the time lever 4 runs today, a
   call whose result feeds a ToBoolean no longer produces one — the twins
   introduced by #3754/#2847 already answer i32.
2. **The flag alone moves the tally by two sites** (`arm-extern.convert_any`
   14 → 12) and `__box_boolean` by **+35** — the same +35 Phase 1 measured, i.e.
   the identical null. Phase 0+1's **drift 3** explains it: 54 of the 83 boolean
   names already carried an i32b twin through their DECLARED signature, so the
   flag's whole reach on this lane is seven method names.

So the honest reading of §6's stop rule is *"the flag does not close them —
something has to"*. What follows is that something.

### What landed — the SINK leaf

`box-boolean-fuse.ts` (lever 4) fuses a logical merge only when EVERY leaf is
one it can specialise: a `__box_boolean` tail (drop the call) or a re-read of
the branch's own condition operand (replace with the constant the branch
proved). One arm it cannot specialise strands every box in the tree, **including
its sibling's** — which is exactly what the five `arm-*` buckets above are.

Phase 2 adds the general leaf the two specialised ones are optimisations of:
**keep the consumer, move a COPY of it into the arm.**

```
if (result externref)                    if (result i32)
  <rhs…> call $__box_boolean       ⇒       <rhs…>                      ; box deleted
else                                     else
  <lhs…> call $someExternrefFn             <lhs…> call $someExternrefFn
end                                        call $__is_truthy           ; consumer, moved
call $__is_truthy                        end
```

Soundness is the pass's own argument, applied leaf by leaf: the arm tail leaves
exactly one externref (the merge declares `(result externref)`, so a
value-producing tail cannot leave anything else) and the consumer answers
`truthy` of it, so `truthy(merge)` is unchanged. **Executed cost is unchanged,
not merely bounded** — one arm runs per execution, so one copy of the consumer
runs where one ran before. Only STATIC size grows, which is why a tree of
nothing but sink leaves is declined (`no-free-leaf`): it would pay that size for
zero deleted boxes.

| ref | change | file |
| --- | --- | --- |
| §3.4 (ii) via (i) | `LeafAction` gains `"sink"`; `planFuse` takes the consumer and an ALLOWLIST of value-producing arm-tail opcodes; `no-free-leaf` guard; poison; the two duplicated site blocks collapse into `tryFuseSite` | `box-boolean-fuse.ts` |
| §6 / flag family | `retUnboxMergeSinkEnabled()` beside the Phase-1 predicates — extended, not forked | `ret-unbox-abi.ts` |

The allowlist (`call`, `call_ref`, `call_indirect`, `local.get`, `local.tee`,
`global.get`, `struct.get`, `array.get`, `extern.convert_any`, `ref.null`,
`select`) is deliberately an allowlist: a tail that terminates the frame
(`return_call`, `unreachable`) or leaves the arm (`br`) type-checks against the
merge polymorphically, and a denylist would silently admit the next such opcode
somebody adds to the `Instr` union.

### Finding 2 — measured Phase-2 result

| lever-4 tally, lane B + flag on | before (Phase 1 only) | after (Phase 2) |
| --- | ---: | ---: |
| fused sites | 164 | **298** |
| ├ box-call leaves | 168 | 238 |
| ├ cond-reuse leaves | 164 | 242 |
| └ sunk-consumer leaves | 0 | **146** (over 134 sites) |
| `arm-tail-call` | 88 | **0** |
| `arm-local.get` | 28 | **0** |
| `arm-extern.convert_any` | 12 | **0** |
| `arm-local.tee` | 10 | **0** |
| `arm-struct.get` | 10 | **0** |
| `no-free-leaf` (new, deliberate) | — | 14 |
| `prev-extern.convert_any` | 1,645 | 1,645 |
| `prev-struct.get` | 12 | 12 |

**Every `arm-*` bucket closes.** 148 declined merge sites become 134 fused ones
plus 14 that re-decline as `no-free-leaf` — the guard doing its job, not a miss.

| criterion (§7 Phase 2) | result |
| --- | --- |
| `__box_boolean` drops on lane B | **275,148 → 256,189 (−18,959, −6.9 %)**; against the flag-off lane B, 275,113 → 256,189 (−18,924, −6.9 %) |
| lever-4 decline tally quoted before/after | above |
| checksum 422 | ✅ every lane, including under poison-off |
| flag-off byte-identical | ✅ see below |
| below 100k | **no — and §7 says not to hold Phase 2 to it.** The remaining 256k is the parameter half (Phase 3) and the non-merge truthy residual |

Binary size: **+301 B (+0.008 %)** against the Phase-1-only lane, and −2,113 B
against flag-off lane B. §9's "Phase 2 can grow the binary" risk is real in kind
(each sink leaf is a copy of the consumer) but negligible in size here, because
`no-free-leaf` refuses the copies that buy nothing.

The two `prev-*` buckets are untouched **by construction**: they are not merges.
`prev-extern.convert_any=1,645` is the truthy-IC's own terminal fallback (one
per IC'd call site) and `prev-struct.get=12` is a member read tested directly.
Neither reaches a merge, so no merge-typing change can move them.

### Flag-off byte-identity

The interesting lane is **lever 4 ON, flag OFF** — that is the one that executes
every refactored line (`tryFuseSite`, `FuseOpts`, `planFuse`'s reordered
declines) while the sink is disabled:

| lane | binary B | sha256 |
| --- | ---: | --- |
| base @ `76c47838e1`, lane B (lever 4 on) | 3,799,937 | `089085568d8216b7f5e16d65bc72898ee4891fe56fac3d4930e6173c6a856077` |
| **branch, lane B** | 3,799,937 | **identical** |
| base @ `76c47838e1`, default (no lever 4) | 3,809,529 | `ece895706b9551bfbfbd2f130fc9867c110a8e34cbfa7c4b90910d37b4159d41` |
| **branch, default** | 3,809,529 | **identical** |

Lane B's decline tally is identical character-for-character as well
(`arm-tail-call=88 arm-local.get=28 arm-extern.convert_any=14 …`), which is the
stronger statement: the planner reaches the same verdict on the same sites, not
merely the same bytes. The two base digests were taken by reverting exactly the
two touched sources to `origin/main` in place and re-running in a fresh process;
the restore was verified with `git diff HEAD` before anything else was measured.

Off-token coverage is unchanged: the sink reads the same
`optInFlagEnabled(JS2WASM_RET_UNBOX_ABI)` predicate Phase 1 does.

### Poison — the liveness proof, isolated

`JS2WASM_RET_UNBOX_ABI_POISON=1` now also inverts the result of any merge whose
fusion used a sunk consumer (an `i32.eqz` where the consumer stood; lever 4's
own poison and this one XOR, since inverting twice is the identity).

Isolating Phase 2 from Phase 1 matters, because on acorn the combined poison
breaks the parse either way. The isolation is in
`tests/issue-4406-ret-unbox-abi.test.ts`: `MERGE_AXIS` is built from **plain
functions, not fnctor prototype methods**, so `refinedTwinReturnType` never
fires on it and Phase 1's poison has nothing to touch. There, poison flips the
answer `112222 → 221111` — every arm's verdict inverted. A dead path could not
do that.

The acorn lane adds the dynamic half twice over: the −18,959 executed boxes can
only come from newly-fused sites, and all 134 of those used at least one sink
leaf; and with flag + poison ON the self-parse **throws** out of the parser
(`WebAssembly.Exception`, no checksum), where flag-on/poison-off returns 422.

### Gates

`typecheck` · `lint` · `prettier` · `check-loc-budget` (+165 net, no unallowed
growth — no frontmatter grant needed) · `check-func-budget` ·
`check-coercion-sites` · `check:oracle-ratchet` (+0/+0) · `check:dead-exports` ·
`check:ir-fallbacks` / `check:ir-only` unchanged (they run the default lane,
where the pass is off) · all 8 equivalence shards · the adjacent canaries
(#4157's fuse and truthy-IC suites, #3754, #4774).

### What remains after this slice

- **§6 Phase 3 — the parameter half.** Still where the headroom is, and now the
  ONLY route to §7's `< 100k`: the residual `__box_boolean` is dominated by
  argument-position boxes (§1.4's 29 % + 15 % + 5 %), which no merge-typing
  change can see. Recommend the separate issue the plan asks for.
- **§6 Phase 4 — the default-ON `isBooleanish` filter.** Unchanged by this
  slice; drift 3's "only 7 acorn names" still applies.
- **The `prev-*` residual is NOT return-ABI work.** `prev-extern.convert_any`
  is the truthy-IC's fallback shape; if it is worth attacking it belongs to
  #4157's IC, not here.
- **§1.4's producer census** is still unreconciled (1.40×), so the 62 % figure
  remains a ranking. This slice did not need it: the lever-4 tally is an exact,
  reproducible instrument for the merge subset, and it is what the phase is
  scored against.
- **Both Phase 0+1 defects were FIXED on `main` between that slice and this one
  — re-checked as canaries, not assumed.**
  `tests/issue-3754-numeric-return-twin.test.ts` was recorded above as failing
  **9 of 10** on `7e0b03ebb7`; it passes **10/10** on `76c47838e1` because
  **PR #5076 fixed it** — it restored the route-c devirtualization try-order
  that `ad543a660e` broke, and that suite was its acceptance gate (see
  `plan/issues/4775-numeric-return-twin-suite-red-on-main.md`). The record is
  "fixed by #5076", not "stale": the entry was accurate when written.
  `tests/issue-4774-…` passes 10/10 as well (PR #5078), and the invalid-module
  shape it pins is the second defect. The adjacent #4157 suites
  (`box-boolean-fuse`, `is-truthy-inline-ic`) pass 3/3 and 5/5.

---

## Slice record — Phase 3, the parameter half (2026-08-28)

Implemented against `origin/main` @ `30a3335b80` (= Phase 0+1's PR #5061 and
Phase 2's #5089, both landed). Every number below was measured in a FRESH
process, on that base or on this branch, with `.tmp/probe-4406-census.mjs`
(§0's driver, checksum `parse(acorn dist).body.length = 422`).

**Lane, restated.** Phase 2's reading still holds: #4157's tuned eleven are
default-ON, so "lane B" means **today's default + lever 4**
(`JS2WASM_UNBOXED_BOOL_FUSE=1`) and nothing else. Both re-measured baselines
reproduce Phase 2's figures **exactly** — `__box_boolean` 275,113 flag-off and
256,189 flag-on — which is what certifies this slice measures the same tree.

### Finding 1 — the plan's §1.4 ranking is right, and the parameter half is where the residual lives

§4 said the 29 % + 15 % + 5 % argument buckets "need the parameter half of the
ABI, which is a different change to the same registry". Measured, that is the
whole of what moved:

| lane (standalone, `optimize: 0`, census installed) | binary B | `__box_boolean` | `__unbox_number` | `__is_truthy` | checksum |
| --- | ---: | ---: | ---: | ---: | ---: |
| lane B, flag off | 3,800,894 | 275,113 | 224,707 | 237,265 | 422 |
| lane B, flag on — Phases 1+2 (base code) | 3,798,781 | **256,189** | 224,707 | 237,230 | 422 |
| **lane B, flag on — Phase 3 (this branch)** | 3,793,884 | **222,133** | 225,213 | 237,230 | **422** |

**`__box_boolean` 256,189 → 222,133 (−34,056, −13.3 %)**; against the flag-off
lane B, 275,113 → 222,133 (−53,000, **−19.3 %**). Binary **−4,897 B (−0.13 %)**
against the Phase-1+2 lane — the parameter half SHRINKS the module, because a
deleted argument box is deleted at every call site while the analysis itself
emits nothing.

Still **not** below §7's 100k. The residual is now dominated by the two `prev-*`
buckets lever 4 cannot reach and by boxes at sites that never devirtualize; see
"What remains".

### What landed

| ref | change | file |
| --- | --- | --- |
| §6 Phase 3 | the whole-program `(name, slot)` verdict, both flag predicates, the funnel census, the shim-suppression counter — a new LEAF | `param-unbox-abi.ts` (new) |
| §6 Phase 3 | the widened `anyCalls` index (every `m(…)` / `<any>.m(…)` / `new m(…)`), and `inferBooleanValueNames` made non-mutating so it can run a SECOND time over that index | `struct-field-boolean-brand.ts` |
| §3.1 shape | `ctx.booleanParamSlots` + the same two wiring sites Phases 0+1 used | `context/types.ts`, `index.ts` |
| §5.1 | `refinedTwinParamTypes` — the single decision point, beside `refinedTwinReturnType` | `typed-this.ts` |
| §6 Phase 3 | the trampoline's params, the pad, and the ToBoolean argument arm | `typed-this.ts` |
| — | the twin's param list, and the SHIM SUPPRESSION that makes the whole thing sound | `closures.ts` |
| §8.2 | `JS2WASM_PARAM_UNBOX_ABI_POISON=1`, deliberately separate from Phase 1's | `param-unbox-abi.ts`, `typed-this.ts` |

Funnel, flag on: `provenNames=27 provenSlots=35 refinedTwins=24
refinedTwinSlots=32 shimsSuppressed=48`. The 27 names are acorn's own
flag-passing idiom — `parseExprList[1,2]`, `parseClassMethod[1,2,3]`,
`parsePropertyValue[1,2,3]`, `parseBindingList[1,2]`, `toAssignable[1]`,
`parseMaybeUnary[2]`, `parseFunctionStatement[1,2]`, … (48 suppressions for 24
twins because the closure lifter lifts each arrow twice).

### Finding 2 — the proof obligation is NOT the return half's, and the shim is what discharges it

This is the load-bearing correctness argument and it is worth stating plainly,
because §3.3's transfer argument does **not** carry over.

A refined RESULT is *imposed* on the callee: every `return` coerces to it, so an
imprecise fixpoint costs performance. A refined PARAMETER is imposed on the
**callers**, and an unproven caller does not coerce — it simply hands the body a
value the body will then read as a boolean. Three things carry it:

1. **Conjunctive over call sites, with a WIDENED receiver rule.** The verdict
   requires every syntactic `m(…)` / `<anything>.m(…)` / `new m(…)` to supply
   that slot with a provably boolean argument. Note the direction: `callName`
   (the return verdict's) deliberately stays narrow — aggregating a user
   `find()` with `array.find()` would brand a numeric field boolean — but for a
   parameter the verdict is a conjunction, so folding unrelated sites in can
   only WITHDRAW a slot, never grant one wrongly. Using the narrow map here
   would have been the bug: a `recv.m(nonBoolean)` site would be invisible.
2. **Conjunctive over declarations, re-checked at the point of use.** Plain
   identifier, no initializer, no `...rest`, no `arguments` in the body, never
   assigned. `refinedTwinParamTypes` re-asks this about the exact function it is
   minting rather than trusting the name index to be complete.
3. **The forwarding shim is SUPPRESSED for any refined method.** `o.m` can
   escape as a value — `arr.map(o.m)`, `o.m.call(…)`, `o["m"](…)` — and reach
   the method with anything. None of those can reach the TWIN: devirtualization
   fires only on a syntactic `recv.m(args)`, and the twin's other entry is the
   `ref.test` shim prepended to the generic body. Suppressed, the generic body
   keeps its `externref` parameters and stays the single entry for every dynamic
   caller, which is what reduces the obligation to the enumerable sites.

`closures.ts` already contemplated exactly this ("emit NO shim rather than an
ill-typed tail call … the only cost is an unmonomorphized dynamic entry"); Phase
3 takes that branch deliberately rather than as a fallback.

### Finding 3 — the measured COST of suppressing the shim

`shimsSuppressed=48` mint events (24 methods) and `__unbox_number` **224,707 →
225,213 (+506, +0.23 %)**. That is the only counter that moved the wrong way,
and the mechanism it matches is the shim suppression: a dynamic call to one of
those 24 methods now runs the generic body, which reads its fields through the
dynamic path. **Stated as a reasoned attribution, not a measurement** — it was
not isolated, because isolating it would mean keeping a shim that is exactly
what makes the slice unsound. It is 1.5 % of the boolean boxes removed.

### Finding 4 — a refined trampoline whose method has NO twin

First measurement of this slice showed `legacyFills` leaving 0 for the first
time in the issue's history (`legacyFills=2`,
`Parser.parseParenAndDistinguishExpression/2:no-twin=2`): the trampoline refined
its parameter while the method's callee is a GENERIC lifted body, which keeps
`externref`, so the signatures disagreed and both sites degraded to the legacy
dispatcher — correct, but it ADDS a box where the phase is meant to remove one.

Fixed at the fill, not by declining the refinement: `buildGenericArm` now boxes
a branded `i32` back up at the trampoline edge, exactly as it already adapts a
refined RESULT (`typed-this.ts`, the `unboxFromExternref` arm). `legacyFills`
back to **0**, `genericFills` back to **29**, and the box is paid once inside
the shared trampoline instead of at each call site.

### Measured against the checkpoints

| criterion | result |
| --- | --- |
| `__box_boolean` drops on lane B | **256,189 → 222,133 (−34,056, −13.3 %)**; vs flag-off, **−19.3 %** |
| checksum 422 | ✅ every lane, every off-token |
| `legacyFills` stays 0 | ✅ `sites=3976 trampolines=545 twinFills=516 genericFills=29 legacyFills=0` — identical on and off |
| `__unbox_boolean` stays at 2 (§3.3(b)'s tripwire) | ✅ **2** on and off |
| flag-off byte-identical | ✅ see the sweep below |
| binary size | **−4,897 B (−0.13 %)**; no floor risk |
| `__is_truthy` | 237,230, unchanged — the ToBoolean argument arm is defensive, not hot |
| below 100k | **no.** §7 does not hold Phase 3 to it either; see "What remains" |

### Byte-identity sweep (sha256 per lane, uninstrumented)

| lane | base @ `30a3335b80` | branch | identical |
| --- | --- | --- | --- |
| default (no lever 4), flag off | `58f33e3f87046286c68fe060b412632378da49c45eb58f3bb59bc3251b18f829` · 3,810,266 B | same | ✅ |
| lane B (lever 4), flag off | `f4d6dcacbacf025af2cba0232f3140ead5e2d3921f44c3b3261cce11a4a330f2` · 3,800,674 B | same | ✅ |
| default, `JS2WASM_RET_UNBOX_ABI` ∈ {`0`,`off`,`false`,`no`,`""`} | — | `58f33e3f…` | ✅ |
| default, `JS2WASM_PARAM_UNBOX_ABI_POISON=1` alone | — | `58f33e3f…` | ✅ |

Flag-off identity is not only structural here: the parameter analysis is
**skipped outright** when the flag is off (it is the one part of the module that
is not free — a second value-name fixpoint plus a body walk per declaration), so
a flag-off compile is also no slower than before.

### Poison — the liveness proof

`JS2WASM_PARAM_UNBOX_ABI_POISON=1` inverts every refined boolean ARGUMENT where
it is pushed. It is a SEPARATE variable from Phase 1's on purpose: Phase 1's
poison already breaks the acorn parse on its own, so a shared switch could not
attribute a break to this half.

- acorn lane, flag on + Phase-3 poison: the self-parse **fails**
  (`RuntimeError: dereferencing a null pointer`); flag on, poison off: checksum
  422. Poison alone: byte-identical to the default.
- `tests/issue-4406-param-unbox-abi.test.ts` isolates it on a weighted fixture
  (`takeFlag(true) * 10 + takeFlag(false)`): `10 → 1` under poison. Unweighted,
  inverting both arguments is the identity on the sum — a shape that would have
  read as "inert" while the path was live.

### Tests — pinned and proven non-vacuous

`tests/issue-4406-param-unbox-abi.test.ts`, 7 tests, all green on the branch.
Re-run against BASE code (all six files reverted from `.tmp/base/`, the standard
file-copy A/B): **3 fail** — the box differential, the shim suppression, and the
poison liveness. The other four (value equivalence, the two withdrawal rules,
off-token identity) pass on base **by construction**, which is what they are
for.

The value tests are the ones the acorn lane cannot provide: `typeof flag` reads
`"boolean"` (not `"number"`), `"" + flag` reads `"true"`/`"false"`, and
`flag === true` holds — for a slot carried as a raw `i32`. A refinement that
dropped the boolean BRAND would pass every acorn checksum and fail here.

### Gates

`typecheck` · `lint` · `prettier` · `check-loc-budget` / `check-func-budget`
(grants restated in this file's frontmatter with the dated rationale above —
the previous phases' grants were *stranded*, i.e. live only in a PR that also
modified this file) · `check-coercion-sites` · `check:oracle-ratchet` (+0/+0 —
every type question routes through `ctx.oracle` via the existing
`expressionIsBoolean`, or through plain syntax) · `check:dead-exports` ·
`check:ir-fallbacks` / `check:ir-only` unchanged (they run the default lane,
where the analysis is skipped) · all 8 equivalence shards · the adjacent
canaries (#4157's fuse and truthy-IC suites, #3754, Phase 0+1's own file).

### Pre-existing failures observed (not introduced here, not fixed here)

Verified by reverting all five touched source files to `HEAD` and re-running —
same failures, same names, on `origin/main` @ `30a3335b80`:

- `tests/issue-3683-direct-calls.test.ts` — 2 red ("declines an optional call
  `this.m?.()`", "devirtualizes a VOID-returning callee").
- `tests/issue-3683-arity-padding.test.ts` — 1 red ("distinguishes a PADDED
  `undefined` from an explicitly passed `null`").
- `check:godfiles` is red on base too; the branch's output differs only in the
  two `index.ts` functions this change-set already grants (+2 LOC each). It is
  not one of the six required checks.

One NON-failure worth recording so the next lane does not chase it:
`tests/issue-4157-box-boolean-fuse.test.ts` failed once with
`Test timed out in 35000ms` while eight equivalence shards were saturating the
box. Re-run unloaded it takes **10.8 s** and passes. The suite compiles nine
modules in one `it`, so it is timeout-sensitive to machine load, not to this
change.

### What remains

- **§6 Phase 4 — the default-ON `isBooleanish` filter** on the
  `numericFunctions` loop. Untouched; Phase 0+1's drift 3 ("only 7 acorn names")
  still applies.
- **The residual `__box_boolean` is no longer argument-shaped.** With the
  argument buckets closed, what is left is dominated by
  `prev-extern.convert_any=1,549` (the truthy-IC's own terminal fallback, one
  per IC'd call site — #4157's IC, not this issue) plus boxes at call sites that
  never devirtualize at all (`no-write-once-verdict=208` of them). A route to
  §7's `< 100k` would have to attack one of those, and neither is return-ABI
  work.
- **The verdict is name-keyed, so it is coarse.** `parseExprList[1,2]` is proven
  because every `parseExprList` call in the program agrees; one non-boolean
  argument anywhere withdraws the slot for every class. A receiver-specialised
  verdict (#4405's registry) would be strictly finer — that is the natural
  follow-on, not more work in this shape.
- **§1.4's producer census** is still unreconciled (1.40×), unchanged by this
  slice. It was not needed: the `exec-census` delta is exact and reproducible.

---

## Slice record — Phase 4, default-ON + the admission filter (2026-08-28)

Implemented against `origin/main` @ `f727d529ab` (= Phase 3's PR #5154 landed).
Every number below was measured in a FRESH process, on that base or on this
branch, with `.tmp/probe-4406-census.mjs` (§0's driver, checksum
`parse(acorn dist).body.length = 422`, standalone, `optimize: 0`).

### What Phase 4 turned out to be, once measured

§6 Phase 4 describes one change — "filter `isBooleanish` out of the
`numericFunctions` loop … it must land **after** Phase 1". Measured, it is
**two** changes with one switch, and the sketch is wrong in three specifics:

1. **The flag default is the load-bearing half, and it is a CORRECTNESS fix.**
   Phases 0–3 shipped opt-in, so `main` ships the miscompile by default: with
   the flag off, `refinedTwinReturnType` reaches its numeric arm for a predicate
   and mints an `f64` twin. Five witnesses measured wrong on base and right with
   the flag on (table below). §6 treated Phase 4 as the miscompile fix and
   Phases 1–3 as perf; it is the other way round — Phase 1 built the fix and
   left it switched off.
2. **The filter belongs at the PUBLICATION boundary, not in the loop.** §6 says
   "mirroring the property loop's `anyBoolean`", i.e. inside the fixpoint. Both
   were built and measured. The loop variant costs **+51,252 executed
   `__box_boolean` (+19.9 %)** and buys nothing either consumer can see, because
   withdrawing the name from `sets.numericFunctions` also withdraws the prover's
   own call arm and demotes every property/slot proven through a predicate call.
3. **`isBooleanish` alone is not the right predicate.** It is syntactic, so it
   misses acorn's own idiom — `return this.eq(x) && this.eq(x)`, an `&&` of
   CALLS. #2847's name-keyed `booleanFunctionNames` catches that but declines a
   MIXED `return 7` / `return a === b`, which is exactly where an `f64` result is
   unsound. The filter withdraws on **either**, supplied as
   `excludeFunctionNames` the same way `excludeNames` already supplies #2847's
   property verdict.

### §0/§1 revalidation — the baselines reproduce, drift 3 is unchanged

| lane (census installed) | binary B | `__box_boolean` | `__unbox_number` | `__is_truthy` | checksum |
| --- | ---: | ---: | ---: | ---: | ---: |
| default, flag off | 3,810,504 | **291,279** | 224,707 | 239,854 | 422 |
| default, flag on | 3,802,605 | **257,258** | 225,213 | 239,802 | 422 |
| lane B (lever 4), flag off | 3,800,912 | **275,113** | 224,707 | 237,265 | 422 |
| lane B, flag on | 3,793,902 | **222,133** | 225,213 | 237,230 | 422 |

The two lane-B figures reproduce Phase 3 **exactly** (275,113 / 222,133), which
certifies this slice measures the same tree. **Phase 3 never published the
default-lane flag-on figure; it is 257,258** — that is what flipping the default
is worth on the artifact that actually ships, since lever 4 is default-OFF.

**Drift 3 re-measured and unchanged.** `JS2WASM_RET_UNBOX_STATS=1`, flag off:
`numericFunctions=102 booleanFunctions=83 overlap=83 booleanOnly=0`; twins
`i32b` 54 → **61** with the flag on, trampolines 53 → **60**. The same seven
names still ride the unfiltered verdict into an `f64` twin — `isAwaitUsing`,
`isSimpleAssignTarget`, `isUsing`, `regexp_eatCharacterEscape`,
`regexp_eatLoneUnicodePropertyNameOrValue`, `shouldParseAsyncArrow`,
`shouldParseExportStatement`.

### Finding 1 — the miscompile is default-ON on `main`, and there are two of them

`.tmp/probe-4406-witness.mjs`, each case compiled standalone and compared to
node's own answer for the same source:

| witness | node | base default | branch default |
| --- | ---: | ---: | ---: |
| `("" + p.pred(5)).length` | 4 (`"true"`) | **1** (`"1"`) | **4** ✅ |
| `("" + p.pred(7)).length` | 5 (`"false"`) | **1** (`"0"`) | **5** ✅ |
| `typeof p.pred(5) === "boolean"` | 1 | **0** | **1** ✅ |
| `p.show(5).length` where `show = this.tag + this.eq(x)` | 6 (`"v=true"`) | **0** (NaN) | **6** ✅ |
| control: same shape, numeric callee | 4 | 4 | 4 |

The fourth row is a **second, distinct** defect and the reason the filter is not
optional. Lane sweep on base isolates it: `JS2WASM_NUMERIC_OPERANDS=0` fixes it;
`JS2WASM_RET_UNBOX_ABI=1`, `JS2WASM_NUMERIC_TWINS=0` and `JS2WASM_DIRECT_CALLS=0`
all **do not**. So it is `provenNumericOperand` (`binary-ops.ts`) — the second
consumer of `numericFunctionNames`, which the flag's boolean arm cannot reach
because that arm only decides a twin's result type. Only withdrawing the names
from the verdict itself fixes it, which is what §3.2 deferred to this phase.

### What landed

| ref | change | file |
| --- | --- | --- |
| §6 Phase 4 | `retUnboxAbiEnabled` moves `optInFlagEnabled` → `tunedFlagEnabled`: unset ⇒ **ON**, every off-token still OFF. Header records why the opt-in argument is retired for this flag | `ret-unbox-abi.ts` |
| §6 Phase 4 | `retUnboxNumericFilterEnabled()` — same variable on purpose; splitting them is the one combination that regresses | `ret-unbox-abi.ts` |
| §6 Phase 4 | `excludeFunctionNames` host field + the publication-boundary filter (`returnsBoolean` = #2847's verdict ∪ any `isBooleanish` return) | `numeric-property-analysis.ts` |
| §3.1 shape | both wiring sites ask `analyzeBooleanNames` for the PAIR from one traversal | `index.ts` |
| — | `analyzeBooleanPropertyNames` deleted — its only caller was that site, so it would have failed `check:dead-exports` | `struct-field-boolean-brand.ts`, `index.ts` |

**Funnel, branch default:** `numericFunctions=18 booleanFunctions=83 overlap=0
booleanOnly=83`; `twins=244 i32Boolean=61 trampolines=247 i32Boolean=60`. The
102 → **18** collapse and the `overlap` 83 → **0** are the phase's checkpoint:
§1.2's "boolean ⊂ numeric" — the single most important fact in the plan — is
closed.

### Finding 2 — the filter is FREE at the publication boundary, and expensive in the loop

| configuration | default lane `__box_boolean` | lane B |
| --- | ---: | ---: |
| base default (flag off, no filter) — **miscompiles** | 291,279 | 275,113 |
| flag on, no filter (Phase 3's shape) — still miscompiles `numericOperand` | 257,258 | 222,133 |
| **flag on + publication filter (this branch's default)** | **257,258** | **222,133** |
| flag on + loop filter | **308,510** | — |

The publication filter is **exactly free**: identical executed-box counts to
flag-on-without-filter, in both lanes, while fixing the fourth witness. The loop
filter is +51,252 (+19.9 %) against that. Stated as a **measurement**, not an
attribution — both variants were built and each lane was run in a fresh process.

### Measured against the checkpoints

| criterion | result |
| --- | --- |
| `__box_boolean` on the DEFAULT artifact | **291,279 → 257,258 (−34,021, −11.7 %)** |
| `__box_boolean` on lane B | 275,113 → **222,133 (−19.3 %)** |
| `numericFunctions` ∩ `booleanFunctions` | 83 → **0** |
| checksum 422 | ✅ every lane, every off-token, and under poison-off |
| `legacyFills` stays 0 | ✅ unchanged from Phase 3 |
| `__unbox_boolean` stays at 2 (§3.3(b)'s tripwire) | ✅ **2** in every lane |
| binary size (default, uninstrumented) | 3,810,284 → **3,802,225 B (−8,059, −0.21 %)** |
| `__unbox_number` | 224,707 → **225,213 (+506, +0.23 %)** |
| `__is_truthy` | 239,854 → 239,802 (−52) |
| below §7's 100k | **no.** Unchanged from Phase 3: the residual is `prev-extern.convert_any` (the truthy-IC's fallback) plus never-devirtualized sites, neither of which is return-ABI work |

**The `__unbox_number` +506 is the one counter that moves the wrong way**, and
it is Phase 3's shim-suppression cost — previously paid only by an opt-in lane,
now paid by the default artifact. **Reasoned attribution, not an isolated
measurement**: it is the identical +506 Phase 3 recorded for
`shimsSuppressed=48`, and it appears on this branch in exactly the lanes where
the flag is on. It is 1.5 % of the boolean boxes removed.

### Byte-identity sweep (sha256, uninstrumented)

| lane | digest | bytes | identical to base |
| --- | --- | ---: | --- |
| base default @ `f727d529ab` | `c95e7941d2d773dfe31fe5242daa9e09c51857c867156e1813912e8ceb426106` | 3,810,284 | — |
| base lane B (lever 4) | `2f0d0b5a1a284df04b80a52bee06872c0f44ddcb5e1687447238fd9de3388ab8` | 3,800,692 | — |
| branch, `JS2WASM_RET_UNBOX_ABI` ∈ {`0`, `off`, `false`, `no`, `""`} | `c95e7941…` | 3,810,284 | ✅ all five |
| branch, lane B + `JS2WASM_RET_UNBOX_ABI=0` | `2f0d0b5a…` | 3,800,692 | ✅ |
| branch, `JS2WASM_RET_UNBOX_ABI_POISON=1` + flag `0` | `c95e7941…` | 3,810,284 | ✅ poison alone inert |
| branch, DEFAULT (the new artifact) | `54de38391c137e7e06f3ccd56c6f426aff20502d87f1129ecd85318dcc8542d9` | 3,802,225 | intentionally different |

"Flag-off byte-identical" now means the OFF token reproduces the **pre-Phase-4
default**, which is the statement that matters once the default flips.

### Poison — liveness of the now-DEFAULT path

`JS2WASM_RET_UNBOX_ABI_POISON=1` with no other variable set (i.e. against the
new default): the acorn self-parse **fails** (`RangeError: Maximum call stack
size exceeded` — an inverted predicate makes the parser recurse). Poison with
`JS2WASM_RET_UNBOX_ABI=0`: byte-identical to base and checksum 422. So the
refined path is live and executed **on the artifact that now ships**, not merely
on an opt-in lane.

The admission filter has no value-inverting poison to define — it is a set
subtraction, and inverting it publishes a verdict that is wrong by construction
rather than a poisoned value. Its liveness rests on two instruments instead: the
funnel (`numericFunctions` 102 → 18, `overlap` 83 → 0) and the
`provenNumericOperand` witness, which is red on base and green on the branch.

### Tests — pinned and proven non-vacuous

`tests/issue-4406-ret-unbox-default-on.test.ts`, 6 tests, green on the branch.
Re-run against BASE code (all four files reverted from `.tmp/base/`, the
standard file-copy A/B): **4 fail** — the three stringification/`typeof`
witnesses and the `provenNumericOperand` witness. The other two pass on base by
construction: the numeric-callee control (which the filter must NOT touch) and
the off-token contract (unchanged by this slice).

Every default expectation is pinned against its own `JS2WASM_RET_UNBOX_ABI=0`
twin **in the same test**, so a build in which the flag silently reverted to
opt-in fails here rather than passing quietly.

### Out of scope, with evidence

- **The local-carrier residual.** `var f = this.pred(x); "" + f` reads `"1"`.
  It is the SAME root cause at a THIRD site — the prover's internal call arm,
  which the publication filter deliberately leaves alone. Measured: it
  reproduces identically on base and on this branch, and the loop-filter variant
  fixes it at the cost of +19.9 % executed boolean boxes. That is a real
  trade-off someone should take deliberately, not a rider on this slice. The
  property side of the same shape (`this.flag = this.pred(x)`) is already
  correct on base — #2847's boolean-property brand covers it.
- **A prototype method called from its own constructor fails at runtime.**
  `function P(n){ this.flag = this.twice(n); }` traps with a thrown `undefined`.
  Verified unrelated: the CONTROL with a plain numeric method
  (`pp.twice = function (x) { return x + x; }`) fails identically, and all five
  lanes (default, `RET_UNBOX_ABI=1`, `NUMERIC_OPERANDS=0`, `NUMERIC_TWINS=0`,
  `DIRECT_CALLS=0`) fail the same way on base. Not #4406's; worth its own issue.
- **§1.4's producer census** is still unreconciled (1.40×), unchanged again. Not
  needed: the `exec-census` deltas here are exact and reproducible.
- **§7's `< 100k`** is still out of reach and still not this issue's residual —
  see Phase 3's "What remains", unchanged.

### Suites the default flip required updating (not a regression)

`tests/issue-4406-ret-unbox-abi.test.ts` (Phases 0–2) and
`tests/issue-4406-param-unbox-abi.test.ts` (Phase 3) used a BARE build as their
OFF lane, which the flip turns into the ON lane — 10 tests failed for that
reason and no other. Every OFF lane now spells `JS2WASM_RET_UNBOX_ABI: "0"` out;
the differentials they assert are unchanged. Both files gained a pin on the flip
itself: unset must NOT reproduce the off lane, and a typo (`"yes"`) must land on
the new default rather than half-disabling anything. 26/26 green across the
three #4406 suites.

### Pre-existing failures observed (not introduced here, not fixed here)

Verified by reverting all four touched source files to `HEAD` and re-running —
same four failures, same names, on `origin/main` @ `f727d529ab`:

- `tests/issue-3683-direct-calls.test.ts` — 2 red ("declines an optional call
  `this.m?.()`", "devirtualizes a VOID-returning callee"). Phase 3 recorded both.
- `tests/issue-3683-arity-padding.test.ts` — 1 red ("distinguishes a PADDED
  `undefined` from an explicitly passed `null`"). Phase 3 recorded it.
- `tests/issue-3683-numeric-fields.test.ts` — 1 red ("a promoted slot still
  marshals through the reflection arms"). **New to this record**; it is the
  suite nearest this slice's blast radius, which is why it was checked.

Green canaries: `#4157` box-boolean-fuse (3/3) and is-truthy-inline-ic (5/5),
`#3754` numeric-return-twin (10/10), `#4774` (10/10), `#3683` typed-this-twin
(12/12) and proto-method-write-once (10/10).

### Gates

`typecheck` · `lint` · `prettier` · `check-loc-budget` (+9 `index.ts`, +57
`numeric-property-analysis.ts`, both granted in this file's frontmatter with the
dated rationale above — restated because the previous phases' grants are
stranded) · `check-func-budget` (`generateModule` +7, `generateMultiModule` +6,
already granted) · `check-coercion-sites` · `check:oracle-ratchet` (+0/+0) ·
`check:dead-exports` (0 new — the deleted `analyzeBooleanPropertyNames` is why
that gate had to be run) · **all 8 equivalence shards**: 24 failing, which is
exactly the 24 known-failures in `scripts/equivalence-baseline.json` — zero new,
zero newly-fixed, so the failing NAME set is unchanged.

### What remains

- **#4405's receiver-specialised verdict** is the natural follow-on for both
  halves: this verdict is name-keyed, so one non-boolean same-named function
  anywhere withdraws the name for every class.
- **The `JS2WASM_RET_UNBOX_ABI` off-token is now a REVERT SWITCH for four
  phases at once.** That is deliberate (they compose, and Phase 4's filter is
  unsound to enable without Phase 1's arm), but it means a future bisect of any
  one half needs a finer switch added first.
