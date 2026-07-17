---
id: 3022
title: "UMBRELLA: Object.defineProperty(ies) descriptor fidelity + non-object-receiver tail (~728 default-lane fails)"
status: done
sprint: current
created: 2026-07-03
updated: 2026-07-05
priority: high
horizon: m
feasibility: hard
reasoning_effort: medium
task_type: umbrella
area: runtime
language_feature: object-defineproperty, property-descriptors
es_edition: 5
goal: spec-completeness
test262_category: built-ins/Object/defineProperty, built-ins/Object/defineProperties
test262_fail: 728
related: [1334, 1629, 1629a, 1631, 2726]
children: [3042, 3043, 3044, 3045, 3046, 3116]
---

> **Reconciled 2026-07-16 (carried in #745 S4 PR):** all dev children (#3042-#3046, #3116) are `status: done`; remaining residuals are senior/arch-scoped and tracked in those issues. Umbrella closed per tech-lead direction.

> **UMBRELLA (decomposed 2026-07-05, dev-2726).** This 728-fail blob is NOT a
> single dispatchable task — it fragments into distinct root causes across two
> clusters (descriptor-fidelity ~600, non-object-receiver ~128). Filed
> sub-issues + cause-scoped clusters are in `## Decomposition` below. Keep this
> issue `ready` as the umbrella tracker; dispatch the **children**. Do NOT claim
> #3022 itself for implementation.

# #3022 — Object.defineProperty(ies): descriptor fidelity tail + non-object receiver

## Source

Default (JS-host) lane test262 harvest, 2026-07-03
(`.test262-cache/test262-current.jsonl`, run `20260703-092808`). Two
sub-buckets:

- `built-ins/Object/defineProperties` + `defineProperty` descriptor
  assertion failures — **600**.
- `TypeError: called on non-object` / "called on non-object" assertion
  failures — **128** — the non-object-receiver arm of `Object.defineProperty`
  and related built-ins (should throw, or should coerce, per spec) is not
  handled.

## Problem

#1334/#1629 ("biggest single bucket", 664 fails at the time) landed the bulk
of descriptor-attribute fidelity, and #1629a/#1631 covered dynamic
(non-literal) descriptor materialization and `Object.create` descriptor maps.
A tail of **600** descriptor-fidelity fails remains — likely rarer descriptor
shapes (getter/setter combined with data-descriptor transitions,
non-configurable → configurable illegal transitions, array `length`
interaction) not covered by the original fix's test corpus. Separately, a
**128**-fail cluster hits `TypeError: called on non-object` where the receiver
of a property-descriptor operation is a primitive — this arm looks entirely
unhandled (should follow `ToObject`/throw semantics per the relevant spec
clause for each built-in, not a blanket internal error).

## Sample failing files

- `built-ins/Object/defineProperties/15.2.3.7-5-b-218.js`
- `built-ins/Object/defineProperties/15.2.3.7-2-16.js`
- `built-ins/JSON/parse/reviver-array-non-configurable-prop-delete.js` (non-object arm)

## Suggested approach

1. Diff the 600 tail fails against the #1334/#1629 test corpus at the time
   those issues closed — identify which descriptor-transition rules
   (8.[6|9|10] `ValidateAndApplyPropertyDescriptor` steps) are still
   unimplemented vs. which are implemented-but-buggy.
2. For the 128 non-object-receiver cluster, find the shared call path (likely
   in the runtime helper backing `Object.defineProperty`/`defineProperties`/
   related reflective ops) and add the missing receiver-type check per spec
   (most should `TypeError` on non-object, matching the "called on
   non-object" test names — verify against `Object.defineProperty` \S15.2.3.6
   step 1).

## Acceptance criteria

- Descriptor-fidelity fail count in `built-ins/Object/defineProperty{,ies}`
  drops materially below the 600 recorded here.
- Non-object receivers to `Object.defineProperty`/`defineProperties`
  produce spec-correct `TypeError`s instead of an internal/vague error.

## Investigation (2026-07-04, dev-3022) — root-cause decomposition

Regrounded against current `main` (595 `definePropert{y,ies}` fails +
48 `Object.defineProperty called on non-object`). Re-ran the failing corpus
in **process isolation** — the naive batch rerun was contaminated by
cross-test `Object.prototype` pollution (a single test's
`Object.prototype.get = fn` poisons the harness's own `Object.defineProperty`
`__name` shim and every subsequent test in the same process), which manufactured
a spurious 70-wide "Cannot both specify accessors and a value" bucket. With the
harness prototype snapshot/restore fix, the tail is **genuinely fragmented across
≥4 deep, high-blast-radius root causes** — this issue is **mis-sized as a single
`medium` slice** and should be decomposed. Each cause below is validated with a
minimal repro.

1. **Struct-widening vs. sidecar read/write mismatch (~40+ tests, the biggest
   clean cluster).** `Object.defineProperty(o, "foo", {value: undefined})` (or a
   no-value descriptor) stores the value in the runtime sidecar
   (`getOwnPropertyDescriptor` correctly reports `value: undefined`), but the
   member read `o.foo` compiles to a **`struct.get` on a widened field**, not
   `__extern_get` — so it returns the field default (`null`/`0`), which
   `SameValue`-differs from `undefined`. Confirmed: compiled `o.foo === undefined`
   is `false` after the define, while `o.missing === undefined` is `true`, and
   `__extern_get` is never hit for `o.foo`. This is the `15.2.3.6-4-*` +
   `verifyProperty({value: undefined})` cluster. Root: the read site resolves the
   receiver to a struct and reads the typed field, bypassing the sidecar where the
   dynamic define wrote — a codegen read/write path-consistency problem
   (`receiverIsStaticStruct` / #1629 S3 territory) crossed with undefined
   representation (#2106). Fix touches shared member-read + value-rep machinery.

2. **Array exotic `[[DefineOwnProperty]]` (~83 tests).**
   `Object.defineProperties(arr, {"0": {value: 12}})` / array `length`
   RangeError + delete-non-configurable-suffix (`15.2.3.7-6-a-*`,
   `15.2.3.7-5-*`). The singular `Object.defineProperty(arr, "length", …)` has an
   inline handler (`maybeEmitVecLengthDefine`), but the **plural** path
   (`__defineProperties` host import) and array-index element updates do not
   implement §10.4.2 ArraySetLength / array-index [[DefineOwnProperty]].

3. **Prototype-chain descriptor-field reading (~33 tests).** A descriptor that is
   `new Ctor()` / a wrapper whose descriptor fields are **inherited** (e.g.
   `Ctor.prototype = {value: X}`) drops the inherited field: `_fnctorProtoLookup`
   returns nothing because `__register_fnctor_instance` is emitted **only for
   module-global constructor closures** (`new-super.ts` gates on
   `moduleGlobals/funcClosureGlobals`), so a **function-scope** `var Ctor =
function(){}` instance is never registered → `_fnctorInstanceCtor.get(inst)`
   is null. `15.2.3.6-3-1xx/2xx`. Fix touches #1712 closure/global machinery.

4. **Fragmented long tail (~370).** Attribute-transition rules
   (non-configurable→configurable illegal transitions, redefine SameValue),
   throw-expected TypeError/RangeError cases, `get:null`/`set:null` accessor
   validation, and the 48 non-object-receiver cases (many are top-level `this`
   as the global object under module wrapping). No shared root; each is a
   separate small fix.

**Recommendation:** decompose into cause-scoped sub-issues (1–3 are each a
distinct senior-dev-sized fix in value-rep / array-exotic / #1712 machinery; 4 is
a grab-bag). None is a low-regression-risk single `medium` PR. No code change is
proposed here — shipping a partial fix to any one cause risks broad regressions
across the host-mode object surface without a full-CI validation pass.

## Decomposition (2026-07-05, dev-2726)

Acting on the dev-3022 recommendation above (which analysed the causes but did
not file them). Re-harvested both clusters from
`.test262-cache/test262-current.jsonl` and cross-tabulated error string × feature
to separate true root causes from shared symptoms.

### Cluster 1 — descriptor-fidelity (~600, `built-ins/Object/define{Property,Properties}`)

The dev-3022 causes 1–3 are the **senior** value-rep / exotic / closure clusters;
the grab-bag (cause 4) splits into three cleaner pieces. Filed vs cause-scoped:

| root cause                                                                                                                                            | fails | scope                                       | tracked as                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------- | -------------------------------------------- |
| **attribute round-trip fidelity** (writable/enumerable/configurable via `verifyProperty`, primitive values)                                           | ~74   | **DEV**                                     | **#3042** (filed)                            |
| **illegal-transition + SameValue validation** (non-configurable redefine should-throw; +0/-0/NaN; false-positive Cannot-redefine) — dev-3022 cause 4  | ~50   | **SENIOR**                                  | **#3043** (filed)                            |
| **descriptor-shape codegen crashes** (invalid Wasm / illegal cast / op.endsWith / ctors-not-defined)                                                  | ~16   | **DEV**                                     | **#3044** (filed)                            |
| **value round-trip: struct-widening vs sidecar read** (`value: undefined`/object read returns struct default, `SameValue`-differs) — dev-3022 cause 1 | ~40+  | **SENIOR** (value-rep, #1629 S3 / #2106)    | cause-scoped, file when a senior picks it up |
| **array exotic `[[DefineOwnProperty]]`** (plural `defineProperties(arr,…)`, array-index/`length` §10.4.2) — dev-3022 cause 2                          | ~83   | **SENIOR** (array-exotic, #2186 vec)        | cause-scoped                                 |
| **prototype-chain descriptor-field read** (inherited `value`/`get` dropped; function-scope fnctor instance not registered) — dev-3022 cause 3         | ~33   | **SENIOR** (#1712 closure/global machinery) | cause-scoped                                 |

The three **cause-scoped** senior clusters keep their full repros in the dev-3022
section above; they are deliberately NOT filed as separate issues yet (each is a
senior-dev-sized value-rep/exotic fix — file on pickup to avoid stale un-owned
issues). #3042/#3044 are the immediately **dev-dispatchable** wins.

### Cluster 2 — non-object-receiver (~128, "called on non-object")

Cross-tab (error string × feature) shows these are NOT one bug — they are
internal `Object`/`Reflect` ops hitting a non-object receiver across ~7 features:

| root cause                                                                                                                                 | fails | scope                                        | tracked as                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **top-level `this` / global-object model** (`Object.defineProperty(this,…)` at script top level; global/eval var+func declaration binding) | ~89   | **ARCH/SENIOR**                              | folds into **#2726 (b)** — same structural root (top-level-`this`-as-global-object). Route to that issue's architect spec; do NOT dup. |
| **class private-element brand check** (`Reflect.has` on non-object; private methods/generators/static-private)                             | ~8    | **DEV**                                      | **#3045** (filed)                                                                                                                      |
| **JSON.parse reviver `this`-binding** (reviver `this` must be the holder)                                                                  | 4     | **DEV**                                      | **#3046** (filed)                                                                                                                      |
| **module namespace exotic object** (`Reflect.{has,deleteProperty,defineProperty,set,preventExtensions}` on `import * as ns`)               | 10    | **SENIOR** (namespace-object representation) | cause-scoped, file on pickup                                                                                                           |
| **annexB `[[IsHTMLDDA]]`** (document.all emulation as `@@replace`/`@@match`)                                                               | 6     | DEFERRED (niche annexB)                      | note only                                                                                                                              |
| **`$262.createRealm` cross-realm** (`create-proto-from-ctor-realm-*`; OArray undefined — realms unsupported)                               | 6     | DEFERRED (realm infra)                       | note only                                                                                                                              |
| misc singletons (Date/Error/RegExp.prototype called-as-function, Proxy, typeof get-value, defineProperties edge)                           | ~5    | mixed                                        | note only                                                                                                                              |

**Big finding:** ~89 of the 128 "non-object" fails share the **top-level-`this`-
as-global-object** root cause — the SAME structural gap as the two remaining
#2726 group-(b) tests (`S11.4.1_A3.1` `delete this.y`, `S11.4.1_A3.3_T1`
implicit-global). Fixing the global-object model (architect spec on #2726 (b))
would clear ~89 defineProperty fails as a side effect. This is the single
highest-leverage item in the whole #3022 tail and is architect-gated.

### Dispatch summary

- **DEV-dispatchable now:** #3042 (attribute fidelity), #3044 (codegen crashes),
  #3045 (class private brand-check), #3046 (JSON reviver `this`).
- **SENIOR:** #3043 (transition validation) + the 3 cause-scoped descriptor
  clusters (value-round-trip, array-exotic, prototype-chain) + module-namespace.
- **ARCH-gated:** the ~89-fail top-level-`this`/global-object model → #2726 (b).
- **DEFERRED:** annexB `[[IsHTMLDDA]]`, `$262.createRealm` realms.

## Senior pickup (2026-07-09, fable-3022)

Regrounded the full 570-file `definePropert{y,ies}` residual on current main
with per-test intrinsic snapshot/restore (the process-isolation contamination
fix) and cross-tabbed error signature × compiled-import signature. Empirical
mechanism sizes (supersede the 2026-07-05 estimates): **Array receivers 236**,
descriptor-reader/prototype-chain ~160, arguments receivers 57, accessor
read-lane ~80, residual transition matrix small (most of the #3043 headline
repros — +0/-0 SameValue, enumerable toggle, false-positive redefine — already
pass post-#3042).

- **#3116 (filed + landed this pickup):** array-exotic `[[DefineOwnProperty]]`
  — element/length defines now write into the native vec (`__vec_set_elem` /
  `__vec_set_len` exports + runtime `_vecDefineOwnProperty` §10.4.2), plus
  `get/set: null` compile-time TypeError and the compile-time/runtime
  descriptor-state veto. Cluster: 570 → 424 fails (**+146**).
- **#3043 remains open** (claimed, fable-3022): residual matrix is now the
  fully-static lane divergence (accessor `configurable:false→true` and
  data→accessor on struct receivers compile away without runtime mirroring)
  plus the non-callable-getter define-leak.
- Next cause-scoped candidates: descriptor prototype-chain/fnctor reads
  (~160, needs #1712 registration for function-scope ctors), accessor
  read-lane on vec elements (~80), arguments-object exotic (~57).
