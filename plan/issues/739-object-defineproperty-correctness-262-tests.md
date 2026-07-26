---
id: 739
title: "Object.defineProperty correctness — host-lane store-unification (representation pinning) + defineProperties two-phase apply"
status: done
completed: 2026-07-26
assignee: ttraenkler/opus-loop-e
created: 2026-03-22
updated: 2026-07-18
priority: high
feasibility: hard
reasoning_effort: max
horizon: l
task_type: bugfix
area: codegen
language_feature: object-defineproperty, property-descriptors
goal: es5
sprint: Backlog
test262_fail: 412
test262_category: built-ins/Object/defineProperty, built-ins/Object/defineProperties
related: [3230, 3022, 2668, 2372, 2944, 2937, 2680, 3138, 1629, 797, 2726, 2986]
resolves_also: [3230]
files:
  src/codegen/declarations/object-shape-widening.ts:
    modified:
      - "host-mode representation pinning for dynamic-define receivers (S1)"
  src/codegen/object-ops.ts:
    modified:
      - "defineProperties non-literal descriptors route to two-phase __defineProperties (S2)"
---

# #739 — Object.defineProperty correctness: store-unification residual

## ECMAScript spec reference

- [§20.1.2.4 Object.defineProperty](https://tc39.es/ecma262/#sec-object.defineproperty) — step 3: DefinePropertyOrThrow
- [§20.1.2.3 Object.defineProperties / ObjectDefineProperties](https://tc39.es/ecma262/#sec-objectdefineproperties) — **two-phase**: convert ALL descriptors via ToPropertyDescriptor first (each field read exactly once, throws before any apply), then apply in order
- [§10.1.6.3 ValidateAndApplyPropertyDescriptor](https://tc39.es/ecma262/#sec-validateandapplypropertydescriptor)
- [§6.2.5.5 ToPropertyDescriptor](https://tc39.es/ecma262/#sec-topropertydescriptor) — descriptor fields read via full `[[Get]]` (prototype-inclusive, fires accessors on the descriptor object)

## History / re-scope (2026-07-17, fable-739)

The original "262 tests, implementation missing" framing is obsolete. Since
2026-03 the substrate landed piecewise: #633/#724/#929 (receiver TypeErrors),
#1113/#1460/#1629/#1629a (descriptor attribute fidelity + `_wasmPropDescs`
sidecar + dynamic-descriptor materialization), #797 (descriptor subsystem),
#2680 (prototype-inclusive ToPropertyDescriptor reads), #3138 (call-site fnctor
instance registration for function-scope ctors), #3022 umbrella
(#3042/#3043/#3044/#3116 — attribute round-trip, transition validation, crash
shapes, array-exotic vec defines), #1252 (SameValue).

**Current baseline (default/JS-host lane, `.test262-cache/test262-current.jsonl`
fetched 2026-07-17): 412 fails across `built-ins/Object/definePropert{y,ies}`**
(defineProperty 221/1131, defineProperties 191/632; plus gOPD 13,
gOPDs 7). Family split:

| family        | fails | dominant mechanism                                              |
| ------------- | ----- | --------------------------------------------------------------- |
| 15.2.3.6-4-\* | 128   | arguments-exotic (~57, OUT of scope), array residual, read-back |
| 15.2.3.7-5-b  | 99    | store-split via defineProperties + per-entry expansion          |
| 15.2.3.6-3-\* | 90    | **store-split read/write lanes** (see root cause)               |
| 15.2.3.7-6-a  | 68    | per-entry apply ordering + array residual                       |
| other         | 27    | singletons (wrapper models, TypedArray-resizable, Proxy-order)  |

**#739 now owns the two biggest UN-owned clusters**: (1) the host-lane
**store-unification** that #3230 concluded is the only viable fix (that issue is
`blocked` — it records two failed bounded point-fixes, net −7, and explicitly
defers to "the full read/write/define store-unification"; landing #739 S1
resolves #3230), and (2) the **defineProperties two-phase apply**. Explicitly
NOT owned here (see "Out of scope").

## Root cause (confirmed against source + baseline, 2026-07-17)

One property can live in **two stores** that do not see each other:

1. **Compile-time lane**: the widening pre-pass
   (`collectEmptyObjectWidening` / `collectPropsFromStatements`,
   `src/codegen/declarations/object-shape-widening.ts:24` / `:721`) sees
   `var obj = {}` + `Object.defineProperty(obj, "p", …)` and synthesizes a
   widened closed struct with field `p`
   (`recordDefinePropertyWiden`, `:700-719`). Every later dot-read of `obj.p`
   lowers to `struct.get`, every plain assignment `obj.p = X` to `struct.set`.
2. **Runtime lane**: the define itself routes (for any non-inline-literal
   descriptor — `src/codegen/object-ops.ts:1567-1596` (#1629a), `:1328` (#2668
   Slice A), and for no-value/explicit-undefined literals via
   `emitExternDefinePropertyNoValue`/`:1608`) to `__defineProperty_desc`
   (`src/runtime.ts:9680`), which applies the property into the **runtime
   store** — native JS property or `_wasmPropDescs`/`_wasmStructProps` sidecar
   (`runtime.ts:9764-9813`). `_structFieldWriteback` (`runtime.ts:9783`)
   mirrors _data values_ back into the struct field, but **accessors cannot be
   mirrored**: a `struct.get` can never invoke a getter, a `struct.set` can
   never invoke a setter.

Evidence (baseline error signatures, `15.2.3.6-3-2xx`):

- `-207..-230` (~30 tests): `assert.sameValue(obj.property, "…GetProperty")`
  — **read lane**: defined accessor's getter never fires on dot-read
  (`struct.get` on the widened field returns the default). Exactly the #3230
  minimal repro.
- `-238..-260` (~25 tests): `assert.sameValue(data, "overrideData")` —
  **write lane**: defined setter never fires on `obj.property = X`
  (`struct.set` bypasses the sidecar setter).
- The same shape dominates `15.2.3.7-5-b-*` (via defineProperties) and part of
  `15.2.3.6-4-*`/`15.2.3.7-6-a-*` (delete/hasOwnProperty/for-in against the
  wrong store).

The descriptor **read** side is largely already correct: `__defineProperty_desc`'s
field reader is prototype-inclusive (#2680, `runtime.ts:9710-9743`), handles
WasmGC-struct descriptors, wraps closure accessors (#1629a), and function-scope
fnctor descriptors register at the call site (#3138,
`src/codegen/expressions/new-super.ts:1189`). For a plain-JS receiver + plain-JS
descriptor it bottoms out in **native `Object.defineProperty`**
(`runtime.ts:9751-9754`) — full §10.1.6.3 for free. The problem is that the
_receiver_ is a struct, so the applied property is unreachable from compiled
reads/writes.

**Why a point-fix is forbidden**: #3230 measured both bounded approaches
(read-reroute: +23/−30 net −7; read-reroute + runtime fallback: still fails) and
proved the field-vs-sidecar choice is _widening-sensitive_ — an unrelated
`getOwnPropertyDescriptor` call elsewhere flips the receiver's representation.
Do NOT re-attempt a read-side or write-side point fix.

**Why representation pinning is the right unification**: the standalone lane
already ships it — #2372's `dynamicDescriptorWidenVars` poison
(`object-shape-widening.ts:780-782`, checked at `:123`) suppresses widening for
dynamic-define receivers so they stay `$Object` and every MOP op routes through
one store. The host lane was exempted on the assumption the "live-mirror
writeback" bridges the gap — #3230 disproved that for accessors. The
bracket-form (`obj["property"]`, which keeps the receiver externref) already
passes these tests on main — the uniform extern lane is _proven correct_; we
just have to keep the receiver on it.

## Implementation Plan (2026-07-17, fable-739 — supersedes the 2026-05-21 plan)

### Slice S1 — host-mode representation pinning (the store-unification) — ✅ COMPLETE (PR #3317, merged 2026-07-18)

**S1 landed** via PR #3317 (`fix(#739): host-lane representation pinning for
runtime-store defines`) — the host-lane representation pinning in
`src/codegen/declarations/object-shape-widening.ts` that resolves the #3230
read/write-lane repros. The S1/S2 slice spec itself landed in PR #3310
(`plan(#739): defineProperty store-unification spec`). This issue stays
`status: ready` — **S2 (two-phase `defineProperties`) is still outstanding**
(see below).

**File: `src/codegen/declarations/object-shape-widening.ts`**

Goal: an empty-`{}` var that is the receiver of any define that lands in the
runtime store must NOT be widened to a struct; it stays a host plain object
(`$Object`/externref), so define → read → write → delete → for-in →
hasOwnProperty → gOPD all use the ONE native store.

1. **New poison predicate — "runtime-store define receiver"** (host lane).
   In `collectPropsFromStatements` (`:721`) where defineProperty calls are
   already pattern-matched (`:750-786`), and in a sibling walker for
   `Object.defineProperties` (extend `markStandaloneAccessorDefineTargets`'s
   match shape at `:592` — it already parses both call forms), classify the
   define as **runtime-routed** when any of:
   - descriptor arg is not an `ObjectLiteralExpression` (mirrors
     `object-ops.ts:1580`'s routing);
   - descriptor literal has a present `get`/`set` key (any value, incl.
     `undefined` — mirrors `:592`'s doc);
   - descriptor literal has an explicit-`undefined` field
     (`descriptorUndefinedFields` shape — mirrors `object-ops.ts:1608-1613`);
   - descriptor literal has NO `value` key (no-value defines route through
     `emitExternDefinePropertyNoValue` → runtime sidecar);
   - the call is `Object.defineProperties(varName, …)` in **any** shape
     (per-entry expansion or dynamic route — both land in the runtime store,
     and the pre-pass never widened for them anyway, but the _pin_ must also
     defeat the checker's evolved-type struct registration, see step 2);
   - the property key is not a string/numeric literal (dynamic keys can't be
     widened fields).

   Keep pure `{ value: <literal>, writable/enumerable/configurable:
<boolean-literal> }` data-descriptor defines OUT of the predicate — the
   struct fast path + flag side-channel currently passes that family
   (`15.2.3.6-4-*` static rows); do not disturb it in S1.

2. **Pin via the existing #2584/#2944 discipline, not a new mechanism.** For a
   matched var, add it to `ctx.objectHashConsumerVars`
   (`src/codegen/context/types.ts:2158`). The existing suppression branch at
   `object-shape-widening.ts:130-179` then (a) skips widening and (b) — the
   load-bearing part — records the var's **evolved checker type** in
   `ctx.objectHashConsumerTypes` (`types.ts:2175`), which
   `resolveWasmType` (`src/codegen/index.ts:5529`), `ensureStructForType`
   (`index.ts:5771`) and `resolveStructName`
   (`src/codegen/property-access.ts:599`) already refuse — keeping the var
   externref through every escape (locals, returns, params, fields). Without
   this the #2937 compiled-acorn null-deref recurs; the discipline is exactly
   why #2849's second landing stuck. Do NOT bypass it with a widening-only
   suppression.

3. **Standalone stays byte-identical.** The `ctx.standalone`-gated poisons
   (`:780`, `:86-110`) and `dynamicDescriptorWidenVars` remain untouched. All
   S1 changes are `!ctx.standalone`-guarded (this also avoids colliding with
   in-flight #2042). WASI: treat as standalone (no host MOP).

4. **Codegen effect (no new Wasm patterns needed)** — after pinning, for a
   pinned `obj`:

   ```wat
   ;; before (widened struct — the bug):
   local.get $obj            ;; (ref null $__anon_N)
   struct.get $__anon_N $property   ;; getter never fires

   ;; after (pinned $Object — the already-proven bracket lane):
   local.get $obj            ;; externref
   global.get $str_property
   call $__extern_get        ;; native [[Get]] → fires the getter
   ```

   Same for writes (`__extern_set` → native `[[Set]]` → fires setters) and
   `delete`/`in`/for-in/`hasOwnProperty` (host MOP). The define itself keeps
   the existing `emitDefinePropertyDescRuntime` → `__defineProperty_desc`
   emission (`object-ops.ts:332-428`), which for a now-plain receiver takes
   the fully-native branch (`runtime.ts:9751`) — §10.1.6.3 validation,
   attribute defaulting, redefine-preserves-omitted, SameValue (+0/−0/NaN),
   non-extensible checks all delegated to the host engine.

5. **Descriptor flag tables**: `definedPropertyFlags` /
   `sidecarDefinedPropertyKeys` / `definePropertyReceiverKeys` recording in
   `compileObjectDefineProperty` (`object-ops.ts:1149-1168`, `:1782-1810`) is
   receiver-representation-agnostic — leave as-is. `_wasmPropDescs` flag bytes
   (bit0 writable, bit1 enumerable, bit2 configurable, bit4 accessor —
   `runtime.ts:303`, `:752`) keep serving WasmGC-struct receivers (class
   instances, non-empty literals) that legitimately stay structs.

### Slice S2 — defineProperties: two-phase convert-then-apply

**File: `src/codegen/object-ops.ts`** — `compileObjectDefineProperties`
(`:3291`).

Root cause: the static expansion (`:3396-…`) treats a **non-literal inner
descriptor** as well-formed (`isStaticDescWellFormed` returns `true` for
identifiers/member-accesses, `:3358-3364`) and expands to sequential
single-property defines. That interleaves ToPropertyDescriptor with
application, violating §20.1.2.3's gather-then-apply: (a) a conversion
TypeError for descriptor k must fire **before** any property is defined
(`15.2.3.7-6-a` partial-application rows, the "Expected TypeError, got
Test262Error" bucket), and (b) each descriptor field must be read exactly once,
in order (`15.2.3.7-5-b` getter-probe rows).

Change: `isStaticDescWellFormed` returns `false` for any inner descriptor that
is not an inline `ObjectLiteralExpression` (drop the `:3358-3364` "identifier →
expand statically" arm). The whole call then falls to the existing dynamic
route (`:3985`, `__defineProperties` import at `:4005`), whose runtime
(`runtime.ts:9939`) already gathers all `_toPropertyDescriptorValidate`
conversions first (`:10056`, `:10092`) and applies second — and shares the
#2680 prototype-inclusive reader. All-literal descriptor maps keep the static
expansion (their conversion cannot observably interleave — no getters — except
the already-handled `get/set: null` pre-check at `:3305-3336`).

Note S2 is ordering-correct only in combination: with S1 pinning the receiver,
the dynamic route's applies land in the store compiled reads actually consult.
Land S1 first, S2 second (both measured independently).

### Slice S3 — measure-first residual harvest (no code until measured)

After S1+S2, re-harvest `built-ins/Object/definePropert{y,ies}` and re-bucket.
Expected remaining ≥ ~150: arguments-exotic, array residual, wrapper-object
expandos (`new Boolean(false)` etc. compiled as primitives so descriptor
expando writes vanish — a wrapper-object-model gap, file separately),
`Object.create` interactions. File cause-scoped follow-ups; do NOT grab-bag
them into this issue.

### §10.1.6.3 validation matrix — where each rule lives after S1/S2

| rule                                             | pinned receiver (new)                                               | struct receiver (unchanged)                    |
| ------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------- |
| attribute defaulting on create                   | native engine                                                       | `_validatePropertyDescriptor` `runtime.ts:752` |
| redefine preserves omitted attributes            | native engine                                                       | same                                           |
| non-configurable illegal transitions → TypeError | native engine                                                       | same (`:1606-1646` region)                     |
| SameValue exception (+0/−0, NaN)                 | native engine                                                       | same (#1252)                                   |
| data ↔ accessor switch veto                      | native engine                                                       | same                                           |
| non-extensible add veto                          | native engine                                                       | same                                           |
| descriptor mixing value+get/set → TypeError      | `_toPropertyDescriptorValidate` `runtime.ts:850`                    | same                                           |
| get/set callable-or-undefined                    | compile-time `:1192-1218` + runtime                                 | same                                           |
| array `length`/index exotic                      | `maybeEmitVecLengthDefine` `:640` + `_vecDefineOwnProperty` (#3116) | same                                           |

### Edge cases

- **Aliased receivers** (`var a = obj;` then define through `a`) and
  **parameter receivers**: the name-based pre-pass cannot see them — they stay
  un-pinned and keep today's behavior. Documented limitation (same as #2584's).
- **Mixed literal + dynamic defines on one var**: any runtime-routed define
  pins the var; the literal defines then take the externref
  (`emitExternDefinePropertyValue`) path — natively correct, verified by the
  bracket-form lane.
- **`Object.defineProperty` return value**: pinned receiver flows out as
  externref — member reads on it go through `__extern_get`; no typed-struct
  consumer can exist for it after the escape discipline (that is the point).
- **Symbol keys / numeric keys**: `_toPropertyKey` (`runtime.ts:9687`) handles
  both; numeric keys defeat widening already (predicate item: non-literal key
  pins).
- **verifyProperty round-trips** (gOPD + delete + restore): native on pinned
  receivers; sidecar `_readOwnDescriptor` on struct receivers — both already
  exercised.
- **for-in enumeration order after defines**: native on pinned receivers
  (#3323 tracks the vec/accessor order residual — unaffected here).
- **Frozen/sealed receivers**: `Object.freeze/preventExtensions` on a pinned
  receiver is native; do not add custom checks.

### Test262 coverage plan

Measurement discipline (**process isolation is mandatory** — shared-process
reruns are contaminated by tests mutating shared intrinsics used as descriptor
objects, e.g. `Math.value=…`; this manufactured a spurious ~26-70-wide bucket
twice before, see #3022/#3230 notes):

1. Baseline: full `built-ins/Object/definePropert{y,ies}` process-isolated run
   on the branch base (expect ≈412 fails per the 2026-07-17 jsonl).
2. After S1, after S2: same run; branch-vs-main diff must show the flipped
   sets explicitly (fail→pass AND pass→fail lists, not just counts).

Targets (gate each slice on its own diff):

- S1: `15.2.3.6-3-207..230` (read lane, ~30) + `-238..-260` (write lane, ~25)
  - the `15.2.3.7-5-b` store-split share flip to pass; **zero pass→fail** in:
  * guard set A: `15.2.3.6-3-23..45` (25 currently passing — the historic
    for-in/`Object.create`-descriptor regression cluster the Slice-A gate was
    protecting);
  * guard set B: `15.2.3.6-3-154..177` (`{writable:true}`-then-write — the
    exact cluster #3230's Attempt A regressed);
  * guard set C: the currently-passing `15.2.3.6-4-*` static data-descriptor
    rows (struct fast path must remain reachable for non-pinned receivers).
- S2: `15.2.3.7-6-a` partial-application TypeError rows + `15.2.3.7-5-b`
  getter-once/ordering rows.
- Overall acceptance: `definePropert{y,ies}` cluster 412 → **≤ 250** after
  S1, **≤ 200** after S2, with gOPD (13) expected to co-improve. Equivalence
  suite + `tests/issue-2944.test.ts` (compiled-acorn) green.
- #3230's acceptance items are covered verbatim by S1 (mark #3230 resolved in
  its file when S1 lands, crediting the store-unification).

### Out of scope (do not scope-creep this issue)

- **Arguments-object exotic `[[ParameterMap]]`** (`15.2.3.6-4-253..291`+,
  ~57 fails) — needs an arguments-object MOP model; sibling of #2986
  (standalone twin). File separately.
- **Array residual** beyond what #3116 landed (`Cannot redefine property: 0`,
  `__vec_set_elem` OOB rows) — #2668 Slice C territory (owned, sd-2668c).
- **Top-level-`this`-as-global receiver** (~89 across clusters) — #2726 (b),
  arch-gated.
- **Wrapper-object model** (`new Boolean/Number/String` as expandable
  objects) — file on S3 harvest.
- **Standalone lane** — #2042 (in-progress) + #2372/#2986-#2989. Every S1/S2
  change is host-gated.
- **Proxy ownKeys order, TypedArray-resizable** singletons.

### Risks / coordination

- **#2937/#2944 evolved-type hazard (the big one)**: pinning without the
  escape discipline null-derefs compiled-acorn. Mitigation: reuse
  `objectHashConsumerVars`→`objectHashConsumerTypes` verbatim (step S1.2);
  gate on `tests/issue-2944.test.ts` + equivalence + full CI.
- **Perf**: pinned receivers lose the struct fast path for ALL their property
  ops. Bounded: only empty-`{}` vars that are targets of runtime-routed
  defines (test262-shaped code; rare in app code). Watch the playground
  benchmark diff in CI.
- **File conflicts**: `src/codegen/object-ops.ts` is also #2668's (sd-2668c)
  and #2042's hot file. S1 deliberately concentrates in
  `object-shape-widening.ts` (low contention); S2's `object-ops.ts` touch is
  ~10 lines in `isStaticDescWellFormed`. Coordinate before enqueue; re-merge
  `origin/main` before PR.
- **merge_group-only failures**: descriptor changes historically park in the
  queue re-validation (#2547 auto-park hit #2668 Slice A). Budget for one
  park/diagnose cycle.
- **Do NOT repeat the #3230 traps**: no read-only or write-only rerouting; no
  `__extern_get` fallback layering. Pinning removes the second store instead
  of bridging it.

## S2 outcome (2026-07-26, opus-loop-e) — descriptor-object pinning

**S2 as landed is NOT the "defineProperties two-phase apply" originally planned
above.** Re-measurement redirected it; both changes are in
`src/codegen/declarations/object-shape-widening.ts` (host-gated).

### What was actually broken

S1 pinned runtime-store-define **receivers**, but its pre-pass
(`collectEmptyObjectWidening`) only reaches vars initialized with an **empty
`{}`** literal. A **non-empty** literal that later receives a
runtime-store-routed define stayed a widened closed struct, so an accessor
landed in the `_wasmPropDescs` sidecar while the struct-field reader read the
struct — and the getter never fired, though §6.2.5.5 requires a full `[[Get]]`
per descriptor field. **Same two-store defect as #739, on the DESCRIPTOR object
instead of the receiver.**

### The two changes

1. **`collectGrowableObjectLiterals`** — mark a non-empty literal `grows` when it
   receives a runtime-store-routed define (reusing
   `definePropertyRoutesToRuntimeStore`). Marking `grows`, rather than adding a
   separate pre-arm like the standalone `markStandaloneAccessorDefineTargets`
   block, is deliberate: it keeps **every** existing #1897/#2837 consumer-safety
   poison in force (arithmetic field reads, concrete-struct-typed positions,
   `delete V.k`, `V[expr]`, `for…in V`).
2. **`Object.<mop>(…)` carve-out** from the concrete-struct-consumer poison, via
   the existing #2992 S6 `isObjectMopCallArg` helper, so both arms agree. TS
   types `defineProperty`'s 3rd argument as `PropertyDescriptor`, which has named
   own props, so `typeRequiresStruct` was poisoning **every** descriptor object —
   precisely the vars this pass must route to `$Object`. The **map** form
   (`PropertyDescriptorMap`) was already safe (pure string-index dictionary),
   which is why acorn's `prototypeAccessors` stayed marked.

### Measured (varied-axis A/B, on merge base `58991cc19`)

16-case matrix varying descriptor **construction** (empty / non-empty / nested /
`Object.create` / fn-returned), which descriptor **field** carries the accessor
(configurable / enumerable / writable / value), the receiver **key kind**, and
`defineProperties`; plus 4 struct-path guards and a negative control:

| arm | result |
| --- | --- |
| merge base | **6 / 16** |
| with fix | **13 / 16** |

**7 real flips**; all 4 guards pass in **both** arms (no struct-path regression);
the negative control reports failure in both, proving the harness can fail.
`tests/issue-739-s2-descriptor-pin.test.ts` (15 cases) is **15/15 with the fix
and 7-failed/8-passed on the merge base** — the 8 that pass there are exactly the
2 controls + 4 guards + 2 documented residuals, by construction.

### test262 flip count: **0 of 36** — measured, not projected

**This fix flips ZERO test262 tests on the B1 surface. Do not credit it with the
census's B1 figure (38 ES5-scoped / 61 corpus-wide).** That number was always a
floor; measured, the recovery here is 0.

Population: every baseline-failing test with signature `accessed !== true` under
`built-ins/Object/{defineProperty,defineProperties,create}` — **n = 36**. Run with
the fix: `pass=0 fail=36 other=0`.

**Why** — and it is the unvaried-axis trap one level out. The B1 descriptors are
**constructed instances**, not object literals:

```js
var proto = { enumerable: false };
var ConstructFun = function () {};
ConstructFun.prototype = proto;
var child = new ConstructFun();               // <-- NOT an object literal
Object.defineProperty(child, "enumerable", { get: function () { return true; } });
Object.defineProperty(obj, "property", child);
```

`collectGrowableObjectLiterals` requires
`ts.isObjectLiteralExpression(decl.initializer)`, so a `new`-constructed
descriptor is outside this pass entirely — as it is outside S1's
`collectEmptyObjectWidening`. My 16-case matrix varied descriptor *literal*
construction (empty / non-empty / nested / `Object.create` / fn-returned) but
never varied **`new`**, which is the shape the real population actually uses.

**So the honest standing of this change is: a correct, regression-free spec fix
with 7 proven behavioural flips and 0 test262 flips.** It closes a real §6.2.5.5
violation and guards it, but it is not the B1 lever.

#### The B1 population is NOT one descriptor shape — measured, so do not extend blindly

Before attempting a `new`-constructed extension, the 36 files were classified **by
reading the corpus** rather than by enumerating axes anyone could think of. The
descriptor object is constructed **at least seven different ways**:

| descriptor construction | n |
| --- | ---: |
| `new ConstructFun()` — constructed instance | 16 |
| the **global object** (`descObj` is the global) | ~9 |
| inline inside the `defineProperties` map | 4 |
| array literal | 2 |
| object literal | 2 |
| function object | 2 |
| `arguments` object | 1 |

**A perfect `new`-constructed pin would therefore cap at 16 / 36 (44 %)**, with the
remaining 20 spread over six further shapes — several of which (global object,
`arguments` object, function object) are not var-initializer shapes at all and can
never be reached by a declaration-site pre-pass.

**Conclusion: the declaration-site pinning strategy is the wrong lever for B1.**
Each new shape needs its own pre-pass arm, and the population is long-tailed. The
correct fix is at the **`ToPropertyDescriptor` reader** — make the descriptor
field read a genuine `[[Get]]` regardless of how the descriptor object is
represented — not another initializer-shape arm. That is a substantially larger,
reader-side slice and should be scoped as its own issue.

**Method note (the reason this table exists):** the axis that mattered was
invisible from the fix side and obvious from the corpus side. **Derive the matrix
from the failing population, not from the axes you can think of.** Reading ten
real failing files first would have shown `new ConstructFun()` immediately — and
would also have shown that `new` is only 44 % of it.

### Documented residuals (asserted in the test file, not fixed here)

- **Descriptor returned from a function** (`const d = mk()`) — the name-based
  pre-pass cannot see it. Same class as the aliased/parameter-receiver limitation
  already documented for S1.
- **`defineProperties` map MEMBER descriptor** — the nested member is not the
  marked var. This is the remaining piece of the ORIGINAL S2 plan (two-phase
  apply) and is the natural next slice.

### Method note

⚠️ This is the `propertyHelper`/`verifyProperty` vacuity area (#3468/#3592/#3434).
Every assertion checks an **observable getter invocation** via a mutated flag,
never merely "no throw". While investigating this issue the swallowed-exception /
no-op failure mode fired **three times** — including once where a candidate fix
produced byte-identical results to the merge base. **Always run the with-fix and
reverted arms and diff them.** See #3626 §2.2.1 for the full account and for the
refutation of that section's original "confirmed floor of 73".

## Superseded plan

The 2026-05-21 architect plan (fresh `_validateAndApplyDescriptor` hardening,
metadata-byte extension, TypedArray/length special-casing) is superseded: its
items landed via #1629/#3042/#3043/#3116/#1252 or are re-scoped above. See git
history of this file for the original text.
