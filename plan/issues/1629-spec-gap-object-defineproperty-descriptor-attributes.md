---
id: 1629
title: "spec gap: Object.defineProperty — descriptor attribute fidelity (664 test262 fails, biggest single bucket)"
status: done
created: 2026-05-08
updated: 2026-06-11
priority: high
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: object
goal: spec-completeness
sprint: 61
pr: 1281
renumbered_from: 1335
parent: 1328
related: [1629a, 1629b, 1629c, 1630, 1631, 1130, 1364b]
claimed_by: codex-developer
claimed_at: 2026-06-07T10:02:45.369Z
completed: 2026-06-10
---
> **UNIFIED DESCRIPTOR-MODEL SPEC (architect, 2026-05-29).** The single
> coherent implementation plan for the whole Object property-descriptor
> family is the **"## Unified Implementation Plan — Object property-descriptor
> model"** section at the bottom of this file. It supersedes the per-sub-cluster
> notes above as the *sequencing* authority; the older sections remain as the
> historical record of #1629a/#1629b (both merged) and the original mis-scoped
> investigations. Tech lead schedules the slices (S1–S6); each is
> independently shippable and net-positive on full CI.

> **Sprint 56 close-out (2026-05-29):** carried over to Backlog. Two of the
> three sub-clusters landed this sprint — **#1629a** (dynamic/non-literal
> descriptor materialization, PR #835) and **#1629b** (`getOwnPropertyDescriptor`
> attribute read-back for plain-object struct fields). The remaining residual is
> **#1629c** — Array/Function *exotic* `defineProperty` semantics, the largest
> sub-cluster, which overlaps **#1130** (`status: in-review`). Live baseline
> `9ee8e921` (2026-05-29) still shows ~1,000 non-passing tests across the
> `Object.defineProperty` / `getOwnPropertyDescriptor` family, so the umbrella is
> **not** done. #1629c needs the attribute-table + struct-descriptor-read design
> from the Implementation Plan below, gated behind / coordinated with #1130.

# #1335 — Object.defineProperty: descriptor attribute fidelity

## Problem

`built-ins/Object/defineProperty` test262 bucket is the single largest fail bucket in the
audit: **467 / 1131 pass (41.3%) — 664 fails (600 assertion_fail, 32 other, 16 runtime_error,
7 type_error, 5 wasm_compile)**.

Spec §10.1.6 (OrdinaryDefineOwnProperty) and §20.1.2.4 (Object.defineProperty) require:

1. **Property attributes** (`writable`, `configurable`, `enumerable`) tracked **per property**.
2. **Accessor properties** (`get`/`set`) stored separately from data properties.
3. **Type-checking** the descriptor — non-object descriptors throw TypeError.
4. **Validating** descriptor invariants: a non-configurable property cannot become configurable,
   non-writable cannot become writable, the descriptor type cannot flip from data to accessor, etc.
5. **Coalescing** missing descriptor fields with defaults (writable/configurable/enumerable default
   to false; data-descriptor `value` defaults to undefined).

The current js2wasm implementation in `src/codegen/object-ops.ts` and `src/runtime.ts`:
- Sets the field value but **does not record the attribute flags** for typed structs.
- Only the externref/host path retains attributes (it forwards to host `Object.defineProperty`).
- For typed (struct-backed) objects, redefining a non-configurable property silently succeeds.

## Acceptance criteria

1. `built-ins/Object/defineProperty/15.2.3.6-3-*` (descriptor coalescing) tests pass.
2. `built-ins/Object/defineProperty/15.2.3.6-4-*` (configurable invariants) tests pass.
3. `built-ins/Object/defineProperty/15.2.3.6-5-*` (writable invariants) tests pass.
4. Pass-rate for `built-ins/Object/defineProperty` rises from 41.3% to ≥75%.
5. Object.defineProperties and Object.create(o, descriptors) inherit the fix.

## Files to modify

- `src/codegen/object-ops.ts` — descriptor compilation, attribute storage
- `src/codegen/property-access.ts` — attribute checks on get/set/delete
- `src/runtime.ts` — runtime helpers for typed-object descriptor table

## Implementation Plan

### Root cause

Typed (WasmGC struct) objects have no attribute storage — every property is implicitly
`{writable:true, configurable:true, enumerable:true}`. The descriptor passed to
`Object.defineProperty` is parsed for its `value` but the attribute bits are dropped on the floor.

### Approach

Add a parallel attribute-table struct to typed objects:

```
(type $AttrEntry (struct (field $key (ref string)) (field $flags i32)))
;; flags: bit 0 = writable, bit 1 = enumerable, bit 2 = configurable, bit 3 = isAccessor
(type $AttrTable (array (mut (ref null $AttrEntry))))
;; Object struct gains an extra (mut (ref null $AttrTable)) — null means "all defaults".
```

When `Object.defineProperty` is called:
1. Parse the descriptor (a JS object) into `(value, flags)` pairs at compile time when possible,
   or at runtime via `__parse_descriptor` host import.
2. Lazily allocate `$AttrTable` on first non-default-attribute write.
3. On subsequent writes, look up by key and validate invariants.

### Edge cases

- Descriptor is null/undefined → TypeError at the call site.
- Descriptor has both `value` and `get` → TypeError (data + accessor mix).
- Descriptor argument is a Proxy → must trap on `[[Get]]` for each known key.
- Property already non-configurable → reject incompatible redefinition (return false in
  Reflect.defineProperty / throw in Object.defineProperty).

### Test262 sample

- `test262/test/built-ins/Object/defineProperty/15.2.3.6-1-1.js` (undefined → TypeError)
- `test262/test/built-ins/Object/defineProperty/15.2.3.6-3-1.js` (default attribute coalescing)
- `test262/test/built-ins/Object/defineProperty/15.2.3.6-4-82.js` (non-configurable invariants)

## Investigation (2026-05-27, dev-1607)

Authoritative baseline (`.test262-cache/test262-current.jsonl`, HEAD 1f9ada252):
**502 pass / 624 fail / 5 compile_error** in `built-ins/Object/defineProperty`.

Fail clusters by filename prefix:

| cluster        | fails | notes |
|----------------|-------|-------|
| `15.2.3.6-4-*` | 436   | step-4 [[DefineOwnProperty]] semantics |
| `15.2.3.6-3-*` | 173   | ToPropertyDescriptor / coalescing |
| `15.2.3.6-2-*` | 8     | property-key coercion |
| misc           | ~7    | symbol/typedarray/coerced-P/etc. |

Within c4 (431 sampled): **188 function-involving, 133 array-involving, 83 plain-object**.
The bulk target **Array / bound-Function exotic objects** (length/index semantics,
accessor-on-array), which are host-backed externrefs — a separate problem from the
issue's stated "typed-struct attribute table" plan.

### Root cause confirmed for the plain-object + dynamic-descriptor subset

`Object.defineProperty` is **compile-time inlined** in `src/codegen/object-ops.ts`
(`compileObjectDefineProperty`); no `__defineProperty_*` import is emitted for the
common cases. All descriptor analysis (value / get / set / writable / enumerable /
configurable extraction, the data+accessor-mix TypeError at line 736, struct-field
attribute storage) is guarded by `if (ts.isObjectLiteralExpression(descArg))`.

When the descriptor is passed as a **variable** (e.g. `var desc = {get, value};
Object.defineProperty(o, "foo", desc)` — the dominant c3 shape), NONE of that fires:
- `valueExpr`/`getNode`/`descWritable`/… are all `undefined`,
- the data+accessor-mix check sees `hasData=false, hasAccessor=false` → no throw,
- it falls to the `else` branch → `emitExternDefinePropertyNoValue`, which emits
  `__defineProperty_value(obj, prop, null, flags)` with statically-empty flags and
  **never passes the real descriptor's value/get/set to the runtime**. No validation,
  no storage. Reproduced: variable-descriptor `{get,value}` mix returns 0 (no throw);
  test262 expects TypeError.

Separately, even for the inline-literal plain-object path,
`Object.getOwnPropertyDescriptor(o,"foo").writable` returns the default `true` for a
brand-new (non-struct-field) property defined via `defineProperty({value:101})` — the
flags are stored in `ctx.definedPropertyFlags` / sidecar but `shapePropFlags` is only
updated when the prop is an existing struct field (`userIdx >= 0`), so descriptor
read-back misses them. (4-17 family.)

### Why there is no small fix

Routing the dynamic-descriptor case to the existing-but-dead runtime
`__defineProperty_desc(obj, prop, desc)` (runtime.ts:4045) does NOT work as-is: the
descriptor object is itself a WasmGC struct, and that helper's `getField` reads struct
descriptors via `_sidecarGet`, which returns `undefined` for real struct fields (`get`/
`value` live as `__sget_*` exports, not sidecar). So the runtime cannot read an opaque
struct descriptor's fields. A correct fix needs either (a) materializing the descriptor
struct into a JS object before the runtime call, or (b) teaching `getField` to read
struct fields through the exported getters. Both are non-trivial.

**Conclusion:** the 624 fails do not reduce to one localized patch. The biggest sub-clusters
(Array/Function exotic defineProperty) are a distinct workstream; the plain-object subset
needs the attribute-table + struct-descriptor-read design in the Implementation Plan above.
Recommend splitting into sub-issues:
- **#1629a** — dynamic (non-literal) descriptor: materialize struct descriptor → route to
  runtime `__defineProperty_desc` with working field reads (covers most of c3, ~150).
- **#1629b** — `getOwnPropertyDescriptor` attribute read-back for non-struct-field
  defined props on plain objects (4-17 family).
- **#1629c** — Array/Function exotic defineProperty semantics (the 321 array/function c4
  fails) — likely overlaps #1130.

No code change landed under this task; needs architect spec before implementation.

## Partial fix #1629b (2026-05-28)

Sub-cluster fixed: `Object.getOwnPropertyDescriptor` attribute readback
for plain-object struct fields that were redefined via
`Object.defineProperty`. Root cause: the GOPD fast path in
`src/codegen/expressions/calls.ts` reads `ctx.shapePropFlags`, but that
table is built via `buildShapePropFlagsTable` *after* body compilation
finishes — so per-variable updates recorded during codegen
(`definedPropertyFlags`, keyed `varName:propName`) are overwritten with
defaults. The defineProperty path's attempt to update `shapePropFlags`
inline (object-ops.ts:1133-1137) is a no-op when the table has not yet
been created.

Fix: GOPD fast path now consults `ctx.definedPropertyFlags` first when
arg0 is an identifier, falling back to the shape table. Tests:
`tests/issue-1629b.test.ts` (4 cases: writable/enumerable/configurable
overrides + default preservation, all green). Does not address
sub-clusters #1629a (dynamic descriptor) or #1629c (Array/Function
exotic) — those remain open.

## Attempt 22 (2026-06-07, codex-developer)

Focused implementation landed for descriptor-field presence when the field's
value is explicitly `undefined`. The previous runtime used `!== undefined` as
both a value test and a descriptor-field presence test, which made
`{ value: undefined }`, `{ get: undefined }`, and variable-held descriptor
objects indistinguishable from omitted fields after lowering through WasmGC
descriptor structs.

Changes:
- Codegen routes inline/dynamic descriptor structs with explicit `undefined`
  descriptor fields through `__defineProperty_desc`, annotating the lowered
  descriptor object with sidecar entries for those present fields.
- Runtime `ToPropertyDescriptor` materialization now uses HasProperty-style
  presence checks before reading descriptor values, so present `undefined`
  fields remain present.
- Runtime descriptor validation now uses field-presence bits, preserving the
  data/accessor conflict and non-configurable accessor SameValue invariants
  when `get`, `set`, or `value` are explicitly `undefined`.
- `Object.getOwnPropertyDescriptor` fast paths defer to the runtime descriptor
  table for properties known to have been defined through the sidecar path.
- `extern_get` no longer falls through ordinary JS descriptor-object properties
  whose value is `undefined` to Wasm struct field getters.

Focused validation:
- `pnpm exec vitest run tests/issue-1629.test.ts` — 5/5 pass.
- `pnpm exec vitest run tests/issue-1629.test.ts tests/issue-1629*.test.ts`
  — 42/42 pass.
- Scoped test262 samples around `Object.defineProperty` descriptor coalescing
  and invariants were rerun. The targeted `undefined` descriptor field behavior
  is fixed by the local tests, but representative test262 samples still expose
  downstream gaps outside this slice: widened-field `verifyProperty` coverage,
  array exotic length RangeError behavior, and accessor closure identity
  read-back.

## Attempt 30 (2026-06-07, codex-developer)

Focused follow-up for accessor descriptor fidelity:

- `Object.defineProperty` now treats `get: identifierRef` / `set: identifierRef`
  descriptors as accessor descriptors when the receiver key is an existing
  struct field. Those descriptors route through the runtime descriptor sidecar
  instead of being recorded as flag-only data descriptors.
- Compiled dot/bracket reads for locals with accessor-backed descriptor entries
  consult the runtime descriptor model before falling back to `struct.get`, so
  statically typed fields redefined through accessor-reference descriptors
  invoke the getter per ECMA-262 §10.1.8.1.
- Wasm closure callable wrappers are cached per closure/arity and `__host_eq`
  canonicalizes cached wrappers to their underlying closure. This preserves
  accessor identity for `Object.getOwnPropertyDescriptor(o, k).get === getter`,
  matching the descriptor read-back expected after §20.1.2.4 DefinePropertyOrThrow.

Focused validation:

- `pnpm exec vitest run tests/issue-1629.test.ts` — 8/8 pass.
- `pnpm exec vitest run tests/issue-1629.test.ts tests/issue-1629*.test.ts`
  — 45/45 pass.
- `TEST262_WORKERS=2 TEST262_REPORTER=dot TEST262_LOCAL_SHARD_GLOB='tests/test262-local-shard[1-3].test.ts' TEST262_PATH_FILTER='built-ins/Object/defineProperty/15.2.3.6-4-10.js|built-ins/Object/defineProperty/15.2.3.6-4-11.js|built-ins/Object/defineProperty/15.2.3.6-3-1.js' pnpm run test:262`
  — 3/3 pass.

---

# Unified Implementation Plan — Object property-descriptor model

> Architect, 2026-05-29. Authoritative sequencing plan for the entire
> `Object.{defineProperty,defineProperties,create,getOwnPropertyDescriptor,
> getOwnPropertyDescriptors}` family plus Array/Function exotic
> `defineProperty`. Branch each slice off fresh `origin/main`. Read this
> top-to-bottom before claiming any slice — the slices share one model and
> must land in order S1→S6 (each gated on the prior to avoid regressions).

## Live baseline (results JSONL, HEAD `9ee8e921`, 2026-05-29)

| bucket | pass | fail | other | total | rate |
|--------|-----:|-----:|------:|------:|-----:|
| `Object/defineProperty`            | 497 | 623 | 11 | 1131 | 43.9% |
| `Object/defineProperties`          | 301 | 328 |  3 |  632 | 47.6% |
| `Object/create`                    | 169 | 146 |  5 |  320 | 52.8% |
| `Object/getOwnPropertyDescriptor`  | 266 |  43 |  1 |  310 | 85.8% |
| `Object/getOwnPropertyDescriptors` |   8 |   8 |  2 |   18 | 44.4% |
| **family total**                   | **1241** | **1148** | **22** | **2411** | 51.5% |

Plus the ~80-test `Array/prototype/*` getter-observing cluster (#1130,
`in-review`) which depends on the same accessor-read primitive S3 introduces.

Fail-prefix breakdown (non-pass only): `defineProperty:15.2.3.6-4` 427,
`defineProperty:15.2.3.6-3` 178, `defineProperties:15.2.3.7-6` 171,
`defineProperties:15.2.3.7-5` 146, `defineProperty:15.2.3.6-2` 8, rest <10.

Failure-mode histogram (sampled across the family, dominant first):
1. **`accessed !== true`** (~70) — `defineProperty(o,k,{get})` then `o.k`
   reads the struct field directly, the accessor never fires. *(read-back gap)*
2. **`overrideData` / data not overwritten** (~50) — dynamic data descriptor
   stored in the JS sidecar, but compiled `struct.get` reads the original
   field value. *(write-back gap)*
3. **`afterDeleted` / redefine-then-read** (~45) — same struct read-back gap
   after `delete` + redefine.
4. **`Expected TypeError, got "Expected an exception"`** (~60) — invariant
   not enforced: a non-configurable/non-writable redefine that must throw
   silently succeeds (the receiver is an exotic or the validation path is
   not reached for that receiver kind).
5. **`Getter/Setter must be a function: [object Object]`** (~16) — descriptor
   `get`/`set` arrives as a WasmGC closure struct, not a JS callable.
6. **`RangeError` on `length` redefine** (~3 named + within c4) — Array exotic
   `length` validation (ArraySetLength).

## Root cause (one model, three storage sites that disagree)

There are **three** places a property's value+attributes can live, and the
compiled read path only ever consults the first:

- **(a) the WasmGC struct field** — `struct.get`/`struct.set`. This is what
  compiled `o.k` reads/writes for a statically-typed plain-object receiver.
  It has *no* attribute storage; every field is implicitly
  `{writable,enumerable,configurable:true}` and is always a *data* property.
- **(b) the JS-side descriptor sidecar** — `_wasmPropDescs`
  (`src/runtime.ts:450`, per-object `Map<key,flags>` with bits
  `_SC_WRITABLE|_SC_ENUMERABLE|_SC_CONFIGURABLE|_SC_DEFINED|_SC_ACCESSOR`,
  defined at 763-767), the accessor store `_wasmStructAccessors` (457), and
  the value sidecar `_wasmStructProps`. Populated by the runtime
  `__defineProperty_*` helpers and read by host-side MOP operations
  (`getOwnPropertyDescriptor`, `Object.keys`, `JSON.stringify`, the
  `_wrapForHost` proxy traps).
- **(c) compile-time tables** — `ctx.definedPropertyFlags`
  (keyed `"varName:propName"`, set in `object-ops.ts`) and
  `ctx.shapePropFlags` (per-struct-type, built post-body). Used by the
  `getOwnPropertyDescriptor` / `propertyIsEnumerable` fast paths in
  `expressions/calls.ts`.

The runtime model (b) is already **substantially correct**: ToPropertyDescriptor
(`_toPropertyDescriptorValidate`, runtime.ts:851) and ValidateAndApply
(`_validatePropertyDescriptor`, runtime.ts:792) implement the ES §10.1.6.3
invariants, freeze/seal flips them correctly, and #1629a/#1629b/#1631 wired the
dynamic-descriptor and GOPD-read-back paths. **The unsolved problem is that
compiled code bypasses (b) entirely**: it reads/writes the struct field (a)
directly, so an accessor defined via `defineProperty` is invisible to a
subsequent compiled `o.k`, and a dynamic data write lands only in the sidecar
that compiled reads never consult. #1630 fixed the *write* direction for the
host→struct path (`__sset_` setters); the missing direction is **struct read →
descriptor model** when a property has a non-default descriptor.

## The unified descriptor model (target end-state)

**Single source of truth = the runtime sidecar (b), reached uniformly via a
`[[Get]]`/`[[Set]]`/`[[DefineOwnProperty]]` shim whenever a property is known
to carry a non-default descriptor.** Fast-path direct `struct.get`/`struct.set`
is *retained* for the overwhelmingly common case of a never-`defineProperty`'d
property (zero overhead, no regression). The model is the same in host mode and
standalone/WASI mode; only the *backing primitive* differs:

- **Host mode**: sidecar maps keyed on the JS object identity
  (`_wasmPropDescs`/`_wasmStructAccessors`/`_wasmStructProps`), exactly as
  today. Accessor invocation goes through `_maybeWrapCallable` so WasmGC
  closure get/set become JS callables.
- **Standalone/WASI mode** (no JS host): the same per-object descriptor table
  is a WasmGC structure attached to the object — `(type $DescEntry (struct
  (field $key (ref string)) (field $flags i32) (field $value (mut anyref))
  (field $get (mut anyref)) (field $set (mut anyref))))` held in a
  `(array (mut (ref null $DescEntry)))` reachable from the object via a
  side `WeakMap`-equivalent: a global `(array (mut (ref null any)))` keyed by a
  per-object monotonic id stored in a hidden i32 field, OR — simpler and
  preferred for S1 — a dedicated `$DescSidecar` field appended to the object
  struct, `null` until the first non-default define. Flags bit layout is
  identical to the runtime `_SC_*` constants so the two modes share the
  ValidateAndApply logic (port `_validatePropertyDescriptor` to a Wasm
  function in S5; until then standalone falls back to the host helper when a
  JS host is present and is documented-degraded otherwise).

The **distinction key** that decides fast-path vs shim is a per-(receiver,
property) "has-non-default-descriptor" bit:
- **Compile time**: `ctx.definedPropertyFlags` already records every property a
  given variable had `defineProperty` called on. Extend it to also record
  *accessor-ness* (it stores flags; add the `_SC_ACCESSOR` bit at the
  define site) so codegen can decide at the *read* site whether to emit the
  accessor-aware shim.
- **Runtime** (dynamic receiver / unknown at compile time): the sidecar's
  presence of an entry for the key *is* the bit. The shim checks
  `_wasmPropDescs.get(o)?.has(key)` (host) / `$DescSidecar != null` lookup
  (standalone) and only then diverges from the field.

This mirrors the existing **class-accessor** mechanism (`ctx.classAccessorSet`
+ `__<Struct>_get_<prop>` call in `property-access.ts:870-883`) — that is the
exact pattern S3 generalises from class-declared accessors to
`defineProperty`-declared ones.

**Coordination with #1726 arguments-exotic / `[[ParameterMap]]`**: there is no
`1726-*` file on disk yet. When it lands, its mapped-arguments model is a
*separate exotic* `[[DefineOwnProperty]]` (CreateMappedArgumentsObject, ES
§10.4.4) whose entries alias the formal-parameter slots. It must **reuse** the
S1 descriptor-sidecar storage and the S3 accessor-read shim, but install its
own per-index getter/setter pair (the parameter map) rather than the generic
data field. Do **not** fork a second descriptor representation — the arguments
exotic is a *producer* of sidecar accessor entries, consumed by the same shim.
Flag the dependency in #1726 when it is written; until then S1–S6 are
arguments-agnostic.

## Slice sequence (S1–S6) — each independently shippable, net ≥ 0

> Sequencing rule: S1 unifies storage, S2 the descriptor-read API, S3 the
> compiled read path (the big lever), S4 invariants, S5 Array/Function exotics
> (#1629c), S6 standalone parity. S3 depends on S1+S2; S5 depends on S4. Each
> slice carries its own `tests/issue-1629-S{n}.test.ts` and must show full-CI
> `net ≥ 0` with no single Object/Reflect bucket regressing > 0.

### S1 — Consolidate descriptor storage + GOPD/GOPDs read-back  *(est. +35–55)*

**Goal**: one canonical per-object descriptor table feeds *all* descriptor
read APIs; `getOwnPropertyDescriptor`/`getOwnPropertyDescriptors` return
spec-correct attributes for every define path (literal, dynamic, accessor).

**Files**: `src/runtime.ts`, `src/codegen/expressions/calls.ts`,
`src/codegen/object-ops.ts`.

- Make `getOwnPropertyDescriptors` (`Object/getOwnPropertyDescriptors`,
  8 fails) a thin loop over `ownKeys` + the existing single-key GOPD helper —
  it currently has no dedicated path. Emit/route to a runtime
  `__getOwnPropertyDescriptors(obj)` that returns a plain JS object mapping
  each own key to the descriptor object built by the existing GOPD logic.
- Unify the three compile-time/runtime read sources behind a single runtime
  reader `_readOwnDescriptor(obj, key) -> PropertyDescriptor | undefined` that
  checks, in order: accessor sidecar (`_wasmStructAccessors`) → value+flags
  sidecar (`_wasmPropDescs` + `_wasmStructProps`) → live struct field via
  `__sget_<key>` with default data flags. The existing GOPD fast path in
  `calls.ts` (consults `ctx.definedPropertyFlags`, see #1629b note above) stays
  as the compile-time shortcut; this is its runtime fallback for dynamic
  receivers.
- Ensure `defineProperty`'s inline-literal path *also* writes the sidecar
  entry (today it only updates `ctx.definedPropertyFlags`/`shapePropFlags`) so
  GOPD-via-runtime and GOPD-via-compile-time agree. The
  `priorExistingFlags`/`newFlags` computation in `object-ops.ts:1137-1180`
  already derives the right flags — additionally call the runtime
  `__record_desc(obj, key, flags, valueOrAccessor)` so (b) is populated.

**Edge cases**: Symbol keys (use `_normalizeDescKey`); a property defined then
`delete`d must drop its sidecar entry; GOPDs ordering = `[[OwnPropertyKeys]]`
order (integer-index ascending, then insertion-order strings, then symbols).

**Tests**: `getOwnPropertyDescriptors/*` (18), the `15.2.3.6-3-*` GOPD
read-back subset.

> **S1 STATUS — DONE (2026-05-29, dev-b).** Implemented in `src/runtime.ts`:
> the canonical `_readOwnDescriptor(obj, prop, exports)` reader (sidecar
> value/accessor → proto/static method allowlists → bare struct field via
> `__sget_<key>` with default data flags) and `_ownStructKeys(obj, exports)`
> own-key enumeration (mirrors `__getOwnPropertyNames` + `__getOwnPropertySymbols`;
> a host-proxy `Reflect.ownKeys` does **not** surface typed struct fields, so a
> dedicated enumerator is required). The single-key `__getOwnPropertyDescriptor`
> now delegates to `_readOwnDescriptor`, and `__object_getOwnPropertyDescriptors`
> is a loop over `_ownStructKeys` + `_readOwnDescriptor` (was: bare
> `Object.getOwnPropertyDescriptors(obj)`, which returned `{}` for WasmGC
> structs). Both forms now agree on bare fields, sidecar (defineProperty'd)
> data/accessor props, and class methods. Tests: `tests/issue-1629-S1.test.ts`.
>
> The inline-literal `__record_desc` bullet was **not needed for agreement**:
> `getOwnPropertyDescriptors` always routes through the runtime
> `_readOwnDescriptor` reader (never the compile-time `ctx.definedPropertyFlags`
> shortcut), and `defineProperty` already populates the `_wasmPropDescs` /
> `_wasmStructProps` sidecar that the reader consults — so single-key and plural
> read the same source. Two adjacent pre-existing defects observed and left to
> their owners (out of S1 scope): (1) compiled member *dot*-access into a
> struct-shaped descriptor result (`ds.a.value`) reads as a struct field rather
> than a host property — a codegen member-access issue, not descriptor
> read-back; bracket access and returning the whole object to the host both
> work; (2) module-top-level `defineProperty` runs in the wasm start function
> before `setExports`, so the dynamic-descriptor materialization throws
> (start-fn/exports timing, #1629a / #1320 family). S2/S3 remain open.

### S2 — ToPropertyDescriptor / descriptor-validation completeness  *(est. +25–40)*

**Goal**: `15.2.3.6-3-*` (ToPropertyDescriptor, 178 fails) and the
`15.2.3.7-5/6-*` defineProperties coalescing clusters pass. This is the
"descriptor *input* parsing" half; S1 was the "descriptor *output*" half.

> **S2 STATUS — partial DONE (2026-05-29, dev-b).** Landed in `src/runtime.ts`
> `__defineProperties`:
> 1. **Two-pass** per ES §20.1.2.3.1 — the struct-descsObj path now gathers
>    `ToPropertyDescriptor` for *all* keys (pass 1) before applying any via
>    DefinePropertyOrThrow (pass 2). A bad-shape descriptor on a later key now
>    aborts before earlier keys install (observable for primitive/bad-shape
>    descriptors: `property-description-must-be-an-object-not-*`). Note:
>    DefinePropertyOrThrow validation (e.g. non-configurable redefine) correctly
>    stays in-order in pass 2, so an earlier valid key *is* installed before a
>    later DefinePropertyOrThrow throws — that is spec-correct (V8 matches).
> 2. **wrap-callable wired** into both `_toPropertyDescriptorValidate` call sites
>    so struct closure get/set surface to the spec `typeof === "function"`
>    checks, matching the single-key `__defineProperty` handler.
> Tests: `tests/issue-1629-S2.test.ts`.
>
> **Gated on closure-readability (S3).** The value+get TypeError and bad-shape
> abort are NOT observable when the offending per-property descriptor is itself
> a WasmGC struct whose `get`/`set` is a Wasm closure (or whose `value` is a
> closure): `getField`/`__sget_` cannot read a closure out of an arbitrary
> struct field, so `_toPropertyDescriptorValidate` sees it as absent and the
> conflict can't fire. This is the same root as S1's `ds.a` dot-access gap and
> belongs to **S3** (accessor-aware compiled read/write path). The two-pass +
> wrap-callable structure is correct and will start surfacing those wins the
> moment S3 lands closure-field readability. The HasProperty-vs-Get
> trap-ordering bullet is also deferred to S3 (needs the same reader).

**Files**: `src/runtime.ts` (`_toPropertyDescriptorValidate`, 851;
`_validatePropertyDescriptor`, 792), `src/codegen/object-ops.ts`
(`compileObjectDefineProperties`, the dynamic fallback at ~2597).

- `_toPropertyDescriptorValidate` already covers the data/accessor-mix
  TypeError, getter/setter-must-be-callable, and field coalescing. Audit
  against ES §10.1.6.3 step-by-step for the residual `15.2.3.6-3` fails:
  - **HasProperty vs Get order** — the spec reads `enumerable`,
    `configurable`, `value`, `writable`, `get`, `set` in that fixed order,
    each guarded by HasProperty. When the descriptor is a *Proxy or exotic*,
    the trap-invocation count/order is observable. Route through the host
    `Object.getOwnPropertyDescriptor`-equivalent ordering for externref
    descriptors; for struct descriptors the `getField` closure order must
    match.
  - **`defineProperties` Properties coercion** — ToObject(Properties), then
    `[[OwnPropertyKeys]]` filtered to enumerable, building a *descriptor list*
    first and only *then* applying (ES §20.1.2.3 / 19.1.2.3.1
    ObjectDefineProperties: two-pass — gather all, validate all, then apply).
    The current `__defineProperties` path applies as it iterates; convert to
    gather-then-apply so a later-key validation TypeError doesn't leave
    earlier keys mutated.
- Wire the `wrapCallable` (`_maybeWrapCallable`) path #1629a added so struct
  closure get/set never surface the `[object Object]` callable error (16 fails,
  failure-mode 5).

**Edge cases**: descriptor with getter that throws (must propagate); Symbol
descriptor keys; `__proto__` as a data key (not prototype) in the descriptor.

**Tests**: `defineProperty/15.2.3.6-3-*`, `defineProperties/15.2.3.7-{5,6}-*`,
the `property-description-must-be-an-object-not-*` set.

### S3 — Accessor-aware compiled read/write path  *(est. +90–140, the big lever)*

**Goal**: a property carrying a non-default descriptor (accessor, or
dynamically-written data value) is read/written through the descriptor model
by *compiled* code, not the raw struct field. Kills failure-modes 1/2/3
(`accessed !== true`, `overrideData`, `afterDeleted`) — the largest cluster.
Also unblocks #1130 (Array getter-observing iteration shares this primitive).

**Files**: `src/codegen/property-access.ts` (`compilePropertyAccess` ~971,
`compileElementAccess`, the struct-field read at 884-915), the assignment
lowering in `src/codegen/expressions.ts`/`statements.ts`,
`src/codegen/object-ops.ts`.

- **Read site** (`o.k` / `o[k]`): at compile time, if
  `ctx.definedPropertyFlags` has an entry for `(receiverVar, k)` whose flags
  include `_SC_ACCESSOR`, OR the receiver type is `any`/externref/unknown,
  emit the **accessor-aware shim** instead of the bare `struct.get`:
  ```wasm
  ;; shim: prefer descriptor model when an entry exists, else fast field read
  local.get $obj
  <prop-as-externref>
  call $__get_via_descriptor      ;; runtime: returns sidecar accessor result
                                  ;; (invokes get()) / sidecar value / sentinel
  ;; if sentinel "no-entry": fall through to struct.get fast path
  ```
  Model on the **existing class-accessor dispatch** in
  `property-access.ts:870-883` (`ctx.classAccessorSet` + `__<Struct>_get_<p>`
  call) — generalise it from class-declared accessors to a
  `ctx.definedAccessorProps` set populated at the `defineProperty` site.
  Where the receiver is statically a known struct **with no recorded
  accessor/dynamic-descriptor for `k`**, keep the bare `struct.get`
  (zero-overhead fast path — this is the no-regression guarantee).
- **Runtime `__get_via_descriptor(obj, key)`**: host import that consults
  `_wasmStructAccessors` (invoke getter via `_maybeWrapCallable`), then
  `_wasmStructProps`/`_wasmPropDescs` value, then returns a distinguished
  "no-entry" sentinel (a private externref singleton) so the compiled fast
  path can branch. Symmetric `__set_via_descriptor(obj,key,val)` invokes a
  sidecar setter or honours non-writable (no-op / throw-in-strict).
- **Write site** (`o.k = v`): if `(receiverVar,k)` is accessor → call the
  setter via `__set_via_descriptor`; if it is a recorded non-writable data
  prop → strict-mode TypeError / sloppy no-op; else `struct.set` fast path
  *and* keep the sidecar value in sync (so a later GOPD/host read agrees) via
  the `__sset_` + `__record_desc` pair from S1/#1630.

**Edge cases**: getter that mutates `o` re-entrantly; accessor defined on the
*prototype* (must walk the chain — defer cross-prototype to #1364b, scope S3
to own-property accessors); `delete o.k` must clear `definedAccessorProps` and
the sidecar so the field fast-path resumes; element access `o[i]` with computed
key where `i` is a known accessor index.

**Risk**: this touches the property hot path. Mitigation: the shim is emitted
**only** when the compile-time descriptor table says the property is
non-default, or the receiver type is dynamic; the dense statically-typed
struct path is byte-identical to today. Add a micro-benchmark to
`benchmarks/` (struct field read in a tight loop) and confirm no codegen change
for the no-descriptor case (diff the emitted Wasm for a plain `{a:0}.a` read).

**Tests**: `defineProperty/15.2.3.6-4-*` plain-object subset (~the 188
function-free / 83 plain of c4), `tests/issue-1629-S3.test.ts`
(accessor read-back, dynamic data overwrite, delete-then-read). Re-run #1130
suite — expect incidental gains.

> **S3 STATUS — first sub-slice DONE (2026-05-30, senior-developer).** Shipped
> the inline `defineProperty`-accessor **STORE contract** fix (the verified
> `const o:any={z:0}; Object.defineProperty(o,"p",{get(){return 42}}); o.p`
> returns `undefined` bug). Root cause (confirmed by probe): the accessor branch
> in `compileObjectDefineProperty` (`src/codegen/object-ops.ts:914`) compiled a
> dead `${structName}_get_<prop>` Wasm function + `classAccessorSet` and
> EARLY-RETURNED, feeding **no** runtime sidecar — so the getter lived in neither
> `_wasmStructProps[obj]["__get_<prop>"]` nor `_wasmStructAccessors`, the slots
> `_safeGet` / `_readOwnDescriptor` / GOPD consult.
>
> **Fix (two files, ~50 lines):**
> 1. `src/codegen/object-ops.ts` — gate the inline accessor branch on a new
>    `receiverIsStaticStruct` bit (= struct resolved *without* the `any`/externref
>    define-site rescue fallbacks, i.e. the same resolution strength the read
>    site `resolveStructNameForExpr` has). **Statically-typed receivers**
>    (class instances, typed objects) keep the compiled-getter fast path
>    unchanged — that path IS reachable from their reads, and removing it
>    regressed the #459 accessor suite by 6 in a first attempt. **`const o:any`
>    receivers** (resolved only via fallbacks 1–3) now fall through to the
>    existing `emitExternDefinePropertyNoValue`, which already mirrors get/set
>    into the runtime `__defineProperty_accessor` import (closure-wrapped via
>    `_maybeWrapCallable` / `__call_fn_N`) — the symmetric mirror the data-value
>    path always emitted. One write reconciles `_safeGet`, GOPD, and
>    `_readOwnDescriptor`.
> 2. `src/runtime.ts` `__defineProperty_accessor` — one defensive line for the
>    **data→accessor flip**: drop a stale plain value at `sc[prop]` before
>    installing the getter, so `_sidecarGet` (checked before `__get_<prop>` in
>    `_safeGet`) cannot shadow the new accessor.
>
> **WHY this shape, not the architect's approach (A) verbatim:** (A) proposed a
> *new* `emitExternDefinePropertyAccessor` helper, but the exact plumbing it
> describes (compile get/set via `compileArrowAsCallback({needsThis:true})` →
> `__defineProperty_accessor`) **already exists** in
> `emitExternDefinePropertyNoValue` — the bug was purely that the early-returning
> struct branch *intercepted* the accessor case before reaching it. Routing
> through the existing helper is strictly less code and reuses proven plumbing.
>
> **Fixed (verified by `tests/issue-1629-S3.test.ts`, 10 cases):** getter on
> dot / bracket / dynamic-key reads of an `any` receiver; getter with `this`
> receiver (works — `_maybeWrapCallable` binds `this` for getters, contrary to
> the dropped-`this` note which only affects the broader closure-arity path);
> getter closing over scope; get-only / set-only / get+set; data→accessor flip
> via bracket read; GOPD read-back (`{get:fn, set:undefined, enumerable:false,
> configurable:false}`).
>
> **Still deferred to the broader S3 read-shim / representation foundation
> (#1130/#1320), NOT in this slice — confirmed PRE-EXISTING on main, not
> regressed:** (1) `o.k` **dot**-access on a *statically-known struct field*
> redefined as an accessor lowers to a direct `struct.get` that never touches
> `_safeGet` (bracket/dynamic reads of the same prop DO work); (2) `o.k = v`
> **setter invocation** on an `any` receiver does not fire (write-side
> `_safeSet`→`__set_<prop>` gap, independent of this STORE fix); (3) host-side
> *raw JS* `o.p` access on a returned opaque WasmGC struct externref (same
> limitation the data path has — the sidecar is only consulted by compiled
> `_safeGet`, not native V8 access). No-regression confirmed: the #459 /
> defineProperty / object-literal-getter equivalence suites match baseline
> exactly (3 pre-existing fails, unchanged).

### S4 — Invariant enforcement on define (configurable/writable/extensible)  *(est. +40–70)*

**Goal**: `defineProperty`/`defineProperties` throw `TypeError` exactly when ES
§10.1.6.3 ValidateAndApplyPropertyDescriptor mandates (failure-mode 4,
`Expected TypeError, got "Expected an exception"`, ~60). The runtime
`_validatePropertyDescriptor` already implements this for the sidecar; the gap
is that it is **not consulted** when the receiver is a typed struct whose
property was never sidecar-recorded (so `existing === undefined` → "first
definition" → no validation).

**Files**: `src/runtime.ts` (`_validatePropertyDescriptor`, the
`__defineProperty_*` helpers), `src/codegen/object-ops.ts`.

- On **every** `defineProperty`, seed the sidecar with the property's *current*
  effective descriptor *before* validating, so a struct field that exists with
  default `{writable,enumerable,configurable:true}` is treated as an existing
  configurable data property (redefine OK), while a property previously made
  non-configurable via an earlier define correctly rejects. This requires S1's
  "inline-literal path also writes the sidecar" so the first define of a
  literal property is recorded.
- `preventExtensions`/`seal`/`freeze` already flip flags (runtime.ts:4726-4763).
  Add the **non-extensible new-property** rejection: defining a *new* key on a
  non-extensible object throws (currently the new-key path skips the check —
  see `nonExtensibleVars` guard in `object-ops.ts:1142`, extend to the runtime
  helper for dynamic receivers).
- Honour `Reflect.defineProperty` returning `false` (vs throwing) — same
  validation, different failure surface; ensure both call sites share
  `_validatePropertyDescriptor`.

**Edge cases**: SameValue for non-writable redefine with equal value (already
in `_validatePropertyDescriptor:839`); data↔accessor flip on non-configurable;
`writable:false` then `writable:false` again (idempotent, no throw).

**Tests**: `defineProperty/15.2.3.6-4-*` invariant subset, `freeze`/`seal`/
`preventExtensions` redefine-throws cases, `Reflect/defineProperty/*`.

### S5 — Array & Function exotic `defineProperty` (#1629c)  *(est. +120–180)*

**Goal**: ES §10.4.2 (Array exotic `[[DefineOwnProperty]]`) and §10.2.4
(Function `length`/`name` non-writable-configurable) semantics. ~156 array +
~33 function fails in c4. Depends on S4 (invariant engine) being in place.

**Files**: `src/runtime.ts`, `src/codegen/object-ops.ts`
(`maybeEmitVecLengthGrowth`, 159; the externref/array define path),
`src/codegen/array-methods.ts` (length read via [[Get]] for #1130 overlap).

- **Array `length` exotic** (ES §10.4.2.4 ArraySetLength):
  - `defineProperty(arr, "length", desc)` with a numeric value: ToUint32 must
    equal ToNumber (else `RangeError` — failure-mode 6); if new len < old,
    delete indices ≥ newLen *in descending order*, stopping (and setting len to
    last+1) if a non-configurable index blocks the truncation; `writable:false`
    makes `length` non-writable (subsequent index sets beyond it fail).
  - In host mode, real JS arrays already implement this — route
    `defineProperty(realArray, "length", ...)` straight to native
    `Object.defineProperty` (the `_isArray` branch). The bug is the compiler
    *intercepts* array receivers via `maybeEmitVecLengthGrowth` and the typed
    `__vec_*` path, which bypasses native length semantics. Fix: when the
    receiver is an array and the key is `"length"` or a canonical numeric
    index, prefer the runtime `__defineProperty_desc` → native path over the
    typed fast path; keep the typed fast path only for the
    grow-by-index-assignment common case where no descriptor attributes differ
    from default.
  - **Array index exotic**: defining index `P` ≥ length on a non-writable-length
    array → reject; defining a valid index updates length; an accessor on an
    index makes array methods observe it (this is the #1130 link — S3's
    accessor-read shim must apply to `arr[i]`).
- **Function exotics** (ES §10.2.4): `length` and `name` are
  `{writable:false, enumerable:false, configurable:true}`. `defineProperty(fn,
  "length", {value})` is allowed (configurable) but `writable:true` on a
  redefine without configurable-change rules apply. In host mode route function
  receivers to native `Object.defineProperty`; the gap is the compiler treating
  a compiled function (a WasmGC closure struct) as a plain struct — detect
  `_isCallable`/closure receivers in the define path and route to the runtime
  helper that operates on the host function wrapper.
- **Bound functions**: defer `[[BoundTargetFunction]]` length composition to the
  existing bound-function work (runtime.ts:6202) — scope S5 to plain
  function/array exotics.

**Edge cases**: `Object.defineProperty(arr, "0", {get})` then `arr.map(...)`
(needs S3 accessor-read on indices); sparse array length truncation with a
non-configurable hole; `arguments` exotic is **out of scope** (→ #1726, reuses
S1/S3, separate exotic).

**Risk**: highest-blast-radius slice (Array hot path + array-methods). Land
**after** S3/S4 so the accessor-read primitive and invariant engine exist.
Watch `Array/prototype/*` and `Array/length` buckets for regression; the
typed `__vec_*` fast path for plain dense arrays must stay byte-identical.

**Tests**: `defineProperty/15.2.3.6-4-*` array/function subset,
`defineProperty/redefine-length-*`, `Array/prototype/*` (#1130), `Function/*`
length/name prop-desc tests.

### S6 — Standalone/WASI descriptor parity  *(est. +0 test262, dual-mode debt)*

**Goal**: the descriptor model works without a JS host (per the dual-mode
architecture principle). No new test262 (the runner uses host mode) but
required so the feature is not host-only.

**Files**: `src/runtime.ts` (the helpers being ported), a new
`src/codegen/descriptor-runtime.ts` or additions to `object-ops.ts`.

- Implement the `$DescSidecar` WasmGC field + `(array (ref null $DescEntry))`
  table described in "The unified descriptor model" above, attached to
  object structs lazily.
- Port `_validatePropertyDescriptor` (pure flag logic, no host calls) to a
  Wasm function so S4 invariants hold standalone.
- `__get_via_descriptor`/`__set_via_descriptor`/`__record_desc` get
  Wasm-native bodies that read/write the WasmGC table; accessor get/set are
  `call_ref` on the stored closure refs.
- Until S6 lands, standalone mode degrades gracefully: define records flags but
  cannot invoke accessors without a host — document the gap in
  `docs/architecture/` and gate behind the existing nativeStrings/standalone
  detection.

**Tests**: extend `tests/equivalence/` standalone variants; add a
`--target wasi` smoke test compiling a `defineProperty({get})` program and
asserting the getter fires.

> **S6 STATUS — data-descriptor sub-slice DONE (2026-06-03, senior-developer).**
> `Object.defineProperty(obj, key, { value, writable?, enumerable?,
> configurable? })` (and `Reflect.defineProperty` for a data descriptor) now
> lowers to a **native** `__defineProperty_value` on the #1472 Phase B
> `$Object`/`$PropEntry` runtime under `--target standalone`, instead of
> refusing (#1472 Phase A). Zero `env::__defineProperty*` host imports; modules
> instantiate with an empty import object.
>
> **What shipped (`src/codegen/object-runtime.ts`, `late-imports.ts`,
> `object-ops.ts`):**
> 1. New native helper `__defineProperty_value(obj, key, value, flags:f64) ->
>    externref` — structurally a sibling of `__extern_set`: unwrap obj→$Object
>    (lenient no-op on non-object), translate the host f64 flag word
>    (`computeRuntimeFlags`: value bits 0/1/2) to the native `$PropEntry.flags`
>    (`FLAG_WRITABLE/ENUMERABLE/CONFIGURABLE` — same bit positions), grow at the
>    0.7 load factor, then `__obj_insert`. The existing native `__extern_get`
>    reads the value back; no `$PropEntry` layout change was needed for the
>    data path (value+flags slots already exist).
> 2. Added `__defineProperty_value` to `OBJECT_RUNTIME_HELPER_NAMES` so
>    `ensureLateImport` routes it native (the routing check precedes the
>    `STANDALONE_REFUSED_IMPORT` `__defineProperty*` refusal, so the name in both
>    sets resolves native first).
>
> **Latent bug fixed (shared, host + standalone): `emitObjectArgNullGuard`
> (object-ops.ts) emitted `global.get index: stringGlobalMap.get(msg)` which is
> the `-1` nativeStrings sentinel** → `Invalid global index: 4294967295` at
> instantiate. This was dormant because the Object.* null-guard was previously
> unreachable under standalone (defineProperty refused before reaching it). Now
> the guard materializes its message via `stringConstantExternrefInstrs` (inline
> `$NativeString` under nativeStrings, host `string_constants` global otherwise)
> — same canonical fix family as #1623. `Object.defineProperty(null, …)` now
> throws a catchable TypeError in standalone.
>
> **Deferred to S6 follow-up (NOT this slice):** accessor descriptors
> (`{ get, set }`) — `__defineProperty_accessor` stays in `STANDALONE_REFUSED_IMPORT`.
> Native accessor support needs `$PropEntry` accessor slots (`$get`/`$set` anyref
> + isAccessor flag) and `call_ref` invocation on the stored closure at the read
> site — the WasmGC analogue of the host `_maybeWrapCallable` path. Dynamic
> (non-literal) descriptor objects (`__defineProperty_desc`) and
> `Object.getOwnPropertyDescriptor` native read-back also remain follow-ups.
>
> **Follow-on slice — native `hasOwnProperty`/`propertyIsEnumerable` for struct
> receivers (from sd-846-slice3's #1591 investigation):**
> `Object.prototype.hasOwnProperty.call(receiver, key)` (and
> `propertyIsEnumerable`) currently routes to the JS-host `__proto_method_call`
> import at `src/codegen/expressions/calls.ts` Case 2a (`typeName === "Object"`),
> so it refuses under `--target standalone`. With the #1629 native descriptor
> model in place, this becomes a localized routing slice: at the Case-2a site,
> when `ctx.standalone && typeName === "Object" && methodName ∈
> {hasOwnProperty, propertyIsEnumerable}`, lower to a new native helper built
> on the already-present `$Object`/`$PropEntry` primitives — `hasOwnProperty`
> reuses `__extern_has_idx` (own-slot probe, tombstone-aware), and
> `propertyIsEnumerable` reads the matched `$PropEntry.$flags & FLAG_ENUMERABLE`
> (returning `false` for a missing key rather than throwing). Both take the
> coerced receiver→`$Object` (lenient: non-object receiver → ToObject already
> handled upstream) and the key string. No `$PropEntry` layout change needed —
> the enumerable bit and own-slot probe already exist. This is the natural
> dispatch-layer extension of S6 and should be cut as its own net-≥0 PR after
> S6 lands.
>
> **Tests:** `tests/issue-1629-S6.test.ts` (6 cases: full-attr define +
> read-back, omitted-attr defaults, coexist with dynamic set/get, redefine
> overwrite, null-throw TypeError, table grow/rehash). No-regression: the
> existing #1472 (21) + #1629 S1/S2/S3 (23) suites stay green; host-mode
> defineProperty still compiles.

## Cross-cutting risks & guardrails (apply to every slice)

1. **Object hot path** — S3 is the danger. The accessor-read shim must be
   emitted *only* when the compile-time descriptor table flags the property as
   non-default, or the receiver is dynamic. Prove no-regression by diffing the
   emitted Wasm for a plain `{a:0}.a` read before/after; add a tight-loop
   struct-read micro-benchmark to `benchmarks/`.
2. **Full-CI net ≥ 0 per slice, mandatory.** Each PR runs full sharded
   test262; `dev-self-merge` gate: `net_per_test > 0`, no single
   `built-ins/Object/*` or `built-ins/Reflect/*` or `built-ins/Array/*` bucket
   regressing. S5 specifically watch `Array/prototype/*` and `Array/length`.
3. **Reflect parity** — `Reflect.{get,set,defineProperty,
   getOwnPropertyDescriptor,ownKeys}` share the same model; a slice that fixes
   `Object.X` must not diverge from `Reflect.X`. Add the matching Reflect test
   path to each slice's scoped check.
4. **Proxy interaction** — descriptor traps on a Proxy descriptor argument
   (S2) and Proxy receivers (deferred) — keep `_wrapForHost`/`_hostProxyReverse`
   semantics intact; do not let the sidecar shadow a Proxy trap.
5. **Symbol keys** — every storage/read site uses `_normalizeDescKey`; never
   stringify a Symbol into a template-literal export name (`__sget_`/`__sset_`
   are string-key only by construction — Symbols stay sidecar-only).
6. **Sidecar/field sync** — after S1 every define writes both the struct field
   (when applicable, via `__sset_`) and the sidecar (`__record_desc`); a read
   that consults one must agree with the other. The single canonical reader
   `_readOwnDescriptor` (S1) is the reconciliation point.

## Dependency order (for the tech lead)

```
S1 (storage + GOPD/GOPDs)  ──┐
S2 (ToPropertyDescriptor)  ──┼──> S3 (compiled accessor read/write)  ──┐
                              │                                         ├─> S5 (#1629c Array/Fn exotic)
                             S4 (invariant enforcement) ────────────────┘
S6 (standalone parity) depends on S1+S3+S4 (port to Wasm); no test262 gate.
```

S1 and S2 are parallelisable (different files mostly: S1 in calls.ts/runtime
GOPD, S2 in runtime ToPropertyDescriptor). S3 needs both. S4 can run alongside
S3 (different concern: validation vs read path) but must land before S5.
#1130 should be re-tested after S3 and likely closes as incidental.

## Aggregate estimate

Conservative sum of per-slice lower bounds ≈ **+310** family tests; optimistic
upper bounds ≈ **+525**, plus the ~80 #1130 Array-getter tests unblocked by S3.
The family has 1,148 current fails, so the plan targets roughly 30–45% of the
remaining gap landing across S1–S5 (the residual is cross-prototype descriptor
inheritance #1364b, Proxy receivers, and bound-function exotics, all separate
workstreams).

---

## Implementation Plan (S3) — inline `defineProperty`-accessor STORE contract

> Architect, 2026-05-29. Concrete spec for the *first slice* of S3, scoped to
> the verified bug: `const o:any={z:0}; Object.defineProperty(o,"p",{get(){return 42}}); o.p`
> returns `undefined`, should be `42` — for `o.p`, `o["p"]`, forced-dynamic
> `o[k]`, and a host-side read of `o.p`. Data-value `defineProperty({value:7})`
> and field-redefine already READ correctly; **only accessor-get/set is broken.**
> This is a self-contained STORE-contract fix — **senior-dev implementable**,
> NOT representation-gated (see §5). It is the minimal correct foundation the
> broader S3 read-shim generalisation in the section above builds on; ship this
> first.

### 0. Spec basis (fetched from tc39.es/ecma262, 2026-05-29 ed.)

- **§20.1.2.4 Object.defineProperty(O, P, Attributes)**: step 1 `if Type(O) is
  not Object, throw TypeError`; step 2 `key = ? ToPropertyKey(P)`; step 3
  `desc = ? ToPropertyDescriptor(Attributes)`; step 4 `? DefinePropertyOrThrow(O,
  key, desc)`; step 5 `return O`.
- **§10.1.6.3 ValidateAndApplyPropertyDescriptor** + **§10.1.6.1
  OrdinaryDefineOwnProperty**: when `O` is extensible and `P` is absent, the
  descriptor is created with *omitted fields defaulting to false/undefined*
  (§6.2.6.4 CompletePropertyDescriptor) — for an **accessor descriptor**, an
  absent `[[Get]]`/`[[Set]]` defaults to `undefined`; `[[Enumerable]]`,
  `[[Configurable]]` default to `false`.
- **§10.1.8.1 OrdinaryGet (accessor branch)**: if the resolved own property is
  an accessor property, `[[Get]]` is called with the receiver as `this`; if
  `[[Get]]` is `undefined`, return `undefined`.
- **§10.1.5.1 OrdinaryGetOwnProperty** must surface the accessor's
  `{[[Get]],[[Set]],enumerable,configurable}` shape (this is the S1
  `_readOwnDescriptor` path, already wired — the STORE this slice adds must feed
  it so GOPD stays consistent).

### 1. Root cause (precise)

`Object.defineProperty(o, "p", {get(){...}})` is **compile-time inlined** by
`compileObjectDefineProperty` (`src/codegen/object-ops.ts:576`). For the accessor
case it takes the branch at **object-ops.ts:914** (`if ((getNode || setNode) &&
!valueExpr && structName && structTypeIdx !== undefined && propName)`), which:

1. resolves `structName` for `const o:any={z:0}` via **fallback 2/3**
   (object-ops.ts:855-893 — local-Wasm-type lookup + decl-initializer
   field-name matching), since the TS type is `any`;
2. compiles the getter body into a fresh **Wasm function**
   `${structName}_get_p` and registers `ctx.classAccessorSet.add("${structName}_p")`
   (lines 922-923, 950-1039);
3. `return`s early (line 1124) — it **never** populates any runtime sidecar and
   **never** calls a `__defineProperty_*` import.

The read side then disagrees on *where the getter lives*, in two distinct ways:

- **Compiled struct-typed read** (`resolveStructNameForExpr` resolves a struct):
  `compilePropertyAccess` consults `classAccessorSet` at
  `property-access.ts:2256-2279` and *would* call `${structName}_get_p`. But for
  `const o:any={z:0}` the read-site resolver **`resolveStructNameForExpr`
  (property-access.ts:149-183) is weaker than the define-site resolver** — it
  only tries `resolveStructName(type)` + `widenedVarStructMap` + `this`, and
  lacks the define-site's local-Wasm-type (fallback 1) and decl-initializer
  field-match (fallback 3) fallbacks. So it returns `undefined`, the accessor
  branch is skipped, and the read falls through to the externref/host path.
- **Host/externref read** (`__extern_get` → `_safeGet`, runtime.ts:2610):
  `_safeGet` looks for a string-keyed getter at
  **`_wasmStructProps.get(obj)?.["__get_p"]`** (runtime.ts:2643-2647). The inline
  path never wrote that slot, so `_safeGet` finds nothing and returns
  `undefined`. (dev-b's probe `key=p sc=undefined hasGetter=undefined` confirms
  the getter is in **neither** `_wasmStructProps['__get_p']` **nor**
  `_wasmStructAccessors` — it exists only as a dead compiled Wasm function whose
  dispatch key the readers can't reach.)

Net: the inline accessor STORE writes a *fourth* location (a compiled Wasm fn +
`classAccessorSet`) that **none of the four reader entry points uniformly
consult**, and the one reader that could (the compiled struct path) can't
re-derive the same `structName` the define site used.

### 2. STORE contract — the decision

**Route the inline accessor-`defineProperty` to the existing runtime
`__defineProperty_accessor` import** (runtime.ts:5536), exactly mirroring how the
inline *data-value* path already mirrors to `__defineProperty_value`
(object-ops.ts:1358-1401). **Do not** keep building the `${structName}_get_p`
Wasm function + `classAccessorSet` registration as the *primary* store.

**Why this choice (vs. having the inline path populate `_wasmStructAccessors`
directly, or vs. keeping the compiled-fn path and fixing only the read-site
resolver):**

1. **The runtime handler already implements the full, correct contract.**
   `__defineProperty_accessor` (runtime.ts:5536-5599) already: ToPropertyKey-s
   the key; wraps Wasm-closure get/set via `_maybeWrapCallable(getter,0)` /
   `_maybeWrapCallable(setter,1)` so they become JS-callable through the
   `__call_fn_N` bridge; runs `_validatePropertyDescriptor` (S4 invariants);
   stores into the **canonical** slot `_wasmStructProps[obj]["__get_p"]` /
   `["__set_p"]` for string keys (and `_wasmStructAccessors` for Symbol keys);
   and marks the key own (`if (!(prop in sc)) sc[prop]=undefined`, runtime.ts:5591
   — #929). That slot is **precisely** what `_safeGet` reads (runtime.ts:2646),
   what S1's `_readOwnDescriptor` reads (runtime.ts:3008-3009), and what GOPD
   reads. One write, all four readers agree. This is the same reconciliation S1
   already relies on for data values.
2. **It is symmetric with the working data path.** Data reads work *because*
   `__defineProperty_value` mirrors into the sidecar that `_safeGet`/GOPD read.
   The accessor bug is simply that the symmetric mirror was never emitted. This
   is a one-branch parity fix, not new machinery.
3. **The closure bridge is already universally emitted.** `__call_fn_0..4`,
   `__call_fn_method_N`, and `__is_closure` are emitted **unconditionally** in
   the finalize path (`src/codegen/index.ts:1205-1242`), so they exist even for
   the simplest module. dev-b's "closure infra not emitted for simple modules"
   observation is about the *inline path producing a bare Wasm function instead
   of a closure struct*, not about the `__call_fn_N` exports being absent —
   routing through the runtime sidesteps that entirely (the getter is passed
   as a value and wrapped host-side).
4. **It avoids the dead-end of fixing the read-site resolver.** Strengthening
   `resolveStructNameForExpr` to match the define site would fix the *compiled
   struct* read but NOT the host-side read (dev-b's 4th case) or
   `Object.getOwnPropertyDescriptor`, because those go through the sidecar, not
   the compiled getter. The sidecar route fixes all four in one place.
5. **`const o:any` is externref-backed at the value level.** Reads of an
   `any`-typed `o` predominantly flow through `__extern_get`/`_safeGet`, so the
   sidecar is the load-bearing store regardless. Keeping a parallel compiled-fn
   store only invites the two-sources-disagree class of bug S1 set out to kill.

**Disposition of the existing compiled-getter branch:** keep the
`classAccessorSet` + `${structName}_get_p` registration **as an optional
fast-path overlay only when the read site can provably resolve the same struct**
— but for this slice, the safe, minimal move is to **stop early-returning** from
the accessor branch and instead emit the runtime mirror so the sidecar is always
populated. Two acceptable shapes (senior-dev picks based on diff size):
- **(A, preferred, minimal)** In the accessor branch, after compiling the getter/
  setter Wasm functions (or *instead* of compiling them for the `any`/externref
  receiver), fall through to a new `emitExternDefinePropertyAccessor(...)` that
  pushes `obj`→externref, `prop`→externref, `getter`→externref, `setter`→
  externref, `flags`→f64 and calls `__defineProperty_accessor`. The
  getter/setter values passed to the runtime are the **descriptor's get/set
  expression compiled as a callable value** (a closure-struct externref via the
  normal closure-creation path for `getNode`/`getExpr`), NOT the synthesized
  `${structName}_get_p` Wasm function. `_maybeWrapCallable` then bridges them.
- **(B)** Keep emitting `${structName}_get_p`, register `classAccessorSet`, AND
  *additionally* mirror to the sidecar via `__defineProperty_accessor` (passing
  the closure-wrapped getter). Strengthen `resolveStructNameForExpr` to match the
  define-site fallbacks so the compiled fast path also fires. Larger diff; defer
  the resolver-strengthening to the broader S3 read-shim work above.

**Recommend (A)** for this slice: it deletes the asymmetry at its source, reuses
the proven data-path plumbing, and leaves the compiled fast-path as a later
optimization (the general S3 read shim already specs it).

### 3. Exact change sites

**(a) STORE — `src/codegen/object-ops.ts`, accessor branch at line 914-1125.**
- Compute the runtime accessor flags. Reuse `computeRuntimeFlags`
  (object-ops.ts:1445) but for an accessor descriptor: `hasValue=false`, set the
  accessor bit `1<<6` (the flag layout comment at object-ops.ts:1439-1443 already
  reserves `bit 6: is accessor`). `enumerable`/`configurable` come from
  `descEnumerable`/`descConfigurable` (default false → unspecified bits). Handle
  dynamic flag exprs with `extractDynamicFlagExprs` + `emitRuntimeFlagsF64`
  (object-ops.ts:1474, 1379) exactly as the data path does.
- Add `emitExternDefinePropertyAccessor(ctx, fctx, objArg, propArg, descArg,
  getNode, getExpr, setNode, setExpr, descEnumerable, descConfigurable)` (new,
  sibling of `emitExternDefinePropertyValue` at object-ops.ts:1583). It must:
  1. push `objArg` compiled then coerced to externref (`extern.convert_any` for
     ref/ref_null per the dynamic-descriptor path at object-ops.ts:806-812);
  2. push `propArg` → externref;
  3. push the **getter** as an externref callable: compile `getNode`/`getExpr`
     to a closure-struct ref then `extern.convert_any` (use the same closure
     creation the compiler uses for `{get(){}}` object-literal accessors — see
     `emitObjectMethodAsClosure` / the function-expression closure path; for
     `getExpr` (an identifier ref) compile the identifier and convert). If no
     getter, push `ref.null.extern`;
  4. push the **setter** the same way (or `ref.null.extern`);
  5. push `flags` as f64;
  6. `ensureLateImport("__defineProperty_accessor", [externref,externref,
     externref,externref,f64], [externref])` + `flushLateImportShifts` +
     `call` + `drop`, then `local.get objLocal` to return the obj
     (object-ops.ts:1390-1404 pattern).
- **Remove the early `return objType` at object-ops.ts:1124** so the accessor
  case no longer short-circuits before the sidecar mirror — OR perform the mirror
  *inside* the branch before its return. Either way the sidecar write must always
  execute for the accessor case.
- **Symbol keys**: when `propName` is undefined because the key is a Symbol, the
  runtime handler already routes Symbol keys to `_wasmStructAccessors`
  (runtime.ts:5574-5583). Pass the prop as externref unchanged; no special
  compile-time handling needed.

**(b) READ — `src/runtime.ts` `_safeGet` (line 2636-2662): NO CHANGE.** Once the
STORE writes `_wasmStructProps[obj]["__get_p"]`, the existing
`_safeGet` branch at runtime.ts:2643-2648 fires:
```js
if (typeof key === "string") {
  const wasmSc = _wasmStructProps.get(obj);
  const getter = wasmSc?.[`__get_${key}`];
  if (typeof getter === "function") return getter.call(obj);
}
```
This already invokes the getter with `obj` as `this` (OrdinaryGet §10.1.8.1
accessor branch). The Symbol path at runtime.ts:2650-2652 likewise already
reads `_wasmStructAccessors`. The compiled `o.p` / `o["p"]` / `o[k]` reads for an
`any` receiver lower to `__extern_get`→`_safeGet` (property-access.ts dynamic
fallback + `compileGetWithStructFallback` at property-access.ts:622), and the
host-side `o.p` read goes through the same `_safeGet`. **All four read shapes
are fixed by the single STORE change** — confirm via the test matrix in §6, do
not add read-side code in this slice.

### 4. Edge cases (this slice)

- **get-only** (`{get(){...}}`): STORE writes `__get_p` only; `__set_p` absent →
  `_safeSet` no-ops on write (sloppy), read fires getter. ✓
- **set-only** (`{set(v){...}}`): STORE writes `__set_p` only; `_safeGet` finds
  no `__get_p`, falls through to `obj[key]`/sidecar → `undefined` (correct:
  reading a set-only accessor returns `undefined` per OrdinaryGet step 8 with
  `[[Get]]` undefined). ✓
- **get+set**: both slots written; read fires getter, write fires setter. ✓
- **WRITE through a get+set / set-only accessor** — `o.p = v` on an `any`
  receiver lowers to `__extern_set`→`_safeSet`, which already invokes
  `_wasmStructProps[obj]["__set_p"]` (runtime.ts:2728-2734) — populated by the
  STORE. **NO read/write codegen change.** (Strict-mode "set on a get-only
  accessor throws" is an S4 invariant concern; the existing `_safeSet` no-ops if
  no setter — the sloppy-mode behaviour — so leave it.)
- **accessor redefining an existing data prop** (`o.z` is a struct field, then
  `defineProperty(o,"z",{get})`): the runtime handler's
  `_validatePropertyDescriptor` (runtime.ts:5570) governs configurability; on
  success the sidecar gains `__get_z`. **Read-precedence note:** `_safeGet`
  checks `_sidecarGet(obj,key)` *before* the `__get_` getter (runtime.ts:2641
  vs 2643). For a struct field `z` whose *value* lives in the field (not the
  value-sidecar), `_sidecarGet` returns `undefined` (struct fields aren't in
  `_wasmStructProps` as plain values) so it correctly falls through to the
  getter — **verify** with a test (`{z:0}` then accessor-redefine `z`, read must
  fire the getter, not return the stale field `0`). If the field value *was*
  mirrored into the value-sidecar by a prior data `defineProperty`, the
  define-accessor STORE must **clear that stale value entry** (delete
  `_wasmStructProps[obj][key]` plain value) when installing the accessor, so the
  `_sidecarGet`-first ordering doesn't shadow the new getter. Add this delete to
  the runtime accessor handler (one line near runtime.ts:5585) — it is in-scope
  because it's the data↔accessor flip correctness, not the broader read shim.
- **enumerability/configurability interplay with S1/S2 (#925/#929)**: the STORE
  routes through `_validatePropertyDescriptor` + writes the flags into the
  `_getSidecarDescs` map (runtime.ts:5568-5571), so `getOwnPropertyDescriptor`
  read-back (S1 `_readOwnDescriptor`) reports the accessor's `enumerable`/
  `configurable` correctly and `Object.keys`/enumeration honour them. No new
  flag plumbing — reuse the data path's `computeRuntimeFlags` semantics with the
  accessor bit set. Confirm GOPD returns `{get:fn, set:undefined, enumerable:
  false, configurable:false}` for a bare `{get(){}}` (defaults false per
  §20.1.2.4/CompletePropertyDescriptor).
- **`delete o.p` then read**: out of scope for this slice's STORE, but note the
  runtime `delete` path must clear `__get_p`/`__set_p` and the desc entry (it
  already does for sidecar keys — verify it covers `__get_`-prefixed keys; if
  not, that's an S3-followup, flag it, don't fix here).

### 5. Self-contained or representation-gated? — **self-contained, senior-dev.**

This is a **localized STORE-contract fix**, NOT the #1130/#1320/#1719/#1732
compiled-value↔host-object-identity foundation. Rationale:

- The fix is one new emit helper in `object-ops.ts` + dropping one early
  `return` + one defensive stale-value-clear line in the *already-existing*
  `__defineProperty_accessor` runtime handler. No new ValType, no object-struct
  layout change, no host-identity primitive.
- The reader entry points (`_safeGet`, GOPD, `_readOwnDescriptor`) are unchanged
  and already correct — they were simply never fed. The closure bridge
  (`__call_fn_N`) is pre-existing and unconditional.
- It does **not** require the broader S3 read-shim (compiled `struct.get` →
  descriptor model) because `const o:any` reads already route through the host
  `_safeGet` path; the bug is purely a missing write, not a wrong read lowering.

**Where the representation foundation *would* be needed (explicitly out of scope
for this slice, deferred to the broader S3 / #1130 cluster):** a **statically
struct-typed** receiver (e.g. `const o: {p:number} = {...}` then
`defineProperty(o,"p",{get})`) whose compiled `o.p` lowers to a direct
`struct.get` — that read never touches `_safeGet`, so the accessor would still be
invisible. Handling *that* needs the compile-time `definedAccessorProps` set +
accessor-aware read shim from the S3 section above (the "big lever"). The
verified bug uses `const o:any`, which is externref-backed and host-routed, so
this slice fixes it completely without the representation work. **Minimal
foundational primitive the later struct-typed case needs** (for the record, not
this slice): a per-`(receiverVar, prop)` `definedAccessorProps` compile-time bit
populated at the define site, gating emission of a `__get_via_descriptor` shim at
the read site (already specified above).

### 6. Test matrix (`tests/issue-1629-S3.test.ts`)

All against `const o:any = {z:0}` unless noted; assert the **compiled** result
equals the JS reference:
1. `defineProperty(o,"p",{get(){return 42}}); o.p` → `42` (dot read)
2. `... o["p"]` → `42` (bracket read)
3. `const k="p"; ... o[k]` → `42` (forced-dynamic read)
4. host-side: return `o` to the host and read `.p` → `42` (host `_safeGet`)
5. `defineProperty(o,"p",{set(v){this.z=v}}); o.p` → `undefined` (set-only read)
6. `... o.p = 5` then read `o.z` → `5` (setter fires)
7. `defineProperty(o,"p",{get(){return 1},set(v){...}})` → get reads, set writes
8. data↔accessor flip: `{z:0}` then `defineProperty(o,"z",{get(){return 9}}); o.z`
   → `9` (NOT stale `0` — the stale-value-clear edge case)
9. GOPD read-back: `Object.getOwnPropertyDescriptor(o,"p")` for `{get(){}}` →
   `{enumerable:false, configurable:false}`, `typeof desc.get === "function"`,
   `desc.set === undefined` (S1 consistency)
10. enumerable accessor: `defineProperty(o,"p",{get(){return 1},enumerable:true});
    Object.keys(o)` includes `"p"`

Scoped local check (no full test262): compile + run the 10 cases; then a spot
re-run of `defineProperty/15.2.3.6-4-*` plain-object accessor subset to confirm
net-positive. Watch for **no regression** in `Object/getOwnPropertyDescriptor`
(S1) and the data-value `defineProperty` cases.

### 7. Risk / guardrails

- **No object hot path touched** — this slice adds an emit only in the accessor
  branch of `compileObjectDefineProperty`; plain field reads/writes are
  byte-identical. (The hot-path risk flagged for the broader S3 read shim does
  not apply here.)
- **Reflect parity**: `Reflect.defineProperty` with an accessor descriptor must
  reach the same runtime handler — verify the `Reflect.defineProperty` lowering
  also routes accessors to `__defineProperty_accessor` (it shares
  `_validatePropertyDescriptor`; if it has its own inline accessor branch, apply
  the same mirror). Add one `Reflect.defineProperty({get})` case to the matrix.
- **Standalone/WASI**: this slice is **host-mode only** (the getter is wrapped
  via `_maybeWrapCallable`, a JS-host primitive). Standalone accessor invocation
  is deferred to **S6** (the WasmGC `$DescSidecar` + `call_ref` on stored closure
  refs). Document the gap; do not block this slice on it — it matches the
  existing data-path host-dependence.
