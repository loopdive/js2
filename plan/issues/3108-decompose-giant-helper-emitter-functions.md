---
id: 3108
title: "Decompose the ensureObjectRuntime entangled property-storage core (3,494 LOC) into cohesive sibling modules"
status: ready
fable_role: spec
sprint: current
model: opus
created: 2026-07-09
updated: 2026-07-17
priority: medium
horizon: l
feasibility: medium
reasoning_effort: high
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: maintainability
related: [3104, 3105, 3114, 3182, 3274, 3282]
---

# #3108 — Decompose the `ensureObjectRuntime` entangled core

**Source:** 2026-07-09 compiler consolidation audit (fable-refactor,
`plan/log/compiler-consolidation-plan.md`). **Re-scoped 2026-07-17** (architect
spec pass) after the #3182 god-function wave consumed most of the original
targets.

## Scope re-cut (READ FIRST — most of the original issue already landed)

When this issue was filed it named five monoliths. Four are now done or owned
elsewhere; **the only residue is the `ensureObjectRuntime` entangled core.**
Measured on `origin/main` @ 2026-07-17:

| Original target             | Filed size | Now               | Status                                                           |
| --------------------------- | ---------- | ----------------- | ---------------------------------------------------------------- |
| `ensureObjectRuntime`       | 6,960      | **3,494 (core)**  | **THIS ISSUE** — #3274 lifted proto/enum/descriptors; core defer |
| `ensureNativeStringHelpers` | 4,851      | 47 (orchestrator) | **DONE** — #3275 + #3277 (do not touch)                          |
| `ensureProxyRuntime`        | 1,273      | own file          | **DONE** — `object-runtime-proxy.ts` (do not touch)              |
| `ensureAnyHelpers`          | 1,815      | 1,532             | **OWNED BY #3282** (in-progress, `opus-1`) — do not touch        |
| `ensureRegexRun`            | 1,098      | 1,087             | out of scope — already under the 1,500 acceptance ceiling        |

`#3274` (done) already extracted the prototype-chain, enumeration, and
descriptor concerns into `object-runtime-prototype.ts`,
`object-runtime-enumeration.ts`, `object-runtime-descriptors.ts` and deferred
the remaining property-storage core with an explicit note: _"the remaining
object-runtime core … is NOT a clean byte-identical lift — it defines
cross-cutting closures. It warrants a dedicated architect pass; keep it a
separate slice … (or its own issue)."_ #3282 repeats that deferral. **This
issue is that separate issue / architect pass.**

**Coordination guard:** do NOT re-spec or touch native-strings, proxy, or
`ensureAnyHelpers`. `ensureAnyHelpers` is actively being decomposed by #3282
(`assignee: opus-1`); overlapping it will collide. This issue touches
**`src/codegen/object-runtime.ts` only** (plus the new sibling files it
creates and `scripts/emit-identity-corpus/`).

## The residual target: `ensureObjectRuntime` (src/codegen/object-runtime.ts)

- Function `ensureObjectRuntime(ctx)` — **line 325 → 3819 (3,494 LOC)**, the
  #1 codegen function over the 1,500 ceiling that is not already owned.
- It is the property-storage engine for the standalone/wasi native `$Object`:
  the open-object hash map, key coercion, get/set/has/delete, insertion
  ordering, primitive wrappers, ToPrimitive/ToString.

### Why it's "entangled" (and why it's still byte-identity-provable)

Two coupling mechanisms, and the key finding that makes extraction tractable:

1. **Shared emit closures** defined mid-body and captured by many sections:
   - `registerNative` (line **580**) — `(name, params, results, locals, body) →
funcIdx`; mints a DEFINED func (`mintDefinedFunc` + `addFuncType` +
     `funcMap.set` + `pushDefinedFunc`). No import, so **no index shift**.
   - `withKeyCoercion` (line **779**)
   - `emitClassifyKey` (line **978**)
   - `emitKeyMatch` (line **1025**)
   - `emitWrapperBuildTail` (line **1565**) — wrappers-only
   - `emitHasOwn` (line **2367**) — has-family-only
     These are the "cross-cutting closures" #3274 flagged. They must travel in an
     explicit context bag so extracted sections can receive them.

2. **Cross-helper funcIdx references are BY NAME, not captured consts** — the
   load-bearing finding. 28 of ~30 cross-references are
   `ctx.funcMap.get("__name")!` resolved _just before use_ (e.g. line 1170
   `objFindIdx = ctx.funcMap.get("__obj_find")!`, line 1544 `objInsertIdx`,
   line 1773 `objGrowIdx`, line 3630 `externSetIdx`). The only captured consts
   are `strFlattenIdx`/`strEqualsIdx` (from `ctx.nativeStrHelpers`, available
   before the core) and section-local captures (`isNullishIdx`, `externSetIdx`
   inside their own block). **Because references resolve by name, byte-identity
   holds automatically as long as the extracted section functions are CALLED
   in the same order** — the names are registered before they are looked up,
   and each name resolves to the identical funcIdx.

This is exactly the proven pattern already used twice in this file tree:
`makeNativeStrShared` + `emitStr*(shared)` builders (native-strings) and
`buildObjectEnumerationHelpers(ctx, s)` / `buildObjectDescriptorHelpers(ctx, s)`
(#3274, called at lines 3608 / 3631). Follow that convention verbatim.

## Implementation Plan

### Design: one shared context bag, order-preserving orchestrator

Introduce `ObjectCoreShared` — the explicit parameter object the issue's
original `ObjectRuntimeEmit` sketch called for. It carries everything the
extracted sections need so the implicit closure-capture graph becomes visible
and greppable:

```ts
// src/codegen/object-runtime-core-shared.ts  (NEW)
export interface ObjectCoreShared {
  ctx: CodegenContext;
  types: ObjectRuntimeTypes;               // propEntry/propMap/object/objVec/... idxs
  // common ValTypes (built once, verbatim from lines 570-577):
  objRef; objRefNull; propMapRef; entryRefNull; anyStrRef; nativeStrRef;
  objVecRef; objVecArrRef;
  // scalar type idxs the bodies bake:
  anyStrTypeIdx; nativeStrTypeIdx; strDataTypeIdx; symbolTypeIdx;
  symbolKeysEnabled; objArrayLikeArms;
  // captured native-string funcIdxs (available before the core):
  strFlattenIdx; strEqualsIdx;
  // reserved builtin-fn-meta funcIdxs (standalone-only, may be undefined):
  bfnGetMetaIdx; bfnGopdIdx; bfnDeleteIdx; bfnPushOwnNamesIdx;
  // the flag constants the bodies reference (FLAG_*, OBJ_FLAG_*, WRAPPER_*, NONE_HEAP):
  ... ;
  // the shared emit closures:
  registerNative(name, params, results, locals, body): number;
  withKeyCoercion(keyParamIdx, body): Instr[];
  emitClassifyKey(...): Instr[];
  emitKeyMatch(entryLocal, isSymLocal, symIdLocal, fkeyLocal): Instr[];
}
export function makeObjectCoreShared(ctx, types, ...preambleValues): ObjectCoreShared;
```

`ensureObjectRuntime` stays in `object-runtime.ts` as the **orchestrator**: the
dependency preamble (lines 325–592: `flushLateImportShifts`,
`ensureNativeStringHelpers`, the standalone `emitNativeNumberFormat` /
`emitNativeParseNumber` / `addUnionImportsViaRegistry`, `ensureSymbolCarrier`,
the three struct/array type registrations, the `types` bag, the common
ValTypes) → `const s = makeObjectCoreShared(...)` → an **ordered list of
`build*(s)` calls in the exact current emission order** → the two existing
`buildObjectEnumerationHelpers` / `buildObjectDescriptorHelpers` calls
(unchanged) → the `__extern_is_undefined` / `__extern_method_call` /
`ensureProxyRuntime` tail → `return types`.

**Order-preservation is the whole ballgame.** File membership does NOT affect
emitted bytes — only the orchestrator's _call sequence_ does. So a sibling file
may define several `build*` functions that the orchestrator calls
non-consecutively; that is fine and is how #3274 already works.

### Target module map (grouping DEFINITIONS by concern; orchestrator keeps order)

New files under `src/codegen/`, mirroring the existing `object-runtime-*.ts`
naming (flat siblings, not a subdirectory — matches
`object-runtime-descriptors.ts` etc.):

| New file                        | `build*` fn(s)                              | Sections (emission order, current lines)                                                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `object-runtime-core-shared.ts` | `makeObjectCoreShared` + `ObjectCoreShared` | shared closures `withKeyCoercion` (779) / `emitClassifyKey` (978) / `emitKeyMatch` (1025) + common ValTypes/idxs/flags                                                                                                                                               |
| `object-runtime-keys.ts`        | `buildObjectKeyHelpers`                     | `__extern_is_array` (594), builtin-fn meta reserved natives (613), `__to_property_key` (691), `$__obj_hash` (789), `__key_equals` (902)                                                                                                                              |
| `object-runtime-store.ts`       | `buildObjectStoreHelpers`†                  | `__new_plain_object` (1047), `$__obj_find` (1066), `$__obj_insert` (1383), `$__obj_grow` (1659), `__objvec_new` (2224), `__objvec_push` (2238)                                                                                                                       |
| `object-runtime-access.ts`      | `buildObjectAccessHelpers`†                 | `__extern_get` (1172), `__extern_set` (1775), `__reflect_set` (1947), `__delete_property` (2078), `__hasOwnProperty`/`__object_hasOwn` (2359), `__propertyIsEnumerable` (2416), `__extern_has` (2471), `__extern_is_undefined` (3666), `__extern_method_call` (3742) |
| `object-runtime-wrappers.ts`    | `buildObjectWrapperHelpers`                 | Boxed primitive wrappers (1546) + `emitWrapperBuildTail` (1565)                                                                                                                                                                                                      |
| `object-runtime-toprimitive.ts` | `buildObjectToPrimitiveHelpers`             | `__to_primitive` + `__extern_toString` (2548)                                                                                                                                                                                                                        |
| `object-runtime-ordering.ts`    | `buildObjectOrderingHelpers`                | `__obj_index_of_key` (2921), `__obj_ordered`/`_all`/`_symbols` (3071)                                                                                                                                                                                                |

† **store and access interleave in emission order** (get sits between find and
insert; wrappers between insert and grow; set/reflect/delete between grow and
objvec). Do NOT reorder to make them contiguous. Two options — pick per the
constraint below:

- **Preferred:** each SECTION is its own exported `build*` function; the
  orchestrator calls them individually at their exact original positions. A
  file just groups the related section-functions. This keeps every slice
  trivially order-identical.
- Only merge sections into a single `build*` call when they are already
  **adjacent** in emission order (e.g. `__objvec_new` + `__objvec_push`;
  `__obj_index_of_key` + `__obj_ordered*`).

### Ordering / dependency constraints (do these first)

1. **`makeObjectCoreShared` must land before any section extraction** (it
   supplies `registerNative` + the key-ops closures every section needs).
2. **Preamble stays put.** Everything at lines 325–592 (import-shifting calls
   `flushLateImportShifts`, the standalone `addUnionImportsViaRegistry` at 358,
   `ensureSymbolCarrier`, and the three `ctx.mod.types.push` type
   registrations) must remain in the orchestrator, in place. Moving a type
   `push` or an import call changes every subsequent type/func index → global
   hash break.
3. **Index-shift anchors inside the core (CRITICAL).** Three idempotent
   `addUnionImportsViaRegistry(ctx)` calls live INSIDE core sections:
   - line **1595** (`__new_Number` — needs `__box_number`) — wrappers
   - line **1632** (`__new_Boolean` — needs `__box_boolean`) — wrappers
   - line **2562** (`__extern_toString` default — needs `__extern_get`/`_has`) — toprimitive
     Each adds union imports and shifts every funcIdx assigned after it. When the
     section is extracted, this call must travel _with its body_ and fire at the
     identical orchestrator position. `prove-emit-identity` catches any drift, but
     flag these three lines in the PR description so review knows they are
     position-sensitive. (`registerNative` itself mints only DEFINED funcs — no
     shift — so ordinary section extraction is shift-free; these three are the
     only exceptions.)
4. **`ObjectRuntimeTypes` and `ctx.objectRuntimeTypes = types` assignment stay
   in the orchestrator** (line 567) so the memoization guard at line 326 is
   untouched.

### Slice decomposition (each slice = one PR, mechanical, byte-identity gated)

Every slice: `prove-emit-identity check` must print **IDENTICAL** (full matrix)
and `tsc --noEmit` must be 0. Emit-identity **holds for every slice** here —
the finding above (name-based cross-refs + defined-func registration + preserved
call order) means there is no un-provable step, unlike the pessimistic #3274
note. Stack each slice on the previous branch; do not idle-wait for merges.

- **Slice 0 — corpus + baseline.** The default corpus
  (`website/playground/examples` + `scripts/emit-identity-corpus/`, currently 1
  file) does not force object-runtime emission. Add ~15–20 tiny `.ts` probes to
  **`scripts/emit-identity-corpus/`** (the existing extra root the tool already
  walks and that compiles under the `linear`/`standalone` targets — NOT
  `tests/standalone-corpus`, which the tool does not read) that exercise every
  core helper in standalone mode: `Object.keys/values/entries/assign`,
  `Object.freeze/seal/isFrozen`, `Object.defineProperty` /
  `getOwnPropertyDescriptor`, computed + symbol keys (`o[sym]=v`), `delete o.k`,
  `o.hasOwnProperty(k)`, `propertyIsEnumerable`, `k in o`, `for..in` order,
  array-like `{length, 0:…}` reads, primitive wrappers (`new Number/String/
Boolean`), `Object.fromEntries`, `String(obj)` / `` `${obj}` `` (ToPrimitive),
  `JSON.stringify` key order, and a `new Proxy` get/set/has. Then
  `node scripts/prove-emit-identity.mjs baseline`. No source change → baseline is
  the pre-refactor golden. Commit corpus + baseline together.
- **Slice 1 — `object-runtime-core-shared.ts`.** Create the file; move
  `withKeyCoercion` / `emitClassifyKey` / `emitKeyMatch` and the common
  ValTypes into `makeObjectCoreShared`; construct `s` in the orchestrator; leave
  all sections inline but reading from `s`. Closures don't emit until called, so
  identical. (`registerNative` may stay a local const passed into `s`, or be
  built inside the bag — either is byte-neutral.)
- **Slice 2 — `object-runtime-keys.ts`** (`buildObjectKeyHelpers`): sections at
  594/613/691/789/902 (contiguous, one call at line 594's position).
- **Slice 3 — `object-runtime-store.ts`**: `__new_plain_object` (1047),
  `$__obj_find` (1066) — the pre-get storage prims.
- **Slice 4 — `object-runtime-access.ts`**: `__extern_get` (1172).
- **Slice 5 — store**: `$__obj_insert` (1383).
- **Slice 6 — `object-runtime-wrappers.ts`**: primitive wrappers (1546) +
  `emitWrapperBuildTail` — carries the 1595/1632 addUnion anchors.
- **Slice 7 — store**: `$__obj_grow` (1659).
- **Slice 8 — access**: `__extern_set` (1775), `__reflect_set` (1947),
  `__delete_property` (2078) — three adjacent calls.
- **Slice 9 — store**: `__objvec_new` (2224) + `__objvec_push` (2238) (adjacent).
- **Slice 10 — access**: `__hasOwnProperty`/`__object_hasOwn` (2359),
  `__propertyIsEnumerable` (2416), `__extern_has` (2471) (adjacent).
- **Slice 11 — `object-runtime-toprimitive.ts`**: `__to_primitive` +
  `__extern_toString` (2548) — carries the 2562 addUnion anchor.
- **Slice 12 — `object-runtime-ordering.ts`**: `__obj_index_of_key` (2921),
  `__obj_ordered`/`_all`/`_symbols` (3071) (adjacent, ~685 LOC — the biggest
  single lift).
- **Slice 13 — access tail**: `__extern_is_undefined` (3666),
  `__extern_method_call` (3742) — the post-enumeration/descriptor tail, before
  `ensureProxyRuntime`.

Slices 3–5, 7, 9 (store) and 4, 8, 10, 13 (access) can be **collapsed into two
larger PRs** (one all-store, one all-access) once the pattern is proven on the
first pair, since each section is an independent `build*` call at its own
position — the emit-identity gate makes a bigger diff safe. Recommend keeping
slice 2 (keys) and slice 1 (shared bag) as their own PRs regardless, since they
establish the bag contract every later slice depends on. Net: **~8–13 commits.**

### Test plan

1. **Per slice (required gate):**
   `node scripts/prove-emit-identity.mjs check` → **IDENTICAL** across the full
   gc/standalone/wasi matrix (with the slice-0 extended corpus). Any accidental
   reorder or a mis-placed addUnion anchor fails the hash immediately — this is
   the whole safety story.
2. **Per slice:** `tsc --noEmit` 0; biome/prettier/loc-budget clean. Extraction
   to sibling modules SHRINKS `object-runtime.ts`, so the LOC-regrowth ratchet
   stays green with no allowance (as #3274/#3282 slices confirmed).
3. **Scoped equivalence:** `npm test -- tests/equivalence.test.ts` plus any
   object/property-focused suites (`tests/issue-*object*`, `*defineProperty*`,
   `*proxy*`) for behavioural confidence — expected untouched since bytes are
   identical.
4. **CI:** full test262, standalone shard especially. Byte-identity ⇒ zero
   conformance delta expected.
5. **#2093 smoke test** per slice (the same per-issue smoke #3274/#3282 ran).

### Regression risks

- **Reordering a section call** (esp. store↔access interleave) → funcIdx shift
  → cascade hash break. Mitigation: extract one section at a time to its exact
  position; the emit-identity gate is the backstop.
- **Moving a preamble type `push` or import call** → global type/func index
  shift. Mitigation: preamble is explicitly frozen in the orchestrator (constraint 2).
- **Dropping/relocating one of the three in-core `addUnionImportsViaRegistry`
  anchors** (1595/1632/2562) → import-count shift baked into wrong funcIdxs.
  Mitigation: the call travels inside its section body; flag in PR.
- **Standalone-vs-gc gating.** Several sections are `if (ctx.standalone)` /
  `symbolKeysEnabled` guarded (builtin-fn meta, symbol key arms, array-like
  arms). Preserve the guards verbatim inside the extracted functions — the
  matrix corpus must include both a standalone probe AND a gc/host probe so the
  gate proves both branches. (gc/host mode uses host `__extern_*` imports and
  skips most core arms — the corpus already covers this via the default
  playground examples which compile gc.)
- **ESM import cycle.** `any-helpers.ts` ↔ new siblings could form a runtime
  cycle like the `undefinedSingletonActive` one #3282 noted; keep cross-imports
  to type-only (`import type`) plus function decls (hoisted, cycle-safe).

## Acceptance criteria (unchanged intent, narrowed scope)

1. `prove-emit-identity check` IDENTICAL per extraction commit (extended corpus).
2. `ensureObjectRuntime` core reduced to an orchestrator ≤ ~600 LOC; no single
   object-runtime emitter function > 1,500 LOC afterwards.
3. Emit-order documented: the orchestrator body reads as an ordered `build*(s)`
   call list.
4. No test262 regression (standalone shard especially).
5. Scope respected: native-strings / proxy / `ensureAnyHelpers` (#3282)
   untouched.

## History (superseded framing)

The original spec targeted five monoliths and proposed an `object-runtime/`
subdirectory. Four targets landed via the #3182 wave (#3274 object-runtime
proto/enum/descriptors; #3275/#3277 native-strings; proxy already split) or are
owned by #3282 (`ensureAnyHelpers`). The subdirectory idea is dropped in favor
of the flat `object-runtime-*.ts` sibling convention #3274 established. Only the
entangled property-storage core remains, specced above.
