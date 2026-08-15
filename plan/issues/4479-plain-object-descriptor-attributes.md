---
id: 4479
title: "ES5 standalone: plain-object property-descriptor attribute semantics — defineProperty/defineProperties/create/gOPD on $Object receivers (~90 rows)"
status: in-progress
sprint: current
created: 2026-08-15
updated: 2026-08-15
loc-budget-allow:
  # +13. The bulk of this issue's `object-ops.ts` work was EXTRACTED to the new
  # `src/codegen/define-properties-map.ts` (the gate's own prescribed remedy),
  # taking the file from +87 to +13. What remains is irreducible at the call
  # site: the `staticDescriptorMapKey` decline in the well-formedness pre-scan,
  # and the `compileDescriptorMapAsDynamicObject` dispatch in the dynamic
  # fallback — each with a one-sentence pointer to the module that owns the
  # reasoning. Shaving further deletes the pointer, not the code.
  - src/codegen/object-ops.ts
  # +9. A ONE-ARGUMENT change to a closure inside the `__obj_define_from_desc`
  # native builder (`getField(key, nullishToNull = true)`), plus the comment for
  # why `value` opts out of the #2106 nullish→null normalization when no other
  # field does. That builder is a single emitter for one Wasm function; lifting
  # a two-line local closure out of it would obscure, not clarify. Its twin in
  # `__defineProperties` (L1197) has carried the identical signature since
  # #3991 — this change is what makes the two appliers agree.
  - src/codegen/object-runtime-descriptors.ts
func-budget-allow:
  # +10, and the same +13/+9 change-set as the LOC entries above — the two gates
  # are measuring one edit from two angles, so the rationale is the same one.
  # `compileObjectDefineProperties` is the §20.1.2.3.1 dispatcher: a
  # well-formedness pre-scan, three expansion arms, and the dynamic fallback.
  # Both additions are one-line dispatches within existing arms
  # (`staticDescriptorMapKey` in the pre-scan, `compileDescriptorMapAsDynamicObject`
  # in the fallback) whose bodies already live in `define-properties-map.ts`.
  # Splitting the dispatcher itself is real work with real ordering risk and is
  # #3399's, not this issue's.
  - src/codegen/object-ops.ts::compileObjectDefineProperties
  # +9. `buildObjectDescriptorHelpers` emits several Wasm natives in one scope
  # BECAUSE `registerNative` call ORDER fixes their function indices (its own
  # header says so). Splitting it is index-shifting surgery; the change here is
  # one default parameter on a local closure.
  - src/codegen/object-runtime-descriptors.ts::buildObjectDescriptorHelpers
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: property-descriptors
goal: standalone-gap
related: [3251, 1113, 1334, 1460, 1462, 4426]
origin: "2026-08-15 ES5-standalone session — root-cause fan-out. built-ins/Object bucket = 122 ES≤5 standalone failures; the plain-object descriptor lane is the dominant coherent slice."
---

# #4479 — plain-object descriptor attribute semantics

## Problem

`built-ins/Object` carries 122 ES≤5 standalone failures; the dominant slice
is §8.12.9/§15.2.3.6-7 semantics on PLAIN `$Object` receivers: attributes
(`writable`/`enumerable`/`configurable`) are not stored or enforced, gOPD
answers wrong shapes, `Object.create(proto, props)` ignores descriptors.
Measured signatures: `result !== true` (7), `Expected "a === 10", actually 0`
(5), `foo descriptor value should be undefined` (4), `Expected obj[0] to
equal 0, actually null` (3), plus a long tail of one-offs in
`defineProperty` (52 files), `defineProperties` (26), `create` (12),
`getOwnPropertyDescriptor`, `prototype/` rows.

**Scope boundary (load-bearing):** #3251 (in-progress, another lane) owns the
ARRAY-index overlay — `$Vec` receivers, per-index descriptor storage. This
issue is the `$Object` (and object-literal struct) receiver lane ONLY. Do not
touch `$Vec` dispatch; where a test needs both, fix the `$Object` half and
record the `$Vec` half as #3251's.

The stale issues #1113/#1334/#1460/#1462 described this lane in older terms;
this issue supersedes them (cite in their files if you close them).

## Implementation Plan

1. Re-verify live (brief: `plan/method/es5-standalone-agent-brief.md`).
   Bucket the ~90 non-array rows yourself into: (a) attribute ENFORCEMENT on
   write/delete/enumerate, (b) gOPD answer shape, (c) `Object.create` with
   props, (d) accessor descriptors (get/set installation), (e) redefinition
   validation (§8.12.9 rejections → TypeError).
2. Read the existing storage first: how `$Object` stores properties today
   (`src/codegen/array-object-proto.ts`, the `__obj_*` runtime natives, the
   #1888/#4455 accessor-install machinery — accessors on class prototypes
   ALREADY store get/set pairs; the pattern likely generalizes). Find where
   `Object.defineProperty` lowers (grep `defineProperty` under src/codegen/).
3. Design the smallest attribute store that covers (a)+(b): most tests need
   attributes REMEMBERED and ENFORCED at the `$Object` write/read/delete
   sites plus gOPD. A per-property flags side-slot on the `$Object` property
   table is the obvious shape; measure its cost on the no-descriptor fast
   path (byte-identity on modules that never call defineProperty is the
   control).
4. Slice the work: land (a)+(b) first (bulk of rows), then (c), then (e).
   (d) accessors reuse #4455's install path.
5. Acceptance floor: ≥45 of the ~90 non-array rows flip; zero regressions in
   `built-ins/Object` scoped sweep + object-literal equivalence per-file
   subset; byte-identity control on descriptor-free modules.

## Acceptance criteria

- ≥45 rows flip standalone in `built-ins/Object/{defineProperty,
  defineProperties,create,getOwnPropertyDescriptor}` excluding array-index
  files; zero regressions; residuals recorded with owners (#3251 for $Vec).

---

# Slice 1 — landed (12 rows, 0 regressions)

## The population the acceptance floor was set against does not exist at that size

**Read this before judging the 12 against the 45.** The `≥45 of the ~90
non-array rows` floor was written from the issue's estimate. Measured live over
the four named directories, standalone lane, on `0e47b7ae0`:

| | rows |
| --- | ---: |
| files swept | 2,393 |
| passing at base | **2,274** |
| failing at base | **119** |
| — of which environment-only (`JS2WASM_EVAL_ENGINE=quickjs`, provider not built in this worktree) | 28 |
| — real failures | **91** |
| — — array / `arguments`-exotic receivers (**#3251's lane, explicitly out of scope**) | 34 |
| — — **plain-object (`$Object`) lane — this issue's actual population** | **57** |

So the floor asks for 45 of **57**, i.e. **79 % of every remaining plain-object
failure** in these directories. The remaining 45 are not one lane: they include
symbol-keyed defines, the `arguments` `[[ParameterMap]]` exotic, prototype-chain
write enforcement, a DOM-dependent row, and a host-lane descriptor route. See
Residuals — each is named with an owner. The floor should be re-set against the
57, not against the 90.

## Lead decision (2026-08-15 23:45)

Accepted at +12/−0. The ≥45 floor was set against a phantom population — live
measurement says 57 real plain-object rows (28 of the 119 were
environment-only, 34 are #3251's array/arguments-exotic lane). Issue stays
`in-progress` as a re-scoped future slice (bar for the NEXT slice: ≥20 of the
~45 remaining real rows, families to be measured first); not currently
dispatched — priority goes to #4485/#4489/#4506.

## Root cause — three independent "read a descriptor through a channel that cannot see it" defects

Each one silently substituted CompletePropertyDescriptor defaults for the real
attributes. None of them was an attribute-STORAGE gap: `$PropEntry` has carried
per-property w/e/c flags and `$get`/`$set` slots since #2992, so plan step 3's
"design the smallest attribute store" turned out to be already-solved — the
defect is entirely in the read paths that feed it.

1. **The `Properties` MAP reached the native applier as a closed struct.**
   `Object.defineProperties(O, {…})`'s literal map has contextual type
   `PropertyDescriptorMap`, a concrete object type, so it compiled to a WasmGC
   struct. The native `__defineProperties` implements §20.1.2.3.1 over an
   `$Object` — it walks own keys and reads fields with
   `__desc_has_own`/`__extern_get` — and a struct carries no `$PropEntry`s, so
   every read missed. Same `$Object`-vs-struct mismatch #3253 fixed for
   `Object.create`'s per-key descriptor; the plural entry point never got it for
   the map itself.

2. **A numeric-literal key in that map was DROPPED, not declined.** The static
   expansion resolved keys with an inline `isIdentifier ? … : isStringLiteral ?
   … : undefined` and then `if (propName === undefined) continue`, so
   `Object.defineProperties(obj, {0: {value: 2}})` defined nothing and reported
   success — including where the redefine had to throw.

3. **`__obj_define_from_desc` collapsed a descriptor's `value: undefined` to
   NULL.** The #2106 `__nullish_to_null` normalization is correct for
   `writable`/`get`/… where null is the absent-convention, and wrong for
   `value`, where `undefined` is a real value. The plural applier opted out at
   #3991; the singular one never did, so a descriptor whose `value` read back
   `undefined` defined a property holding `null` and `typeof o.prop` answered
   `"object"`.

A fourth fix rides along from the predecessor's WIP, kept after measuring it:

4. **A getter stored as a carrier own-property was invoked with `this` = the
   BAG.** `__closure_prop_get` read the closure/instance-carrier bag with a
   plain `__extern_get(bag, key)`. §6.2.5.5 Get binds the ORIGINAL receiver, so
   `Object.create({}, props)` where `props` is a `Date`/`Function`/`Number`
   instance ran the descriptor getter with `this` bound to an object the program
   can never name. Routed through `__reflect_get_receiver(target, key, receiver)`
   (§28.1.5), which already saves/restores the receiver globals.

## Fix

| # | file | change |
| --- | --- | --- |
| 1 | **new** `src/codegen/define-properties-map.ts` + `object-ops.ts` | `compileDescriptorMapAsDynamicObject` builds a literal `Properties` map with `compileObjectLiteralAsExternref` under standalone. Declines on host/gc and on any map shape it cannot build without dropping an entry. |
| 2 | same module + `object-ops.ts` | `staticDescriptorMapKey` names canonical numeric keys and DECLINES the whole call for unnameable ones. |
| 3 | `object-runtime-descriptors.ts` | `getField(key, nullishToNull = true)`; `value` passes `false`, matching the plural twin at L1197. |
| 4 | `closure-props.ts` | receiver-aware bag read in `__closure_prop_get`. |

**Chosen over the obvious alternative, and this is the load-bearing design
decision:** the predecessor's WIP expanded a mixed map into per-key
`Object.defineProperty` calls. Routing to the native instead is better on three
spec-visible counts — the native is the only path implementing
ToPropertyDescriptor's conflict/callable checks; it preserves §20.1.2.3.1's
**gather-all-then-define-all** order, which a per-key expansion structurally
cannot (a throw on a later key would leave earlier keys already defined); and it
evaluates the receiver **once** rather than re-compiling the receiver expression
per key. The expansion was replaced before measurement, so no numbers here are
attributable to it.

## Test Results — every figure below is from a run executed for this issue

Scoped standalone sweep, `built-ins/Object/{defineProperty,defineProperties,
create,getOwnPropertyDescriptor}`, 2,393 files, 6 shards, real `runTest262File`:

| run | pass | fail |
| --- | ---: | ---: |
| base (`0e47b7ae0` + the WIP's files reverted) | 2,274 | 119 |
| after | **2,286** | **107** |
| delta | **+12** | **0 regressions** |

- 47 files timed out in the base sweep purely from box contention (three agents
  sweeping at once). They were **re-run at a 90 s budget** and 36 then passed;
  those results are folded into the base above, and the after-sweep produced
  **zero** timeouts. Neither number is a contention artifact.
- **The extraction to `define-properties-map.ts` happened after the after-sweep
  started, so all 119 flips-plus-failures were re-run against the FINAL tree:
  0 status differences.** The refactor is confirmed behaviour-identical rather
  than assumed to be.

**The 12 flips**

| family | rows |
| --- | --- |
| `Properties` is a builtin-instance carrier — getter `this` (fix 4) | `create/15.2.3.5-4-11`, `-4-12`, `defineProperties/15.2.3.7-2-12`, `-2-13` |
| descriptor `value` reads back undefined (fix 3) | `create/15.2.3.5-4-162`, `-163`, `-164`, `defineProperty/15.2.3.6-3-136`, `-137` |
| numeric key in the map (fix 2) | `defineProperties/15.2.3.7-6-a-93-2`, `-93-4` |
| map reached the applier as a struct (fix 1) | `defineProperties/15.2.3.7-6-a-42` |

**Pins** — `tests/issue-4479.test.ts`, 16 tests, all green. 8 standalone
assertions cover each fixed family plus three don't-break-this controls
(all-literal map, mixed literal+variable map, real value through the dynamic
applier). The 3 host-lane counterparts are `it.fails` with the residual named.

**Equivalence** — per-file loop (the suite OOMs in one invocation), 12 files
plausibly touched by the diff, all green: `object-define-property`,
`-accessors`, `-extended`, `-return`, `define-property-typeerror`,
`object-create`, `object-literal-getters-setters`, `object-keys`,
`object-mutability`, `hasownproperty-call`, `empty-object-widening`,
`numeric-key-object`.

**Byte-identity control — the acceptance criteria asked for this and the answer
is NOT the clean one.** Three descriptor-free modules (no closures / closures +
function-object property reads / constructor-prototype), compiled base vs after
by swapping the source files:

- **host lane: byte-identical in all three.** The map materialization is
  `ctx.standalone`-gated and `__obj_define_from_desc` is the standalone applier,
  so host codegen is untouched — confirmed, not assumed.
- **standalone lane: all three DIFFER**, and bisecting one change at a time
  shows **both** fix 3 and fix 4 perturb even the no-closure, no-descriptor
  module on their own. Neither touches user codegen; both edit the body of a
  native that the standalone object runtime registers **unconditionally**
  (`__obj_define_from_desc` loses one `call __nullish_to_null`;
  `__closure_prop_get` gains the receiver-aware read). A descriptor-free
  standalone module therefore cannot be byte-identical while these fixes live
  inside always-registered natives — the control's premise does not hold for
  this shape of fix. Flagged rather than quietly dropped.

## Residuals — 45 plain-object rows, with owners

Measured after the fix; array/`arguments`-exotic rows (44) are excluded as
#3251's lane.

| rows | signature | owner / next step |
| ---: | --- | --- |
| 4 | `descriptor value should be undefined` — `{value: null}` read back as undefined (`defineProperties/15.2.3.7-6-a-43`, `-74`, `defineProperty/15.2.3.6-4-62`, `-84`) | **#2106 null-vs-undefined boundary**, not descriptors: `propertyHelper`'s own read of the EXPECTED descriptor's `null` yields undefined. Needs the singleton regime, not a descriptor change. |
| 4 | prototype-chain non-writable write enforcement (`15.2.3.6-4-415`, `-581`, `-586`, `-591`) | **bucket (a), next slice.** §9.1.9 OrdinarySetWithOwnDescriptor must consult the PROTOTYPE's `[[Writable]]`. Touches every `$Object` write — deserves its own measured cycle. |
| 4 | accessor `get: undefined` redefine (`15.2.3.6-4-498`, `-516`, `-534`, `-552`) | **#2992 accessor-merge**, adjacent lane. |
| 4 | symbol-keyed defines (`symbol-data-property-*`) | symbol-key lane, unrelated to attributes. |
| 2 | `Object.getPrototypeOf(d)` — "called value is not a function" (`create/15.2.3.5-3-1`, `-4-1`) | pre-existing infrastructure, not descriptors. |
| 3 | host-lane descriptor-in-a-variable loses value/writable/enumerable | **#2668 Slice A's `emitDefinePropertyDescRuntime` scope comment declines non-literal descriptors by design.** Pinned `it.fails` in `tests/issue-4479.test.ts`; measured identical before and after, so not a regression. |
| 1 | `Properties` is an `arguments` object → `[SITE-PROPS-BAG-NOT-AUTHORITATIVE]` refusal (`proxy-no-ownkeys-returned-keys-order`) | #4161 carrier-bag lane — `arguments` is neither `$Object`, closure carrier, nor vec. |
| 1 | `S15.2.3.6_A1` — `document.createElement` | DOM, will not pass. |
| 1 | `15.2.3.6-4-625gs` — global `this.prop` precedence | global-object lane. |
| 21 | long tail of one-offs (`15.2.3.6-3-123`, `-4-21`, `-59`, `-408`, `-410`, `-570`, `-584`, `-589`, `-622`, `create/15.2.3.5-4-263`, `defineProperties/15.2.3.7-5-b-8`, `property-description-must-be-an-object-not-symbol`, `gOPD/15.2.3.3-4-116`, `defineProperty/15.2.3.6-3-138`, …) | no single dominant cause; needs per-row triage. |
| 28 | `JS2WASM_EVAL_ENGINE=quickjs` provider not built | **environment, not the compiler.** Constant across base and after; the default engine is `quickjs` and the artifact is absent in an agent worktree. Build it (`node scripts/build-quickjs-eval-provider.mjs`) or sweep with `JS2WASM_EVAL_ENGINE=interpreter` to see these rows at all. |
