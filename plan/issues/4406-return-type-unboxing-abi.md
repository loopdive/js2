---
id: 4406
title: "return-type unboxing ABI: i32/f64-returning callee twins so booleans and numbers cross calls unboxed"
status: ready
sprint: current
created: 2026-08-14
priority: high
horizon: xl
feasibility: hard
task_type: perf
area: codegen
related: [4157, 4405]
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
