---
id: 1591
title: "class/elements: WasmGC-struct ↔ host own-property/identity reconciliation gaps (~294 fails)"
status: done
created: 2026-05-24
updated: 2026-06-11
depends_on: [1472]
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes, class-elements
goal: spec-completeness
sprint: 61
renumbered_from: 779b
parent: 779
test262_fail: 294
test262_category: language/statements/class/elements, language/expressions/class/elements
claimed_by: codex-developer
claimed_at: 2026-06-07T10:02:42.699Z
pr: 1278
completed: 2026-06-09
---
# #1591 — `class/elements` WasmGC-struct ↔ host own-property / method-identity reconciliation gaps

> **MIS-SCOPE CORRECTION (2026-05-27).** The original framing of this issue —
> "same-line / stacked member definitions are *dropped or reordered* by the
> parser / class-body emitter" — is **wrong**. A dev investigation confirmed the
> parser preserves all members in source order, and the class-body emitter does
> not drop or reorder anything. The `after-same-line` / `new-sc-line` /
> `wrapped-in-sc` / `multiple-stacked-definitions` / `multiple-definitions-rs`
> filename prefixes are just the **test262 generator's layout permutations** of
> the *same* member sets; the layout is irrelevant to why they fail. **All 294
> failures are runtime-semantics gaps** in how a WasmGC struct instance is
> reconciled with the host's prototype / own-property model. The sections below
> are rewritten to describe the real problem.

## Evidence: refreshed standalone test262 artifact 2026-06-02

Source: `loopdive/js2wasm-baselines` commit
`b4684d8f97a462c6414716aea46f31b67f48b959`,
`test262-standalone-current.jsonl`; js2 baseline
`ac88301967d70be11c9abb456051ff4afcd3a9d7`.

The standalone root-cause classifier assigns **1,660** rows primarily to the
class elements / prototype / private-name reconciliation family: 1,649
`fail` rows and 11 `compile_error` rows. The standalone evidence is broader
than the older 294-row `class/elements` host-mode count because it includes
both `language/statements/class/elements` and
`language/expressions/class/elements` permutations plus class-subsystem
failures exposed after earlier standalone gates.

The failure modes still match the corrected scope in this issue:

- own-property and descriptor checks on WasmGC-backed instances/prototypes
- stable method identity and prototype method visibility
- private method/accessor and static private brand behavior
- computed, symbol, and string-literal member descriptors

Keep this issue blocked on the representation/design decision, but treat it as
a high-volume standalone conformance owner when planning pass-rate work.

## Problem

A class instance compiles to a **WasmGC struct** (`struct (field $x f64) ...`),
not a host JS object. Methods are funcref struct slots / module functions, not
JS `Function` objects living on a real prototype. Instance fields are struct
slots, not host own data properties. To satisfy `verifyProperty`,
`hasOwnProperty`, `Object.getOwnPropertyDescriptor`, and `===` identity checks,
the runtime (`src/runtime.ts`) maintains a **reconciliation layer** of sidecar
maps that *present* the struct as if it were a spec-compliant host object:

| Map / helper | Purpose |
|--------------|---------|
| `__struct_field_names` export | instance field name set (per struct type) |
| `_prototypeMethodNames` (`__register_prototype`) | allowlist of prototype method names |
| `_wasmStructProps` | sidecar own data properties (set after construction) |
| `_wasmPropDescs` | per-property descriptor flags (enum/config/writable) |
| `_wasmStructAccessors` | get/set accessor functions per key |
| `_wasmStructDeletedKeys` | delete tombstones (§10.1.10) |

The 294 failures are the **gaps in this reconciliation layer** — cases the
sidecar machinery does not yet cover. They split into five sub-clusters:

### Cluster A — instance-field own-property visibility (largest)
`hasOwnProperty(c, "foo")` returns **false** even though `c.foo` *reads*
correctly, and `verifyProperty(c, "foo", {...})` reports the wrong descriptor
(or "not own"). Instance fields are WasmGC struct slots; they are *readable*
via the `__sget_*` getters and *are* listed in `__struct_field_names`, but a
freshly-constructed instance has **no entry in `_wasmStructProps` /
`_wasmPropDescs`**, so:
- `__getOwnPropertyDescriptor` finds no descriptor and returns `undefined`
  (instead of `{writable:true, enumerable:true, configurable:true}` per
  §10.2.x class field semantics), and/or
- enumeration order and descriptor flags don't match the spec.

The struct-field-name fallback in `__hasOwnProperty` (runtime.ts ~5320) papers
over the *presence* check for *some* cases but not the *descriptor* shape that
`verifyProperty` demands, and it is bypassed entirely once the object has been
registered as a class prototype (the `_prototypeMethodNames` branch returns
early, ~5316).

```
multiple-stacked-definitions-rs-field-identifier-initializer.js
  returned 4 — assert(!Object.prototype.hasOwnProperty.call(C, "field"))
  → instance-field own-property descriptor fidelity
```

### Cluster B — method-object identity on the prototype
`c.m === C.prototype.m` fails. Each member access re-derives a *fresh* host
wrapper around the funcref (or returns a different boxed value), so the two
reads are not the same JS object. The spec requires a class method to be a
**single** `Function` object installed once on `C.prototype`, shared by every
`c.m` lookup through the prototype chain.

```
after-same-line-method-computed-symbol-names.js
  verifyProperty(C.prototype, "m", { enumerable:false, configurable:true, writable:true })
  → method present on prototype with stable identity + correct descriptor
```

### Cluster C — private methods / private accessors
`#method`, `get #x()`, `set #x(v)`. Private names are not own properties at all
(they must be **invisible** to `hasOwnProperty` / `getOwnPropertyNames` and to
`verifyProperty`), but must be callable from inside the class and produce a
`TypeError` on a brand-check failure from outside. The current path leaks them
into the struct-field-name set or fails the brand check.

```
new-sc-line-gen-rs-private-setter-alt.js
  returned 5 — verifyProperty(C.prototype, "method", ...)
```

### Cluster D — static private fields / methods
`static #x`, `static #m()`. Same private-name mechanism as Cluster C but keyed
on the **class object** (the constructor) rather than the instance. Brand check
is against `C` itself.

```
multiple-definitions-rs-static-privatename-identifier-initializer-alt.js
  returned 10 — assert.sameValue(c.foo, "foobar")
```

### Cluster E — computed / symbol / string-literal member names with verifyProperty
Computed keys (`[expr]`), `Symbol.*` keys, and string-literal keys must land in
the *same* sidecar maps as identifier keys, with correct descriptors. Symbol
keys in particular bypass `_wasmStructProps` (template-literal CSV can't
stringify a Symbol) and need `_wasmStructAccessors`-style handling.

## Decomposition

This is too large for one fix. Split into sub-issues (rough effort = dev-days):

| Sub | Cluster | Title | Effort | Mechanism |
|-----|---------|-------|--------|-----------|
| 1591a | A | Instance-field materialization as host own properties | M (2-3d) | At end of every class constructor, emit one `Object.defineProperty`-equivalent (`__defineProperty_data` / direct `_wasmStructProps` + `_wasmPropDescs` seed) per declared instance field with `{writable, enumerable, configurable: true}` |
| 1591b | B | Method-object identity on the prototype | M (2-3d) | Install each method as a single host `Function` on the registered prototype object at module init; route `c.m` lookups through that prototype so identity is stable |
| 1591c | C | Private instance methods / accessors | L (3-5d) | Separate private-name brand mechanism (WeakSet/WeakMap brand per class); never enters `_wasmStructProps` or `__struct_field_names`; throw TypeError on brand mismatch |
| 1591d | D | Static private fields / methods | M (2-3d) | Same private-name brand mechanism as 1591c, keyed on the class object; depends on 1591c landing first |
| 1591e | E | Computed / Symbol / string-literal member names | S-M (1-2d) | Funnel computed/symbol keys into the same descriptor sidecars as 1591a/b; Symbol keys via `_wasmStructAccessors` not CSV |

Recommended order: **1591a → 1591b → 1591e → 1591c → 1591d**. A and B together
should clear the bulk of the `field-*` and `method-*` permutations; C/D unblock
the `private*` permutations.

## Implementation Plan

### Root cause
A WasmGC class instance is a struct, not a host object. The runtime's sidecar
reconciliation layer (`_wasmStructProps`, `_wasmPropDescs`, `_prototypeMethodNames`,
`__struct_field_names`) presents a *partial* host view: it covers presence in
some paths but not full descriptor fidelity, not stable method identity, and not
the private-name brand model. `verifyProperty` exercises exactly these gaps.

### 1591a — Instance-field own-property materialization (Cluster A)

**File: `src/codegen/literals.ts`** (class body / instance construction) and
**`src/codegen/index.ts`** (class compilation entry, constructor emission).

- Find where the constructor body finishes initializing struct field slots
  (the per-field `struct.set` / initializer loop in the class-element pipeline).
- After the last field initializer, for **each declared instance field**, emit a
  call that seeds the host descriptor sidecars for `this`. Reuse the existing
  data-property path rather than inventing a new host import:
  - emit `__defineProperty_data(this_extern, "name", value_extern, flags)` where
    `flags = writable|enumerable|configurable` (all true for class fields), OR
  - if a dedicated data-define import does not exist, add one mirroring
    `__defineProperty_accessor` (runtime.ts ~292, ~700) that writes both
    `_wasmStructProps[obj][name] = value` and
    `_wasmPropDescs[obj].set(name, flags)`.
- Standalone mode (`ctx.standalone`): skip the host call (no JS host); the struct
  slot already holds the value and `__hasOwnProperty`'s `__struct_field_names`
  fallback covers presence. Gate exactly like the `__register_prototype` block
  in index.ts ~802.

**File: `src/runtime.ts`**
- In `__getOwnPropertyDescriptor` (~3629) and `__hasOwnProperty` (~5293): when an
  instance is *also* a registered class prototype receiver, do **not** early-return
  on the `_prototypeMethodNames` branch for keys that are seeded instance-field
  descriptors. Check `_wasmStructProps` / `_wasmPropDescs` *before* the
  prototype-method allowlist for own-data keys.

**Edge cases**
- Field initializer is `undefined` → still an own property (present, value `undefined`).
- Field declared but shadowed by a same-name accessor → accessor wins (Cluster E).
- Subclass field added in derived constructor after `super()` → seed after super-init.

### 1591b — Method-object identity on the prototype (Cluster B)

**File: `src/runtime.ts`** — `__register_prototype` handler (~3624 sets
`_prototypeMethodNames`). Extend the registration so the host prototype object
stores the **actual `Function` wrapper** per method (a `Map<name, Function>`),
created **once**. `_wrapForHost` / the prototype getter must return that *same*
function on every `c.m` and `C.prototype.m` read.

**File: `src/codegen/index.ts`** / `src/codegen/closures.ts` — `emitLazyProtoGet`
path. Ensure the lazy prototype init registers method wrappers (funcref → host
`Function`) into the prototype's method map at first access and caches them, so
`emitLazyProtoGet` returns the cached identity rather than re-boxing.

**Wasm/runtime pattern**
```
// __register_prototype(protoExtern, methodsArrayExtern):
//   for each (name, funcref-wrapper) -> protoMethodFns.set(name, hostFn)
//   _prototypeMethodNames.set(proto, [...names])
// prototype get trap / __extern_get on proto:
//   if protoMethodFns.has(key) return protoMethodFns.get(key)   // STABLE identity
```

**Edge cases**
- Method descriptor must be `{writable:true, enumerable:false, configurable:true}`
  (non-enumerable!) — distinct from fields (1591a). Seed `_wasmPropDescs` on the
  *prototype* with `enumerable:false`.
- Generator / async methods: same identity rule, different wrapper kind.
- `constructor` is not enumerated as a normal method.

### 1591e — Computed / Symbol / string-literal names (Cluster E)

**File: `src/codegen/literals.ts`** — class-element name resolution. Computed
names already resolved to a constant must funnel into the *same* define-property
emission as 1591a/1591b. For **Symbol** keys, route through `_wasmStructAccessors`
/ a symbol-keyed descriptor map (runtime.ts ~368 notes Symbols can't go through
the CSV field-name path).

**Edge cases**
- Computed key that is a non-constant expression → evaluate once, define with the
  resulting key (don't re-evaluate per access).
- `Symbol.iterator` / well-known symbols already have bespoke handling
  (runtime.ts ~166) — don't double-register.

### 1591c — Private instance methods / accessors (Cluster C)

**New mechanism — do NOT reuse the own-property sidecars.** Private names are
*not* properties.

**File: `src/runtime.ts`** — add a per-class **brand WeakSet** and a
`Map<privateName, Function>` for private methods/accessors. Construction adds the
instance to the brand set; a `#m()` call brand-checks the receiver (`TypeError`
if absent).

**File: `src/codegen/literals.ts` / `index.ts`** — private members must be
**excluded** from `__struct_field_names` (already partially handled: names
starting with `$`/`__` are filtered at index.ts ~1395 — confirm `#`-mangled
names are filtered too) and from any prototype method allowlist.

**Edge cases**
- `#x in obj` (private-in expression) → brand check, returns boolean, never throws.
- Private accessor with only a getter → set throws TypeError.
- Brand check must run **before** any field access (spec ordering).

### 1591d — Static private fields / methods (Cluster D)

Same brand mechanism as 1591c but the brand set contains exactly the class
object, and private statics live keyed on the constructor. **Depends on 1591c.**

### Test files to verify
- `language/statements/class/elements/multiple-stacked-definitions-rs-field-identifier-initializer.js` (A)
- `language/statements/class/elements/after-same-line-method-computed-symbol-names.js` (B, E)
- `language/statements/class/elements/new-sc-line-gen-rs-private-setter-alt.js` (C)
- `language/statements/class/elements/multiple-definitions-rs-static-privatename-identifier-initializer-alt.js` (D)

## Acceptance criteria

- The `class/elements/*` permutation groups pass once their underlying cluster is
  fixed — **not** as one atomic change. Track per-sub-issue: A+B clear the
  `field-*` / `method-*` permutations; C+D clear the `private*` permutations; E
  clears the `computed-symbol`/string-literal permutations.
- No regressions in equivalence tests.
- Standalone (`--target standalone`) class compilation is unaffected (host
  reconciliation calls are gated off, as `__register_prototype` already is).

## Risks / conflicts

- **Touches `src/runtime.ts` heavily** — the own-property / descriptor handlers
  are shared by plain-object code paths (`Object.defineProperty`,
  `getOwnPropertyDescriptor`, for-in). Any change to the
  `_prototypeMethodNames` early-return ordering risks regressing #1334 (delete
  tombstones), #929 (accessor descriptors), and #1047/#1395 (prototype/class
  registries). Re-run those issues' regression tests.
- **#1364 (method/field descriptor fidelity, sprint 52) is DONE** — it built the
  `_wasmPropDescs` descriptor infrastructure this issue extends. 1591 is the
  *instance-side* and *identity* follow-on, not a re-do. No open dependency, but
  read #1364's diff before touching descriptor flags.
- Cluster ordering matters: 1591d depends on 1591c (shared brand mechanism).

## Notes

- Identified in the #779 bucket decomposition (`plan/issues/1569-779-bucket-decomposition.md`, 2026-05-21) as sub-issue "779b"; formally filed 2026-05-24 after harvest.
- The 1569 decomposition estimated ~290 fails — current measurement 294, consistent.
- **2026-05-27**: dev investigation re-scoped this from a parser/ordering bug to
  the WasmGC-struct ↔ host reconciliation problem above. The filename layout
  prefixes (`same-line`, `stacked`, `rs`) are test262 generator artifacts, not
  the failure cause. `status` set to `blocked` pending sub-issue creation
  (1591a–e). No open `depends_on` — #1364 (the descriptor-infra prerequisite)
  already merged 2026-05-20.

## 2026-06-03 senior-dev re-profile — Cluster A is NOT the gap; standalone-mode `__proto_method_call` is

Re-investigated against current `main` (HEAD 815592da2) to scope a 1591a slice.
**Cluster A (instance-field own-property visibility) already works in JS-host
mode.** Earlier framing that `hasOwnProperty`/`getOwnPropertyDescriptor`/`Object.keys`
fail on instance fields was a *test-harness artifact*, not a compiler defect:

- `Object.getOwnPropertyDescriptor(c, "field")` → correct
  `{value, writable:true, enumerable:true, configurable:true}`.
- `Object.prototype.hasOwnProperty.call(c, "field")` → **true**,
  `Object.keys(c)` → **`["field","other"]`**, `propertyIsEnumerable` → **true** —
  *but only when the host wires `imports.setExports(instance.exports)`*. The
  runtime's `_readOwnDescriptor` / proxy `getOwnPropertyDescriptor` traps resolve
  struct fields via `_getStructFieldNames` + `__sget_<key>`, which require the
  exports table. The real test262 runner DOES call `setExports`
  (`tests/test262-runner.ts:3120`), so JS-host conformance for Cluster A is
  already correct. Probes that omit `setExports` produce false negatives
  (`__struct_field_names(c)` returns `"field,other"` but `__sget_*` is unreachable).

**The genuine 1,660-row standalone gap is a hard COMPILE ERROR, not a runtime
reconciliation miss.** In `--target standalone`, `Object.prototype.<method>.call(receiver, …)`
always lowers to the JS-host `__proto_method_call` import
(`src/codegen/expressions/calls.ts:2737-2862`), which is rejected:
> `'__proto_method_call' (dynamic-shape object/property operation) is not yet
> supported in --target standalone (#1472 Phase B).`
`__hasOwnProperty` / `__object_hasOwn` are still classified as JS-host late
imports (`src/codegen/expressions/late-imports.ts:70`), so even direct
`c.hasOwnProperty(k)` does not yet compile standalone.

### Revised fix direction (supersedes 1591a-as-runtime-materialization)

The class-elements standalone family is **blocked on the #1472 Phase C native
MOP routing** (Reflect.* + Object.prototype.* dispatch to the Wasm-native open-object
runtime), which is in flight on **task #274** (`feat(#1472 Phase C): Reflect.*
standalone routing`). The concrete next slice for 1591 is a codegen change at
`calls.ts:2737`: when `ctx.standalone && typeName === "Object"` and `methodName ∈
{hasOwnProperty, propertyIsEnumerable, isPrototypeOf}`, route to the native
runtime helper instead of `__proto_method_call`; and a parallel
`Object.keys`/`getOwnPropertyNames(struct)` native-enumeration emit (reusing the
Phase B Blocker B Slice 2 enumeration consumer, task #261). These depend on Phase C
landing its receiver→native-MOP plumbing first to avoid duplicating the dispatch
layer. **Recommend keeping #1591 `blocked` on #1472 Phase C** rather than cutting a
1591a runtime-materialization slice — there is no runtime materialization bug to fix.

- No source changes in this pass; this is a re-profile correcting the scope.
  The 294 host-mode `class/elements` count predates the descriptor-infra
  (#1364/#1629) landings and should be re-measured; the 1,660 standalone rows
  are the load-bearing number and are Phase-C-gated.

## 2026-06-07 codex attempt 22 — borrowed Object.prototype routing + enumerability slice

Implemented the actionable Phase-C slice identified in the 2026-06-03
re-profile:

- `Object.prototype.propertyIsEnumerable.call(receiver, key)` now follows the
  same standalone borrowed-call synthesis as `hasOwnProperty`, so closed
  class-struct receivers keep compile-time field/method semantics while open
  `any` receivers route to the native `__propertyIsEnumerable` helper.
- `Object.prototype.isPrototypeOf.call(proto, value)` now routes to the native
  standalone `__isPrototypeOf` prototype-chain helper instead of refusing via
  the `__proto_method_call` gate.
- `propertyIsEnumerable` over registered WasmGC class prototypes/class objects
  now reuses descriptor truth: prototype/static methods are own but
  non-enumerable, while instance fields remain enumerable.
- Runtime `__hasOwnProperty` now also consults `_staticMethodNames`, matching
  the existing static-method descriptor support from #1395.

Focused coverage added in `tests/issue-1591.test.ts`; the older #1888 Slice 3
guard in `tests/issue-1472.test.ts` was updated from refuse-loud to the new
native `isPrototypeOf` behavior.

Validation:

- `pnpm exec vitest run tests/issue-1591.test.ts --reporter=dot` — pass
- `pnpm exec vitest run tests/issue-1472.test.ts -t "#1888 Slice 3" --reporter=dot` — pass
- `pnpm exec vitest run tests/issue-1364a-class-method-descriptors.test.ts tests/issue-1364b-class-method-delete.test.ts tests/issue-1047.test.ts tests/issue-1395-phase1.test.ts tests/issue-341.test.ts tests/equivalence/issue-1334.test.ts --reporter=dot` — pass
- `pnpm exec prettier --check src/codegen/object-ops.ts src/codegen/expressions/calls.ts src/runtime.ts tests/issue-1591.test.ts tests/issue-1472.test.ts` — pass
- `pnpm exec biome lint src/codegen/object-ops.ts src/codegen/expressions/calls.ts src/runtime.ts tests/issue-1591.test.ts tests/issue-1472.test.ts --diagnostic-level=error` — exit 0; Biome still prints its existing diagnostic-cap notice.

Broad `tests/issue-1472.test.ts` was sampled once and still has six unrelated
pre-existing runtime expectation failures in earlier Phase C / Slice 2 cases
(`Object.create`/`Object.setPrototypeOf` identity projections and open-any
method arity projections). The touched #1888 Slice 3 borrowed-dispatch block
passes in isolation.

## 2026-06-07 codex attempt 30 — PR refresh / stale-baseline gate

Resumed the already-open ready PR #1278 on `symphony/1591`. The branch contains
the attempt 22 implementation and the PR is not draft, but the previous GitHub
Actions run failed in `Test262 Sharded / merge shard reports` after all
individual shards passed. The raw job log shows the failure is the global
stale-baseline guard, not this branch's class-elements change:

- `js2wasm-baselines` baseline main-sha
  `ff02d201152dc8777d3e8151ed05dddd47d75ecf`
- baseline was 114 commits behind `origin/main`
- guard threshold is 50 commits
- failure message: "STALE BASELINE ... Fix baseline promotion before merging.
  See #1668."

Attempt 30 refresh:

- Merged current `origin/main` into `symphony/1591` cleanly.
- Re-ran scoped local validation on the merged branch:
  - `pnpm exec vitest run tests/issue-1591.test.ts --reporter=dot` — pass
  - `pnpm exec vitest run tests/issue-1472.test.ts -t "#1888 Slice 3" --reporter=dot` — pass
  - `pnpm exec vitest run tests/issue-1364a-class-method-descriptors.test.ts tests/issue-1364b-class-method-delete.test.ts tests/issue-1047.test.ts tests/issue-1395-phase1.test.ts tests/issue-341.test.ts tests/equivalence/issue-1334.test.ts --reporter=dot` — pass
  - `pnpm exec prettier --check src/codegen/object-ops.ts src/codegen/expressions/calls.ts src/runtime.ts tests/issue-1591.test.ts tests/issue-1472.test.ts` — pass
  - `pnpm exec biome lint src/codegen/object-ops.ts src/codegen/expressions/calls.ts src/runtime.ts tests/issue-1591.test.ts tests/issue-1472.test.ts --diagnostic-level=error` — exit 0; Biome still prints its existing diagnostic-cap notice.
- Pushed the refreshed ready PR branch. GitHub reported PR #1278 as open,
  non-draft, mergeable, and based on `main`; checks were pending on the refreshed
  head when this note was written.

Next step is merge-queue/auto-merge enablement. If GitHub later rejects queueing
because the shared baseline remains stale, flip this issue back to `in-progress`
and report that external blocker.
