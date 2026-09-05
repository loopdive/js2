---
id: 4638
title: "ES5 standalone: array element/descriptor substrate — defineProperty on array indexes & length, holes vs undefined, concat/filter/toString element semantics, arguments length descriptor (~56 rows)"
status: done
completed: 2026-08-23
sprint: current
created: 2026-08-23
updated: 2026-08-23
assignee: ttraenkler/dev-4638
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: array-descriptors
goal: standalone-gap
related: [3251, 4479, 4622, 4620]
origin: "2026-08-23 wave-3 residual map (196 true failures, .tmp/sweep-204-all.jsonl). Lanes B (.tmp/lane-B-descriptor.txt) + Array leftovers (.tmp/lane-leftover.txt). The single biggest coherent block left."
loc-budget-allow:
  # Each grant is a LOCKSTEP or GUARD site that has to live where the decision it
  # mirrors already lives; splitting them out would separate a predicate from the
  # consumer that must agree with it, which is the defect class this issue closes.
  # `src/codegen/literals.ts` — `_hasRealmGlobalObjectValue`, the new arm of the
  #   existing `objectLiteralForcesHostPath` gate. It has to sit next to that gate:
  #   three call sites already consult the gate for lockstep, and a second
  #   predicate module would give them two answers to keep in step instead of one.
  - src/codegen/literals.ts
  # `src/codegen/expressions/assignment.ts` — `emitArrayLengthSetReceiverPark`,
  #   extracted to module scope so `compilePropertyAssignment` grows by 13 lines
  #   rather than 51. It reads only the receiver ValType + two local indices, so it
  #   is already the smallest unit the guard can be.
  - src/codegen/expressions/assignment.ts
  # `src/codegen/object-ops.ts` — the §10.4.4.2 ordering rewrite inside
  #   `compileObjectDefineProperty`'s mapped-arguments block, plus the descriptor
  #   record in `emitMappedArgValueDefine`. The ordering IS the fix, so it cannot
  #   move away from the statements whose order it constrains.
  - src/codegen/object-ops.ts
  # `src/codegen/array-methods.ts` — `emitConcatResultBacking`, already extracted
  #   to module scope and shared by both `compileArrayConcat` allocation sites.
  - src/codegen/array-methods.ts
  # `src/codegen/index.ts` + `src/codegen/declarations.ts` — the two inlined
  #   lockstep twins of `objectLiteralForcesHostPath`. index.ts cannot import
  #   literals.ts (index↔literals cycle, called out in the #2804 comment right
  #   below the new arm), so the arm is inlined there exactly as the spread arm is.
  - src/codegen/index.ts
  - src/codegen/declarations.ts
  # Follow-on B5 concat hole/presence work: the native runtime must keep the
  # marker and prototype fallback in the same dispatch table as the existing
  # indexed object substrate; moving the arms out would split the carrier
  # tests from the helpers they extend.
  - src/codegen/object-runtime.ts
  # The filter result-carrier and open-object guards are the corresponding
  # residual substrate decisions in the standalone ES5 filter lane.
  - src/codegen/statements/variables.ts
  - src/codegen/declarations/object-shape-widening.ts
func-budget-allow:
  # `compileObjectDefineProperty` +29: the mapped-arguments §10.4.4.2 block gains
  #   the `applyAttributeState` closure and the flag-word computation. Both are
  #   ORDER-carrying — the whole defect was that severance ran before the write —
  #   so hoisting either out of the block would hide the constraint it encodes.
  - src/codegen/object-ops.ts::compileObjectDefineProperty
  # `compilePropertyAssignment` +13: the call to the extracted
  #   `emitArrayLengthSetReceiverPark` plus the null-guarded length store. Down
  #   from +51 before the extraction.
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
  # `collectDeclarations` +12: one consult + its rationale in
  #   `moduleInitForcesExternref`, a nested function whose entire job is to list
  #   the reasons a module global must be externref. The list is the function.
  - src/codegen/declarations.ts::collectDeclarations
  # Follow-on B5 concat hole/presence dispatch is intentionally kept adjacent
  # to the existing native indexed runtime arms and its call-site finalization.
  - src/codegen/object-runtime.ts::fillConcatNativeHoleArms
  - src/codegen/object-ops.ts::compilePropertyIntrospection
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/statements/variables.ts::compileVariableStatement
---

# #4638 — array element/descriptor substrate

## Problem (measured 2026-08-23 on branch tree)

The #3251-class wall, now the largest remaining block (~56 rows):

- **B1 — `Object.defineProperty` on ARRAY receivers (~17)**: index
  descriptors (`Expected obj[1] to equal 3, actually 0` — a defined
  accessor/data index not served by reads), `length` interplay
  (`15.2.3.6-4-183`: defining an index must grow length per §10.4.2.1;
  writable:false length), 3 null-deref CRASHES (`15.2.3.6-3-123` family —
  crash class, FIRST), the `"a === 10, actually 0"` mapped-arguments
  signature (#3251 proper — decline with owner if representation-walled,
  but MEASURE first: the vec-bag-seed descriptor store from #4479 may now
  serve part).
- **B2 — `defineProperties`/`freeze`/`seal` on arrays (~9)**: same
  substrate through the batch paths; `freeze` must make indexes
  non-writable/non-configurable and reads still serve values
  (`15.2.3.9-2-a-11/12/14`); one illegal-cast CRASH
  (`15.2.3.7-6-a-113`).
- **B3 — gOPD residual (3)**: `Cannot access property on null or
  undefined at 258:18/259:18` (the #4619-F triage rows) + 1 null-deref.
- **B4 — arguments `length` descriptor (4)**: `10.6-6-2`/`10.6-7-1`
  configurable:true (needs #4622-R2's runtime discrimination — an
  args-vec brand or a syntactic gOPD arm mirroring #4622's delete arm),
  `10.6-13-a-1` (escaped `callee` typeof), `S10.6_A5_T4`
  (`arguments.length = <string>` write-through — i32 length wall,
  measure and decline honestly if so).
- **B5 — element HOLES vs undefined (~12, from the leftover list)**:
  `concat` treats a hole as 0 (`b[1] expected undefined, got 0`) and
  explicit `undefined` elements as NaN; `toString` renders
  `[undefined,1,null,3]` as ",1,0,3" not ",1,,3"; `toLocaleString` must
  CALL each element's toLocaleString (n++ counting rows); `filter`
  callbackfn descriptor rows (`15.4.4.20-9-b-*`: elements
  defined/deleted DURING iteration). The vec representation's
  hole/undefined discrimination — reuse the #4489 tag-1 undefined
  singleton where the vec stores anyref, or the sparse-tail machinery
  from #4434.
- **B6 — `Array.prototype.concat` as a VALUE (3)**: explicit refusal
  "not yet callable as a value" — same class #4619-D/E solved for
  wrapper protos; wire concat through the callable-value dispatch.
- **B7 — `Array.isArray(arguments)` false (1)**: needs the args-vec
  brand from B4 — same discrimination, two consumers.

## Implementation Plan

1. Brief: plan/method/es5-standalone-agent-brief.md (binding). Re-measure
   live; crashes (B1 null-derefs, B2 illegal cast) FIRST.
2. Read `vec-bag-seed.ts` (`buildVecDeletePrologue`, `__vec_gopd`),
   `arguments-object-mop.ts` (#4622's arm), and #4479's descriptor store
   — the substrate exists; the question per family is which read/write
   path doesn't consult it. Instrument one failing row per family with
   WAT decode before designing.
3. B4+B7 want ONE discriminator: give the arguments-object vec a brand
   (a distinct struct subtype or a sidecar bit) that `__vec_gopd`,
   `Array.isArray`, and #4622's delete arm can all ask. That converts
   #4622's syntactic declines into runtime answers — coordinate with its
   issue file's R2/R3 residual notes.
4. B5: decide the hole encoding once (tag-1 undefined singleton vs
   sparse-tail), then fix concat/toString/toLocaleString/filter against
   it. A/B every step — this touches hot paths; the #1888 floor and
   byte-identity on non-hole shapes are the guardrails.
5. B6: callable-value arm for concat mirroring #4619's mechanism.
6. Verify: scoped sweeps (defineProperty/defineProperties/freeze +
   Array/prototype/{concat,filter,toString,toLocaleString} + 
   arguments-object) before/after, own runs; equivalence array suites
   green; pins tests/issue-4638.test.ts; zero regressions. A corpus-style
   stratified sample (≥500 rows) is REQUIRED if you touch the vec
   read/write hot path (the #4489/#4519 precedent).

## Root cause

Five independent roots, measured on branch `issue-4638` (base `81445abf7`),
`--target standalone`. Each was reduced to a minimal repro before any edit; the
repros are the pins in `tests/issue-4638.test.ts`.

**R1 — empty-string key had no module-global lockstep (crash).**
`objectLiteralForcesHostPath` (literals.ts) routes `{ "": 1 }` to the open
`$Object` builder, because `""` cannot be a struct field name (#4616). #4616
added that VALUE routing and the `let`/`const` local-typing twin, but not the
**module-global** twin (`moduleInitForcesExternref`, declarations.ts) nor the
**hoisted-`var`** twin (`hoistVarDecl`, index.ts). So a top-level `var obj = {
"": 1 }` kept the struct type TypeScript infers while the value was an
`$Object`: the guarded store's `ref.test` missed, wrote `ref.null`, and the
first read did `struct.get` on null — an **uncatchable trap**, not a wrong
answer. Sloppy test262 scripts declare with `var`, which is why every
empty-string-key row took this path.

**R2 — the realm global object inside an object literal (crash).**
`var attr = { configurable: this }` (script top level) — the checker types the
property as `typeof globalThis`, which #4394 already established has no compiled
WasmGC struct. The field coercion emits `ref.test (ref $__anon_globalThis)` and,
on the miss, `ref.null` — so the field silently became NULL. Then
`Object.defineProperty(obj, "p", attr)` reified the descriptor struct, and
`materializeStructAsDynamicObject` (literals.ts) read that null field with
`struct.get` — the trap. WAT-confirmed: `ref.test (ref 45)` → `ref.null 45` →
`struct.new 46` → `struct.get 46 0` → `struct.get 45 0` on null.

**R3 — `Array.prototype.length = 0` (crash).** The `arr.length = N` fast path in
`compilePropertyAssignment` admits a receiver on `resolveArrayInfo`, which
answers from the CHECKER type — and the checker types `Array.prototype` as
`any[]`. The runtime value is the prototype OBJECT, so parking it in the
`(ref null $__vec_base)` local emitted `any.convert_extern ; ref.cast null` and
trapped `illegal cast`. Both `15.2.3.6-4-117` and `15.2.3.7-6-a-113` open with
that assignment, so the trap fired long before the ArraySetLength assertion they
are actually about (which, measured separately, already passes).

**R4 — §10.4.4.2 [[DefineOwnProperty]] ordering on mapped `arguments`.** The
spec is ordered: step 6.b.i writes the mapped formal from `Desc.[[Value]]`, and
only step 6.b.ii removes the map entry when `Desc.[[Writable]]` is `false`.
object-ops.ts recorded the severance in `unmappedIndices` BEFORE calling
`emitMappedArgValueDefine`, which reads that set live — so the parameter write
the spec performs first was skipped (`Expected a === 20, actually 0`). Two
smaller defects rode along: the "already frozen ⇒ leave it to the runtime" test
read the attribute sets AFTER this define had recorded its own
`configurable:false`/`writable:false`, so a FIRST define with both looked frozen
against itself; and the fast path never told the descriptor store what
attributes were stated, so `getOwnPropertyDescriptor(arguments, "0")` still
reported the pre-define ones.

**R5 — concat's result backing invented a real `0`.** `array.new_default`
zero-fills an f64 backing and the copies that follow are BACKING-clamped
(#3201), so for a sparse operand (`a = [0]; a.length = 3`) the untouched
destination slots kept `0` where the source had no element at all.

## Fix

| file | change |
| ---- | ------ |
| `src/codegen/declarations.ts` | `moduleInitForcesExternref` now consults `objectLiteralForcesHostPath` directly — one predicate, so the module global cannot disagree with the value. |
| `src/codegen/index.ts` | `hoistVarDecl`'s inlined copy gains the empty-string-key arm (index.ts cannot import literals.ts — the same cycle the #2804 spread arm calls out). |
| `src/codegen/literals.ts` | new `_hasRealmGlobalObjectValue` arm of `objectLiteralForcesHostPath`, narrowed to DATA-ONLY literals. |
| `src/codegen/expressions/assignment.ts` | `emitArrayLengthSetReceiverPark` — `ref.test`-guarded receiver park + null-guarded length store; a statically proven vec receiver keeps byte-identical output. |
| `src/codegen/object-ops.ts` | §10.4.4.2 ordering: `applyAttributeState()` runs AFTER `emitMappedArgValueDefine`; the frozen test reads the PRE-state; the define records its flag word through `__defineProperty_value`. |
| `src/codegen/array-methods.ts` | `emitConcatResultBacking` — `array.new <marker>` instead of `array.new_default` for an f64 carrier. |

Two deliberate narrowings, both stated so a later slice can widen them
knowingly:

- **R2 is data-only.** A literal with a method/accessor/spread, or with a
  function/class/object-literal-valued property, is left alone — which keeps the
  test262 harness's own `$262 = { global: globalThis, gc: function () {}, … }`
  on its existing representation. Re-representing the harness host object is a
  far larger blast radius than this crash needs.
- **R5 uses `UNDEF_F64_BITS` when `ctx.usesArrayHoles` is clear** and
  `HOLE_F64_BITS` when it is set, following the #4491 T8/T11 split: with the
  demand gate off nothing canonicalises `HOLE → UNDEF` at the read boundary, so
  the absence marker would surface as a raw NaN.

## Test Results

**Verdict, stated plainly: 11 rows flipped, not the ≥20 the acceptance bar
asks for.** Four of the five named crashes are gone and the scoped sweep shows
zero regressions, but the second half of the bar — "every non-flip declined
with a named owner" — is what this issue actually meets, and the per-row table
below is that accounting. Two things drove the shortfall, and both are worth
knowing before someone picks this up again: the `~56 rows` estimate treats
`arguments`-descriptor and hole/undefined semantics as a substrate problem when
they are a **representation** problem (a runtime brand on the arguments vec, and
a second NaN payload plumbed through the element-read boundary — each a whole
issue with a mandatory ≥500-row corpus A/B), and roughly a third of the list
turns out to be other lanes' rows that happened to fail inside a
descriptor-shaped assertion.

All numbers below are from runs **executed in this worktree** on branch
`issue-4638`, `--target standalone`, via `tests/test262-runner.ts`
(`runTest262File(..., "standalone")`).

### The issue's own row list (64 rows: `.tmp/lane-B-descriptor.txt` + the Array rows of `.tmp/lane-leftover.txt`)

| arm | pass | fail |
| --- | ---- | ---- |
| base `81445abf7` | 0 | 64 |
| this branch | **11** | 53 |

Flipped FAIL → PASS:

```
built-ins/Object/defineProperties/15.2.3.7-6-a-113.js   (R3 — illegal-cast CRASH)
built-ins/Object/defineProperty/15.2.3.6-3-123.js       (R2 — null-deref CRASH)
built-ins/Object/defineProperty/15.2.3.6-4-117.js       (R3 — illegal-cast CRASH)
built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-2-32.js (R1 — null-deref CRASH)
built-ins/Object/getOwnPropertyNames/15.2.3.4-4-b-3.js  (R1, collateral)
built-ins/Object/defineProperty/15.2.3.6-4-292-1.js     (R4)
built-ins/Object/defineProperty/15.2.3.6-4-293-2.js     (R4)
built-ins/Object/defineProperty/15.2.3.6-4-293-3.js     (R4)
built-ins/Object/defineProperty/15.2.3.6-4-294-1.js     (R4)
built-ins/Object/defineProperty/15.2.3.6-4-295-1.js     (R4)
built-ins/Object/defineProperty/15.2.3.6-4-296-1.js     (R4)
```

**4 of the 5 crash rows the issue named are gone.** The fifth
(`Array/prototype/filter/15.4.4.20-5-7`) is declined below with its owner.

### Scoped regression sweep

`.tmp/scope.txt` — 2,784 ES≤5 rows over
`built-ins/Object/{defineProperty,defineProperties,create,freeze,seal,isFrozen,isSealed,getOwnPropertyDescriptor,getOwnPropertyNames,keys,preventExtensions}`,
`built-ins/Array/{isArray,length,prototype/{concat,filter,forEach,toString,toLocaleString}}`
and `language/arguments-object`.

| arm | pass | fail |
| --- | ---- | ---- |
| base `81445abf7` | 2,726 | 58 |
| this branch | **2,737** | 47 |

**FIXED 11 · REGRESSED 0.** The 11 are exactly the target-list flips above — no
collateral loss anywhere in the 2,784 rows. (`.tmp/before-full.jsonl` vs
`.tmp/after-full.jsonl`, diffed by `.tmp/diff.mjs`; both arms run in this
worktree.)

### Pins

- `tests/issue-4638.test.ts` — **17/17** (13 assertions + 4 `it.fails`
  measured residuals).
- `tests/issue-4622.test.ts`, `tests/issue-4479.test.ts`,
  `tests/issue-4489.test.ts` — **47/47** green.
- `tests/equivalence/` per-file loop over the 17 files this diff plausibly
  touches (arguments, define-property ×5, object-literal accessors, array
  prototype/zero-arg/filter, sparse-array-spread, externref-length-cast,
  empty-object-widening, delete ×2): **160 passed, 2 failed of 162** — and **both
  failures reproduce identically on the BASE arm**, verified by flipping the
  six edited sources back with the file-copy A/B and re-running the two files
  (`arguments-nested-and-loops > for-loop with function declaration in body`,
  `delete-sentinel > delete string property makes it undefined`). Pre-existing,
  not caused here.

### Hot-path note

The corpus-style ≥500-row instrument (#4489/#4519) is **not** triggered by this
diff: nothing here touches the vec element read/write path. `array-methods.ts`
changes only how concat's RESULT backing is allocated — `array.new <value>` in
place of `array.new_default`, which is the same single fill pass, and every slot
the copies reach is overwritten, so a dense concat is unchanged in cost and in
behaviour. `assignment.ts` changes only the `arr.length = N` receiver park, and
only when the receiver is not statically a vec.

## Residuals

Each is a MEASURED failure on this branch with a named owner, not a guess.

**Declined — arguments-object needs a runtime BRAND (B4 + B7, 4 rows).**
`Array/isArray/15.4.3.2-1-13`, `language/arguments-object/10.6-6-2`,
`10.6-7-1`, and the `arguments`-side half of `10.6-13-a-1`. All four escape the
arguments object as a VALUE (`arg = arguments`, `verifyProperty(arguments, …)`),
so #4622's syntactic arm correctly declines and no static analysis can serve
them. The mechanism the issue's plan sketches does exist: `$__holey_array`
(registry/types.ts) proves a nominal SUBTYPE of `$__vec_externref` is
buildable, and `fixups.ts` marks a struct `final` only when nothing extends it,
so registering `$__args_vec` would automatically de-finalize the ordinary
externref vec. **That de-finalization is the blocker**: it applies to every
module that materializes an `arguments` object — which is most of them — and is
an engine-level representation change on the hottest carrier in the compiler.
That is exactly the case the #4489/#4519 precedent reserves the ≥500-row corpus
A/B for, and it is a whole issue, not a slice of this one. The sidecar-bit
alternative is worse: the #3251 overlay side table is an identity-keyed
`ref.eq` SCAN whose fast path is "almost always empty", and an arguments object
is created per CALL, so branding through it would grow the table without bound.
**Owner: the #3251 representation lane** (coordinate with #4622's R2/R3 notes).

**Declined — `arguments.length = <string>` (`S10.6_A5_T4`, 1 row).** The vec's
`length` is an `i32` field; the test requires it to hold the string
`"something different"` and read back identical. A representation wall, exactly
as the issue predicted. Same owner as above.

**Declined — array `length` ≥ 2^31 from an index define (`15.2.3.6-4-183`,
`15.2.3.7-6-a-179`, 2 rows).** `Object.defineProperty(arr, 4294967294, {value:
100})` must set `length` to 4294967295 without materializing a four-billion-slot
backing. The `hasOwnProperty` half already passes (the overlay stores the
index); only the length bump is missing. vec-overlay.ts states this boundary in
its own S3 comment — *"Length values ≥ 2^31 keep the legacy no-op (the i32 vec
length field cannot represent them — documented boundary)"* — and the growth
arm reaches it through `__vec_elem_set_<t>`, which would allocate. Needs the
sparse-tail length representation. **Owner: #3251 S3 / #4434.**

**Declined — `eval` reachable as a VALUE (`filter/15.4.4.20-5-7`, 1 row, the
fifth crash).** Measured: `[11].filter(cb, eval)` null-derefs, and so does
`var e = eval; [11].filter(cb, e)`; `[11].filter(cb, parseInt)` in the same
position is fine, as is `var e = eval; typeof e === "function"`. So it is not
`filter` and not thisArg-in-general — naming `eval` as a value turns on the
runtime-eval boundary and the callback dispatch breaks under it. **Owner: the
runtime-eval boundary lane** (`expressions/eval-inline.ts`,
`function-intrinsic-carrier.ts`, #4442). Pinned `it.fails`.

**Declined — `var x = undefined; x = <object>` at module scope
(`preventExtensions/15.2.3.10-2`, and the second half of `defineProperty/
15.2.3.6-4-21`).** Measured minimal repro: `var o = {}; var o2 = undefined; o2 =
Object.preventExtensions(o); o2 !== o` — `o2` reads `0`. Without the
`= undefined` initializer the same program passes. The module-global type picker
deliberately does NOT consult `varBindingNeedsExternrefForUndefined`;
declarations.ts says why, with a bisected regression
(*"widening module globals on those arms regressed Array.prototype.filter's
harness shapes (15.4.4.20-9-2/-3/-4/-6)"*). **Owner: the value-rep lane, #4204's
`heterogeneousWidenedModuleGlobalType` machinery** — the missing domain is
"nullish initializer vs later object assignment".

**New finding, not previously filed — `get: undefined` on a non-configurable
accessor whose getter is ABSENT is rejected.** Measured: `Object.defineProperty(o,
"foo", {set: f}); Object.defineProperty(o, "foo", {get: undefined})` throws
`TypeError: Cannot redefine property: get attribute of a non-configurable
property`. §10.1.6.3 permits it — the current `[[Get]]` of an accessor defined
with only a setter IS `undefined`, so `SameValue(Desc.[[Get]],
current.[[Get]])` holds. The native treats an absent half (null slot) as
different from an explicit `undefined`. This is the whole of
`defineProperty/15.2.3.6-4-21`. Not fixed here — the fix site is
`object-runtime-descriptors.ts`'s accessor validate arm and landing it would
have invalidated the in-flight after-sweep. **Owner: the #4479 descriptor-store
lane.**

**Measured, partial — concat holes (B5).** `S15.4.4.4_A3_T2`/`_T3` move from
`b[1] === 0` to `b[1] === <the undefined marker>`; `assert.sameValue(b[1],
undefined)` still fails because boxing an f64 UNDEF sentinel to externref for a
CALL ARGUMENT does not resurrect it to `undefined`. `undefSentinelAwareBoxInstrs`
(type-coercion.ts) exists and is opt-in via `from.undefSentinel`, so the vec
element read would have to declare it — which is the element-read hot path and
therefore out of this issue's budget. The direct comparison (`b[1] !==
undefined`) and `b.hasOwnProperty("1")` are both correct now and are pinned.
**Owner: #4491 T8/T11.**

**Not attempted — `Array.prototype.concat` as a VALUE (B6, 2 rows).**
`S15.4.4.4_A2_T1`/`_T2` need `x.concat = Array.prototype.concat; x.concat(y, z,
-1, true, "NaN")` — a VARIADIC call through the proto-method closure ABI, whose
arity is fixed at the member's own `.length` (1). #4619's wrapper-proto
mechanism does not cover variadics. Owner: the `array-object-proto.ts`
callable-value lane.

**Not attempted — `freeze`/`seal` index descriptors on exotic receivers (B2,
3 rows).** `freeze/15.2.3.9-2-a-11/-12/-14` freeze an escaped `arguments`
object and a `String` wrapper and then check the index descriptors. Needs the
same brand as B4/B7 (`-11`) and the string-exotic own-property store (`-12`,
`-14`, which is dev-4639's lane). Owner: as above / `string-exotic-own-props.ts`.

### Every non-flipped target row, with its owner

The acceptance bar is "≥20 flip OR every non-flip declined with a named owner".
11 flipped, so here are the other 53. A row marked **not isolated** means I did
not reduce it to a minimal repro — that is stated rather than guessed at, and
the lane named is the one whose substrate the row's assertion sits on.

| rows | measured root | owner |
| ---- | ------------- | ----- |
| `Array/isArray/15.4.3.2-1-13`, `arguments-object/10.6-6-2`, `10.6-7-1`, `freeze/15.2.3.9-2-a-11` | the arguments object escapes as a value and is the same `$__vec_externref` an ordinary array is — no runtime brand to ask | #3251 representation lane (see the brand analysis above) |
| `arguments-object/S10.6_A5_T4` | `arguments.length = "<string>"` must read back as the string; the vec `length` is an `i32` field | #3251 representation lane |
| `arguments-object/10.6-13-a-1` | `typeof argObj.callee` reads the `Object.prototype.callee` shadow instead of the arguments object's own `callee` | `arguments-callee*.ts` lane |
| `defineProperty/15.2.3.6-4-183`, `defineProperties/15.2.3.7-6-a-179` | index define at 2³²−2 must set `length` to 2³²−1 without a 4-billion-slot backing; vec-overlay.ts's own S3 comment documents the ≥2³¹ no-op | #3251 S3 / #4434 sparse tail |
| `filter/15.4.4.20-5-7` | naming `eval` as a VALUE (directly or aliased) breaks the filter callback dispatch; `parseInt` in the same position is fine | runtime-eval boundary lane (#4442, `eval-inline.ts`) |
| `preventExtensions/15.2.3.10-2` | `var o2 = undefined; o2 = <object>` at module scope — the slot is `f64`, the object reads back `0`. Minimal repro measured; passes without the `= undefined` initializer | value-rep lane, #4204 `heterogeneousWidenedModuleGlobalType` |
| `defineProperty/15.2.3.6-4-21` | `{get: undefined}` on a non-configurable accessor whose getter is ABSENT is rejected — §10.1.6.3 allows it via `SameValue(undefined, undefined)`; the native treats a null slot as different from an explicit `undefined`. Measured, newly identified here | #4479 descriptor-store lane |
| `concat/S15.4.4.4_A3_T2`, `_T3` | now carry the absent marker instead of `0`, but boxing an f64 UNDEF sentinel to externref for a CALL ARGUMENT does not resurrect it (`assert.sameValue(b[1], undefined)` sees a NaN). The direct comparison and `hasOwnProperty` are both correct and pinned | #4491 T8/T11 (`from.undefSentinel` opt-in on the element read) |
| `concat/S15.4.4.4_A2_T1`, `_T2` | `Array.prototype.concat` as a value needs a VARIADIC proto-method closure ABI; the closure arity is the member's own `.length` (1) | `array-object-proto.ts` callable-value lane (#4619) |
| `keys/15.2.3.14-5-a-4` | `typeof arr[i]` CONST-FOLDS from the checker's element type and never reads the slot, so a deleted index reports `"string"` while the value renders `undefined`. Minimal repro measured | the `typeof`-fold lane — `elementReadOfRebindWidenedArray` (#4428) / `typeof-delete.ts` |
| `toString/S15.4.4.2_A1_T2` | a REBOUND `var x` keeps declaration #1's `$__vec_f64`, so a later `Array(undefined,1,null,3)` renders `null` as `0`. `rebindWidenedArrayVecType` only widens on an object-vs-primitive disagreement and classifies `null`/`undefined` as primitive. Minimal repro measured (single-binding form passes) | #4428 element-rebind widening |
| `freeze/15.2.3.9-2-a-12`, `-14`, `preventExtensions/15.2.3.10-3-5` | index descriptors on a `String` wrapper | `string-exotic-own-props.ts` — **dev-4639's lane** |
| `Object/prototype/S15.2.4_A1_T2`, `constructor/S15.2.4.1_A1_T2`, `valueOf/S15.2.4.4_A14` | `Object.prototype` / `Object(fn)` semantics | **dev-4637's lane** (fnctor-prototype / `Object(func)`) |
| `language/statements/return/S12.9_A5`, `annexB/…/catch-redeclared-var-statement` | statement-level semantics | **dev-4640's lane** (statements/expressions smalls) |
| `Date/S15.9.2.1_A2` | `illegal cast in __date_parse()` | Date lane — outside this issue |
| `defineProperty/S15.2.3.6_A1` | needs a DOM `document.createElement` host | not implementable host-free; wont-fix candidate |
| `defineProperty/15.2.3.6-4-195`, `-243-1`, `-243-2`, `defineProperties/15.2.3.7-6-a-183`, `-204`, `-231` | **not isolated.** The array-index descriptor behaviour each one describes PASSES in a hand-written repro (get-only accessor, get+set accessor with an expando backing store, data→accessor conversion via `defineProperties` — all three measured green); the surviving failure is inside `propertyHelper.js`'s `verifyEqualTo` / `verifyWritable` / `verifyProperty`, which I did not reduce | successor of this issue / #4479 descriptor-store lane |
| `defineProperty/15.2.3.6-3-138`, `-4-589`, `-4-622`, `defineProperties/15.2.3.7-2-16`, `Object/create/15.2.3.5-4-15`, `getOwnPropertyNames/15.2.3.4-4-1`, `keys/15.2.3.14-5-13` | **not isolated** | #4479 descriptor-store lane |
| `getOwnPropertyDescriptor/15.2.3.3-4-34`, `-4-4` | **not isolated** — the "Cannot access property on null or undefined at 258:18/259:18" pair the issue lists as the #4619-F triage rows | #4619 |
| `filter/15.4.4.20-9-b-2`, `-14`, `-15`, `-16`, `forEach/15.4.4.18-3-23` | **not isolated** — callbackfn-mutates-during-iteration descriptor rows | #4479 / the HOF lane |
| `toLocaleString/S15.4.4.3_A1_T1`, `A3_T1`, `toString/S15.4.4.2_A1_T4`, `concat/S15.4.4.4_A1_T2`, `A1_T4`, `A3_T1` | **not isolated** — element ToString/hole rendering through `toLocaleString` and the multi-operand concat spec loop | #4491 hole lane / `array-concat-spec.ts` |

## Verification method note

The BEFORE arm was measured with the six edited sources reverted via the
file-copy A/B pattern (`.tmp/base-*.ts`, captured at the first edit). 2,648 of
its 2,784 rows were collected by a sweep started **before** the first edit; a
tsx sweep process imports the whole codegen graph at startup and caches it in
the ESM registry, and every codegen module this diff touches is statically
reachable from `src/index.ts` (no `await import()` of src modules exists), so
mid-run edits cannot reach an already-running sweep. The remaining 136 rows were
run afterwards with the sources explicitly flipped back to the base copies.
