---
id: 7274
title: "IR: native ArrayBuffer / DataView / SharedArrayBuffer surface on standalone — adapter family over the legacy native providers"
status: in-progress
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 7106
related: [7273, 6981, 4461, 4462, 7011, 2835, 1654]
assignee: "ttraenkler/c-r12"
# 2026-11-06 (#7274 slice 1): the native ArrayBuffer surface. The plan, the
# lowering and the adapters live in their own modules
# (ir/native-buffer-surface.ts, ir/native-buffer-lowering.ts,
# codegen/buffers/{ir-native-buffer,array-buffer-native}.ts); what remains in
# each god-file is one arm beside its siblings and the plumbing: the selector
# verdict + arming (select.ts), the script-var capability arm and the
# escape-rule hook (module-bindings.ts), the provider reservation, plan
# constructor, resolver methods and storage check (integration.ts), the
# resolver interface + one dispatch arm (from-ast.ts), and the plan option +
# re-export (codegen/index.ts). dataview-native.ts grows by the slice body's
# receiver-slot parameter and makeHelperFctx's return-type parameter (the
# adapters reuse both). The four god-functions grow by one call or option
# each: the plan, the provider options, the resolver hook, the reservation,
# and isPhase1Expr its one dispatch to the buffer verdict.
loc-budget-allow:
  - src/codegen/dataview-native.ts
  - src/ir/select.ts
  - src/ir/integration.ts
  - src/ir/module-bindings.ts
  - src/ir/from-ast.ts
  - src/codegen/index.ts
  # 2026-11-07 (#7274 slice 2): +1, the import of the shared `dataViewAccessorFn` that replaces the hard-coded `__dv_m_` prefix (review finding 2)
  - src/codegen/closed-method-dispatch.ts
func-budget-allow:
  - src/ir/integration.ts::makeFromAstResolver
  - src/ir/integration.ts::compileIrPathFunctions
  - src/ir/integration.ts::preregisterDynamicSupport
  - src/codegen/index.ts::planIrOverlay
  - src/ir/select.ts::isPhase1Expr
import-cycles-allow:
  - largestSccSize: 732 # 2026-11-06 (#7274 slice 2): +1, codegen/buffers/data-view-native.ts holds the DataView construct / byte-attr sequences extracted from new-indexed.ts and property-access-dispatch.ts (both in the SCC), shared with the IR adapters; it needs dataview-native.ts and type-coercion.ts like the code it was cut from. Slice 1: 2026-11-06 (#7274): codegen/buffers/array-buffer-native.ts holds the ArrayBuffer sequences extracted from new-indexed.ts / property-access-dispatch.ts (both in the SCC) and codegen/buffers/ir-native-buffer.ts wraps them with dataview-native.ts's slice body; both join the SCC their siblings buffers/shared-array-buffer*.ts are already in
---

# IR: native ArrayBuffer / DataView / SharedArrayBuffer surface (standalone)

## Problem

#7273 measured `new ArrayBuffer(…)` as the first refusal of 12 sole-blocker
files on the wrapped stride-40 standalone census (main 9129f7e1). Nine of them
also use `new DataView`, and 2 more start with `new SharedArrayBuffer`. That
is 14 files whose only legacy unit is `<module-init>`.

The selector refuses all three constructors as `expr-new-extern-host-free`.
The #6981 gate behind it says: on a host-free lane there is no
`<Class>_new` import, and every member use on the result is deferred at build.

Legacy compiles all of it host-free:

- **Construction:** `src/codegen/expressions/new-indexed.ts`. ArrayBuffer is a
  `$__vec_i32_byte` packed-i8 vec, a resizable one is `$__resizable_ab`, and
  SharedArrayBuffer comes from the #7011 provider.
- **Members:** `src/codegen/dataview-native.ts`.
  - `__dv_m_<member>` accessor helpers with an all-externref ABI.
  - The ArrayBuffer transfer helpers.
  - Reflective `emit{ArrayBuffer,DataView}ProtoMemberBody` closures.
- **Storage:** a module `var buffer = new ArrayBuffer(n)` is stored as
  `(mut externref)` (`$__mod_buffer`). That is the same physical type as the
  IR's `extern<ArrayBuffer>` handle.

## Measurement

### Per-file member set (the 14 sole-blocker files)

| File | Constructors (shape) | Members | Closures / other blockers |
| --- | --- | --- | --- |
| `ArrayBuffer/options-maxbytelength-undefined.js` | `AB(0, {})`, `AB(0, {maxByteLength: undefined})` | `.resizable` | none |
| `ArrayBuffer/prototype/maxByteLength/return-maxbytelength-resizable.js` | `AB(n, {maxByteLength: k})` | `.maxByteLength` | none |
| `ArrayBuffer/prototype/slice/end-default-if-undefined.js` | `AB(8)` | `.slice(start, end)`, result `.byteLength` | none |
| `DataView/prototype/byteLength/return-bytelength.js` | `AB(12)`, `DV(buf, off)`, `DV(buf, off, len)` | DV `.byteLength` | none |
| `DataView/prototype/getInt32/return-values.js` | `AB(12)`, `DV(buf, 0)` | `setUint8`, `getInt32(off, bool)` | none |
| `DataView/prototype/getFloat64/to-boolean-littleendian.js` | `AB(8)`, `DV(buf, 0)` | `setUint8`, `getFloat64(off, le)`, with `le` ∈ {absent, undefined, null, 0, "", {}, `Symbol("1")`, 1, "string"} | `Symbol("1")` in module-init (unmeasured) |
| `SharedArrayBuffer/length-is-absent.js` | `SAB()` | `.byteLength` | none |
| `ArrayBuffer/prototype/transferToFixedLength/new-length-excessive.js` | `AB(0)` | `transferToFixedLength(2^53)` | inside an `assert.throws(…, function () {})` closure |
| `DataView/excessive-byteoffset-throws-sab.js` | `SAB(1)`, `DV(sab, off)` | none | `new DataView` inside closures |
| `DataView/prototype/setUint32/negative-byteoffset-throws.js` | `AB(12)`, `DV` | `setUint32`, `getUint32` | inside closures |
| `DataView/prototype/setInt8/return-abrupt-from-tonumber-byteoffset.js` | `AB(1)`, `DV` | `setInt8` | closures + object literals with `valueOf`/`toString` methods |
| `DataView/prototype/setFloat16/return-abrupt-from-tonumber-byteoffset.js` | same | `setFloat16` | same |
| `DataView/return-abrupt-tonumber-bytelength.js` | `AB(8)`, `DV(buf, 0, obj)` | none | same |
| `DataView/prototype/setInt16/toindex-byteoffset.js` | `AB(12)`, `DV` | `setInt16`, `getInt16` | object literals with `valueOf`/`toString` methods passed as offsets |

**Straight-line files (no closure, no object-literal method).** These are the
first 7 rows. They are the ones this issue can move.

**The other 7** also need a planned closure whose body:

- calls an extern member on a captured script var, or
- constructs `DataView`, or
- uses object literals with methods (ToNumber through a user `valueOf`).

That is #7271's territory: intrinsic globals and script-var captures in
planned bodies. Those files are listed as follow-ups and are out of scope here.

### Legacy host-free provider per member

| Op | Legacy provider | Callable ABI today |
| --- | --- | --- |
| `DataView#get*/set*` (all 20 accessors, incl. f16 and 64-bit) | `ensureDvAccessorHelper(ctx, m)` → `__dv_m_<m>` | `(externref recv, externref off, [externref val], externref le) → externref`, so usable directly |
| `DataView#byteLength/byteOffset/buffer` | `emitDataViewProtoMemberBody` (reflective getter) | closure body (wrapper, this); needs a plain helper |
| `ArrayBuffer#slice` | `emitArrayBufferSlice` / `emitArrayBufferProtoSliceBody` | closure body (wrapper, this, start, end); needs a plain helper |
| `ArrayBuffer#transfer*` | `ensureArrayBufferTransferHelper` | `(externref recv, externref len) → externref`, usable directly |
| `ArrayBuffer#byteLength/maxByteLength/resizable` | `property-access-dispatch.ts` inline arms | inline only; needs a helper |
| `new ArrayBuffer(n[, opts])` | `tryCompileIndexedBuiltinNew`: AST-coupled; an object-literal `maxByteLength` is resolved at compile time | inline; split coercion and allocation |
| `new DataView(buf[, off[, len]])` | `tryCompileIndexedBuiltinNew` DataView arm | inline; same split |
| `new SharedArrayBuffer(n[, opts])` | `emitSabConstruct(ctx, fctx, args, compileArg)` | already takes a compile callback |

### Second-refusal probe (2026-11-06, `.tmp/` selector bypasses, reverted)

With the three constructors exempted from `expr-new-extern-host-free`, the 7
straight-line files stop at:

- **`objectlit-empty`** on the `{}` options argument (2 files). The
  constructor admission must consume its options literal itself; it cannot
  hand `{}` to the generic object-literal arm.
- **from-ast `unknown class "ArrayBuffer"`** (4 files). On standalone the
  extern-class registry (`getExternClassInfo`) is empty, so the native arm
  must sit before the `externInfo` path, not inside it.
- **`expr-module-scalar-method`** on `buffer.slice(…)` / `sample.setUint8(…)`
  (3 files).
  - A script `var buffer = new ArrayBuffer(n)` lives in an `externref`
    `__mod_` slot, so `scriptVarHome` answers `"dynamic"` and the binding's
    value kind is `dynamic`.
  - `expressionTouchesScalarModuleBinding` counts a dynamic binding as
    scalar, so every member call on it is refused.

### Route decision: typed provider calls, not dynamic dispatch

Admitting member uses on the `dynamic` binding would lower them through the
IR's dynamic method-call path:

- `sample.setUint8(…)` and `buffer.slice(…).byteLength` are exactly the
  dynamic-receiver method calls on a returned object that trap on main
  (#7261). The dispatch forbids routing them.
- It would also widen a module-init arm that is not buffer-specific.

So the plan keeps the typed route:

- A script `var` (or a `let`/`const`) whose every write is a certified
  native-buffer construction (or a certified `slice` result) binds as
  `capability-extern` with a new `capability: "native-buffer"`. The physical
  carrier is the same `externref` slot.
  - It is certified the way #7252 certifies `class-instance` homes: every
    write must construct that one surface class.
  - It reuses the existing `IrModuleCapabilityExternResolver` seam (#4576),
    not a new kind.
- Every member use lowers to a direct call of its native helper, never
  through dynamic dispatch.

## Implementation Plan

### Target structure

**One surface module.** `src/codegen/buffers/ir-native-buffer.ts`, in the
existing `buffers/` subdirectory, so the flat `src/codegen/` root does not
grow. It is shaped like `ir-native-map.ts`:

- exported semantic callable names (`IR_NATIVE_BUFFER_*`);
- one `ensureIrNativeBufferAdapters(ctx, ops)` that registers the legacy
  helpers first, then mints append-only adapters.

**IR types.** No new IR type. Values are the existing
`{ kind: "extern", className }` handles, physically `externref`, the same as
legacy's `$__mod_<name>` globals. So module-binding storage, IR↔legacy
boundaries and `assert.*` arguments need no new conversions.

**Capability.** A new row in `src/ir/capability.ts`,
`nativeBufferSurfaceCapability(jsHost, providersMinted)`. It follows
`consoleSurfaceCapability` (#4462) exactly: on host lanes it is unchanged; on
host-free lanes it claims only when the backend minted the providers. The
resolver answers that from the backend, never from a target name.

**One admission table.** A new contract module,
`src/ir/native-buffer-surface.ts`, holds the closed set
`{ constructor shape } × { member, arity }`:

- the constructors are `ArrayBuffer`, `DataView` and `SharedArrayBuffer`;
- the predicates are `nativeBufferConstructShape(expr)` and
  `nativeBufferMemberUse(access)`, read through `ctx.oracle` (ambient-only,
  lib-declared binding: the #7264 quantifier).

The selector and from-ast both call these predicates. That is the #2135 rule
the console arm follows.

**Selector change.** `phase1NewExpression` exempts exactly these shapes from
`expr-new-extern-host-free`. The member-read and method-call arms on
`extern<ArrayBuffer|DataView|SharedArrayBuffer>` receivers consult the same
table. Everything else keeps its current refusal; a new arm name,
`expr-native-buffer-member`, names the out-of-table refusals.

**from-ast change.** The existing extern-new / extern-call / extern-prop arms
already produce the right IR shape.

- On a host-free lane they emit `irRuntimeFuncRef(IR_NATIVE_BUFFER_*)` calls
  instead of `extern.new` / `<Class>_<m>` imports.
- One helper picks between the two, so there is no second lowering path per
  op.
- Construction options: `{ maxByteLength: e }` is read from the object
  literal at lower time, the same compile-time resolution legacy does. A
  non-literal options argument is refused.

**Integration.** The `irRuntimeFuncRef` scan in `src/ir/integration.ts` gets
one case group → `ensureIrNativeBufferAdapters` +
`observeNativeRuntimeProvider`. That is the Map pattern (`usesNativeMapAdapters`).

### Reuse, no duplication

- **DataView get/set.** Direct calls to `__dv_m_<m>`. No adapter body; the
  callable name resolves to the legacy helper index.
- **Transfer.** Direct calls to `ensureArrayBufferTransferHelper`.
- **Construction and the getters (`byteLength`, `maxByteLength`, `resizable`,
  DataView `byteLength`, `slice`).** Today these are emitted inline into the
  current function, so the work here is extraction, not new code:
  - each inline emitter is split once into a plain helper, e.g.
    `ensureAbConstructHelper(ctx)` with `(externref len, externref maxLen|undefined) → externref`;
  - legacy's inline arm keeps its own instruction sequence, so the standalone
    legacy output does not change. Alternatively legacy also calls the
    helper, and that is a separately measured standalone diff.
  - The default is the first: legacy keeps inline. The helper body is
    generated from the same emitter function, with parameters as locals, so
    there is still one implementation of each sequence.
- **SharedArrayBuffer.** `emitSabConstruct` already takes a compile callback.
  The adapter passes externref param reads.

### Slices (each a separate commit, each measured)

The test262 files are paths under `test262/test/built-ins/`.

**Source files, shared by all slices:**

- `src/ir/native-buffer-surface.ts` (new): the admission table.
- `src/ir/capability.ts`: the capability row.
- `src/ir/module-binding-value-kinds.ts`: the
  `capability-extern {capability: "native-buffer"}` member of the capability
  union.
- `src/ir/module-bindings.ts`: certify the script-var / lexical binding when
  every write is a table construction or a `slice` result.
- `src/ir/select.ts`: the `phase1NewExpression` exemption, the member arms
  and `expressionTouchesScalarModuleBinding`, which consult the table.
- `src/ir/from-ast.ts`: one native arm placed before the `externInfo` path,
  plus one picker for member lowering.
- `src/ir/integration.ts`: one `irRuntimeFuncRef` case group and provider
  observation.
- `src/codegen/buffers/ir-native-buffer.ts` (new): the adapters.
- Helpers extracted from `src/codegen/expressions/new-indexed.ts`,
  `src/codegen/property-access-dispatch.ts` and `src/codegen/dataview-native.ts`.

**Slices:**

1. **ArrayBuffer.**
   - Construct `(n)`, `(n, {})` and `(n, {maxByteLength: e})`. The options
     literal is consumed by the admission.
   - `byteLength`, `maxByteLength`, `resizable`, `slice(a[, b])`.
   - Target files:
     - `ArrayBuffer/options-maxbytelength-undefined.js`
     - `ArrayBuffer/prototype/maxByteLength/return-maxbytelength-resizable.js`
     - `ArrayBuffer/prototype/slice/end-default-if-undefined.js`
2. **DataView.**
   - Construct `(buf[, off[, len]])`.
   - `byteLength`, `byteOffset`, `buffer`, and `get*/set*` with an optional
     little-endian argument, all through `__dv_m_<m>`.
   - Target files:
     - `DataView/prototype/byteLength/return-bytelength.js`
     - `DataView/prototype/getInt32/return-values.js`
     - `DataView/prototype/getFloat64/to-boolean-littleendian.js`, only if
       `Symbol("1")` is already admitted in module-init. Per the lead
       (2026-11-06), Symbol support is out of scope here.
3. **SharedArrayBuffer.**
   - Construct `()` / `(n)` through `emitSabConstruct`, and `byteLength`.
   - Target file: `SharedArrayBuffer/length-is-absent.js`.

**Lead requirements (2026-11-06), apply to every slice:**

- **Representation identity.** The IR value is exactly what legacy's
  provider returns on each lane: `extern.convert_any` of the same struct on
  standalone/wasi, and legacy's externref on gc.
  - Prove it with a mixed-route run in each direction: the IR constructs and
    legacy reads the module slot and members; legacy constructs and the IR
    reads.
- **Admission by type identity, never by name.** A member use is admitted
  only when the receiver is proven to be:
  - a value from this table's construction or `slice`, or
  - a binding certified through it, or
  - an ambient-lib-typed binding (the #7264 quantifier).
- **PR body.** State max +7 / likely 5–7, and list the 7 closure /
  object-literal files as blocked on #7271 / #7267.

### Expected zero-legacy delta (stated before coding)

- **Bounded maximum:** +7 files on the stride, rows 1–7 above.
- **Likely range:** 5–7.
  - Row 6 depends on `Symbol("1")`, which is out of scope here, so it is
    expected to stay legacy.
  - Every file depends on no other module-init refusal appearing behind the
    constructor. I have checked the first refusal only.
- **The 7 closure / object-literal files:** 0 from this issue. They follow
  once #7271's planned-closure prerequisites land.

### Acceptance

**Correctness.**

- The ledger A/B lists the zero-legacy delta by file.
- On standalone test262, A/B over `built-ins/ArrayBuffer`, `built-ins/DataView`
  and `built-ins/SharedArrayBuffer` plus 300 random files: the head never
  traps or differs where the base does not.
- Adversarial probes:
  - lengths NaN, −1, 2^53, 1.5, "8";
  - options not an object, `maxByteLength` < length;
  - out-of-range DataView offsets, and a length past the buffer;
  - non-boolean endianness arguments;
  - a detached buffer after `transfer`;
  - `ArrayBuffer()` without `new`;
  - a subclass `class B extends ArrayBuffer`, which must stay legacy.

**Byte-identity and imports.**

- gc output is byte-identical; the capability row is host-lane neutral.
- Host imports are identical between base and head on gc, standalone and
  wasi.
- No new imports.
- The typed corpus is byte-identical.

**Code quality.**

- One admission table shared by selector and from-ast.
- One adapter module in `codegen/buffers/`.
- Legacy helpers are reused or extracted, never copied.
- No new IR type.
- LOC and function budgets are respected; any grant is dated in this file.

## Slice 1 — ArrayBuffer (2026-11-06, implemented)

### What was built

| Module | Role |
| --- | --- |
| `src/ir/native-buffer-surface.ts` | The one node-identity plan (constructions, getters, `slice`, script-var certification). Selector and from-ast both read it. |
| `src/ir/native-buffer-lowering.ts` | Lowers a certified operation to its adapter call. |
| `src/shared/contracts/native-buffer-adapters.ts` | The six adapter names (producer ↔ provider ABI). |
| `src/codegen/buffers/array-buffer-native.ts` | The construction / getter sequences, extracted from `new-indexed.ts` and `property-access-dispatch.ts`; legacy now calls them inline. |
| `src/codegen/buffers/ir-native-buffer.ts` | The adapters: plain functions whose bodies are those emitters (and `dataview-native.ts`'s slice body, now parameterised by receiver slot). |
| `src/ir/capability.ts` | `nativeBufferSurfaceCapability(jsHost, providersAvailable)`. |

The plumbing: the selector verdict sits at the top of `isPhase1Expr`
(before the module-extern consumer gate), the module-binding resolver gains
the script-var capability arm, integration mints the adapters pre-Phase-3
and builds the plan once for both planning sites (`planIrNativeBufferSurface`).

### Decisions taken while implementing (deviations from the plan above)

- **A producer is certified only where the plan consumes it**: as a
  certified getter / `slice` receiver, or as a write into a certified var.
  The first cut admitted a construction anywhere; probes then showed three
  post-claim demotes (an argument to a legacy function, `typeof`, a
  conditional arm). Those stay legacy now.
- **Escape rule.** A certified var whose handle ends in a plain member read
  (`buf.byteLength`, `buf.slice(1).byteLength`) does not count as a
  module-extern consumer (`isNativeBufferMemberReceiver`); the selector
  refuses every member outside the table by name
  (`expr-native-buffer-member`).
- **Shadowing.** The checker reports a script's `function ArrayBuffer(){}`
  as the lib declarations alone, so the lib-only quantifier is not enough;
  the plan also requires that the file declares no `ArrayBuffer`
  (`isUnshadowedLibBinding`, factored out of `ambient-intrinsics.ts`).
- **Operands.** The length must be number-typed (a string, `undefined` or
  object length stays legacy, where ToPrimitive runs) and `maxByteLength` a
  number literal, so legacy's length-first evaluation order cannot be
  observed (#7121 review nit 2). Slice bounds are number-typed or
  `undefined` (the global, or a var initialized to it), resolved by the
  primitive classifier and name resolution, not the raw checker type. The
  `slice` bounds travel as the IR dynamic carrier, which is the externref the
  shared slice body ToNumbers — hence `!ctx.fast` in the availability check.
- **`{maxByteLength: undefined}`** builds a fixed buffer (§25.1.3.1
  GetArrayBufferMaxByteLengthOption). Legacy builds a resizable buffer with
  max 0 there; that is unchanged on the legacy route.
- **Script vars only.** `let` / `const` buffer bindings are not certified
  (their legacy slot is not the externref dynamic home). Certification is a
  least fixpoint, so `ab = ab.slice(1)` (a self-justifying write) stays legacy.
- **Use-site rule** is #7252's, shared: `scriptVarUseFollowsDeclaration`
  (renamed from `classInstanceUseFollowsDeclaration`), refusal arm
  `script-var-use-site` (was `class-instance-use-site`).
- The IR inliner splices the small adapters into their callers; the adapter
  functions stay in the module.

### Measurements

All base-vs-head, base = this branch's merge of `origin/main` before the change.

| Check | Result |
| --- | --- |
| Byte identity, playground corpus × gc / standalone / wasi | 39/39 rows identical (sha + imports) |
| Byte identity, 344 buffer test262 files (all `built-ins/ArrayBuffer` + 1/30 of DataView / TypedArray* / SharedArrayBuffer + 41 probes) × gc / standalone / wasi / standalone-noIR / wasi-noIR | 1720/1720 identical (raw compiles; legacy extraction is byte-neutral) |
| Wrapped ledger, stride 40, standalone | zero-legacy 32 → 35 (+3: the three target files); compileOk 1118 = 1118; invariants 0 = 0; `select:host-surface-unavailable` 20 → 8, `select:body-shape-rejected` 1921 → 1930 (9 DataView / transfer files now stop at their next blocker) |
| test262 A/B, all 221 `built-ins/ArrayBuffer` + 300 random (seed 7274), gc + standalone, plus wasi / standalone compile + imports | 1 fail → pass (`options-maxbytelength-undefined.js`), 0 regressions, 0 import or compile diffs; 12 ArrayBuffer files newly claim `<module-init>`, all pass |
| 41 adversarial probes (lengths NaN / -1 / 1.9 / 2^53 / "8" / undefined / absent; options non-object / max < len / "16" / -1 / NaN / `undefined`; no `new`; subclass; script shadow; detached via a legacy function; slice negative / out-of-range / fractional / undefined / chained; reads before the declaration; mixed construct-IR/member-legacy and the reverse; escapes as argument / array / view / typeof / ternary; parity `var n`, retyped `n`, `n >>> 28`) × gc / standalone / wasi | 1 standalone fail → pass (`{maxByteLength: undefined}` is now fixed-length on the IR route), every other cell identical; no post-claim demote |
| `tests/issue-7274-ir-native-arraybuffer.test.ts` | 10/10 |

Not measured: test262 for `--target wasi` (the runner has no wasi lane; compile, validation and imports were compared instead), and eval-dependent tests (the local QuickJS provider is not built; those fail identically on both sides).

### Adversarial review (fresh context, 2026-11-06)

Verdict on the first cut: quality goal not met. Fixed in this PR:

1. Number operands: from-ast accepted only f64 / signed i32 while the selector admitted any number-typed operand (`var n` in the dynamic home). Now one `toNumber` over `relOperandToF64`, and an un-lowerable certified operand is an invariant, not a demote. Slice bounds are restricted to number- or `undefined`-typed operands, for the same parity.
2. The capability row is now consulted once, in `planIrNativeBufferSurface`; plan presence is the only gate (the dead `true`, the resolver hook and the lowering re-check are gone).
3. Adapter minting: `ensureNamedHelperFunc` in `func-space.ts`, used by both adapter families (the Map copy is folded).
4. `isIrModuleNativeBufferValueKind` / `abiPinnedCapability` replace the inline capability comparisons.
5. The escape rule is the plan's own `consumesHandle` (threaded as `consumesCapabilityHandle`), not a looser AST walk in the value-kinds module.
6. The adapter names live once, in the shared contract, and type the `ADAPTERS` record.
7. The plan builder is split into `collectBufferSites` / `scriptVarCandidates` / `certifyBufferVars` / `planBufferOperations`.
8. `isUnshadowedUndefined` (ambient-intrinsics) replaces a new undefined predicate.
10. The unreachable reservation throw is gone; `ensureIrNativeBufferAdapter` returns a handle.
11. Explicit return type restored; the duplicated #5349 comment trimmed; `makeTaDynHelperFctx` → `makeHelperFctx` with a return-type parameter.

Rebutted:

9. One entry point instead of per-arm consultation: the extern-new / prop / call arms sit behind the host-extern capability and the extern-class registry, which is empty on these lanes, so a per-arm hook would add three copies of the same consult; a single plan lookup at the head of `isPhase1Expr` and `lowerExprUnchecked` keeps the selector and the builder symmetric by construction. The plan reads the checker directly, like its sibling `dom-capability.ts` (the oracle ratchet covers `src/codegen`). Availability reads the target profile's *environment* on purpose: the IR's provider-regime projection reports a JS-environment build as standalone, and that lane's output must stay byte-identical.

### Second review (RV7121, 2026-11-06): helper ownership

**Finding (P1).** `ensureNamedHelperFunc` accepted any same-name defined
function in `ctx.funcMap` as the requested helper. Source declarations share
that namespace, and the provider was then observed by name.

**Reproduction.** A script with an uncalled `function __ir_ab_byte_length(x)
{ return 777; }`, next to an IR-claimed `ab.byteLength`, failed to compile on
standalone ("callable provider … lost its defined allocator object"). Same
result for `__ir_ab_slice` with a different ABI.

**The Map family had the same defect on main.** A TS module with
`export function __ir_map_new()` next to a native-`Map` module binding failed
to compile on standalone before this change.

**Repair.**

- `ensureNamedHelperFunc` keeps a compiler-owned registry (per compile, the
  exact `WasmFunction` it minted). It never consults or writes `ctx.funcMap`.
- Both adapter families return their handles.
- `observeNativeRuntimeProvider` registers that exact handle, so the source
  function keeps its own `funcMap` entry and its own calls.

**Regressions added to `tests/issue-7274-*`:**

- a matching-ABI namesake and a different-ABI namesake (IR claim kept, test passes);
- a TS module asserting both the adapter's and the source function's results (8_003_777);
- the Map namesake (45);
- one definition per adapter across repeated sites.

**Known residual (not a regression).** In a TS *module*, the IR `<module-init>`
that uses these adapters demotes at prepared-component planning
(`unplanned-abi-binding`: the runtime adapters have no planning-time Program
ABI identity). The adapters are still minted, so such a module carries them
unused. Script files (test262) are unaffected.

## Slice 2 — DataView (2026-11-07, implemented)

Stacked on #7121 (a84cddb1). Base for every measurement below: a84cddb1.

### What was built

- **The plan is class-aware.** A certified var or producer is an
  `ArrayBuffer` or a `DataView`; `certifyBufferVars` records the class, and a
  member is admitted from a per-class table.
- **`src/ir/native-buffer-operands.ts`** (new): the admission table. It holds
  the member table per class, the operand kinds (`number`, `bound`, `flag`),
  and the construction shapes. These are pure source predicates; the plan
  (`native-buffer-surface.ts`) keeps receiver and var certification.
- **Construction.** `new DataView(buf[, off[, len]])`, where `buf` is a
  certified ArrayBuffer, lowers to `__ir_dv_new(externref, f64, externref)`.
  An omitted length is `undefined` ("to the end"). A view consumes its buffer,
  so the buffer producer is certified through it.
- **Getters.** `byteLength` and `byteOffset` lower to `__ir_dv_byte_length`
  and `__ir_dv_byte_offset`.
- **Accessors.** The 18 non-BigInt `get*`/`set*` lower to direct calls of
  legacy's own `__dv_m_<accessor>` helpers. No new adapter body is added;
  the helpers are now compiler-owned handles (`ownedHelperHandle` /
  `pushOwnedHelperFunc` in `func-space.ts`), not `ctx.funcMap` entries.
- **One implementation of each sequence.**
  - `src/codegen/buffers/data-view-native.ts` holds the construct emitters
    (brand check, offset ToIndex, detached check, bounds, length, window),
    cut from `new-indexed.ts`.
  - It also holds `dataViewByteAttrInstrs`, cut from
    `property-access-dispatch.ts`.
  - Legacy and the adapters both call them.
- **Statement-position setter.** `v.setUint8(0, 1);` reaches from-ast through
  `lowerMethodCallWithSourcePlan`, so that entry consults the plan too.
  Without it the certified call reached the builder as a capability-deferred
  extern call: an invariant.

Left on legacy: `buffer`, the BigInt accessors, a non-number offset (`"1"`),
an unconsumed construction (a `new DataView(...)` statement inside `try`), and
any var with a non-DataView write.

### Measurements

| Check | Result |
| --- | --- |
| Byte identity, raw compiles of all 561 `built-ins/DataView` files × gc / standalone / wasi / standalone-noIR / wasi-noIR | 2805/2805 identical (the legacy extraction is byte-neutral) |
| Byte identity, playground corpus × 3 lanes and the 344-file buffer corpus × 5 lanes, vs a84cddb1 and vs main | all identical |
| test262 A/B, all 561 `built-ins/DataView` + 221 `built-ins/ArrayBuffer` + 299 random, gc + standalone, plus wasi / standalone compile + imports | **0 status changes**, 0 compile or import differences; 52 files newly claim `<module-init>` on standalone, all 52 pass |
| Wrapped ledger, stride 40, standalone | zero-legacy 35 → 37 (+2: `DataView/prototype/byteLength/return-bytelength.js`, `DataView/prototype/getInt32/return-values.js`, the two slice-2 targets); compileOk 1118 = 1118; invariants 0 = 0; `select:body-shape-rejected` 1924 → 1922; no other reason moves |
| 31 adversarial probes × gc / standalone / wasi | every cell identical to base |
| `tests/issue-7274-ir-native-arraybuffer.test.ts` + `tests/issue-4461.test.ts` | 31/31 |

The probes cover:

- view windows;
- out-of-range, negative and fractional offsets;
- `undefined` and `NaN` lengths;
- every accessor width, with the little-endian flag absent, `undefined`, `0`
  or `1`;
- a setter's `undefined` result and `getUint8()` with no arguments;
- Float16 and BigInt;
- a detached buffer;
- a view over a `slice` result and a view over a non-buffer;
- a shadowed `DataView`;
- `__dv_m_*` and `__ir_dv_*` namesakes;
- reassignment and a mixed-class var;
- string values and offsets;
- `buffer`;
- a view over a resizable buffer.

**Mixed routes cannot be exercised, as in slice 1.** A user function that
reads or writes a certified var does not claim, so module-init then refuses on
`call-graph-closure`. In a TS module the script-var plan does not apply. The
five mixed probes therefore run legacy on both sides (identical to base); the
representation identity rests on the shared emitters and the shared slot.

### Adversarial review (fresh context, 2026-11-07)

Verdict on the first cut (c6131a0f): quality goal not met. Fixed in this PR:

1. **P1, selector/builder disagreement.** A certified var read as a plain
   value was admitted by the selector, then refused by from-ast. This is a
   post-claim demote: the selector claims `<module-init>`, from-ast fails,
   and the unit falls back to legacy with a warning. Probes:
   - `var j; j = v;` failed with "assignment to module binding … got
     extern<DataView>";
   - `var j = v;` failed with "initializer has no supported carrier".

   Slice 1 had the ArrayBuffer twin, `j = ab`, so its "no post-claim demote"
   row was wrong. The ledger's "invariants 0" does not count demotes.

   Fix: `phase1NativeBufferVerdict` now refuses any read of a native-buffer
   binding that the plan's `consumesHandle` does not cover
   (`expr-native-buffer-escape`). This is one rule for every position. The
   three probes are regressions in the test file.
2. **Accessor names had two sources of truth.** The contract re-listed
   legacy's `DV_ACCESSORS` keys, and `__dv_m_` was hard-coded at three sites.
   - The contract now owns `DATA_VIEW_ACCESSORS`: all 22, typed as
     `DataViewAccessor`.
   - Legacy's table is `Record<DataViewAccessor, DvAccessor>`, so the
     compiler checks the two agree.
   - `isDataViewAccessor` and `dataViewAccessorFn` are shared, and legacy
     builds helper names with them.
3. **The BigInt exclusion was policy living in the contract.** It moved to
   the admission table in `native-buffer-operands.ts`.
4. **Operations copied their member's fields** (`fn`, `result`, `arity`,
   `resultClass`). They now carry the table member itself.
5. **The plan was consulted twice for expression calls.** The extra hook in
   `lowerMethodCallWithSourcePlan` is now `lowerStatementMethodCall`, used only
   by the two statement entries that bypass `lowerExpr`.
6. **Dead exports.** Un-exported `ensureIrNativeBufferAdapter` and the adapter
   list; removed `isIrNativeDvAccessor`.
9. **Stale doc** on `tryLowerNativeBufferOperation`.
10. **Unchecked cast removed.** `accessOf` cast to a property access. The
    sites now keep each call's member access.

Rebutted or recorded:

7. **Operand evaluation order.** Legacy evaluates a DataView `byteLength`
   operand only after the detached and offset-bounds checks; the spec and the
   IR evaluate the whole argument list first. It is not observable on the IR
   route today (a side-effecting operand needs `try` or a call, neither of
   which claims here). It is recorded under Follow-ups.
8. **Redundant checks in the shared emitters.**
   - `__ir_dv_new` always runs the offset-bounds check, where legacy skips it
     with no offset; `0 > len` is never true, so this is behaviour-neutral.
   - The byte-attr adapter keeps the bare-vec branch, which a certified view
     never takes.
   - Both are the price of one emitter per sequence; an IR-only variant would
     duplicate it.

Reviewer's gap, confirmed: with the test262 harness, `--target wasi` never
claims `<module-init>` (`constructor-resolution-unsupported`). The wasi
adapters are covered by compile, validation and imports only.

## Follow-ups

- **Legacy `{maxByteLength: undefined}`** builds a resizable buffer with
  max 0 (`new-indexed.ts` treats any `maxByteLength` property as present);
  §25.1.3.1 GetArrayBufferMaxByteLengthOption says fixed-length. The IR
  route builds the fixed buffer, so the two routes differ here (measured:
  `options-maxbytelength-undefined.js` fails on legacy, passes on the IR).
- **Legacy resizable length rejects fractions.** `new ArrayBuffer(1.5,
  {maxByteLength: 4})` throws a RangeError (`emitResizableAbLength` tests
  `len != floor(len)`); ToIndex truncates. The shared emitter keeps legacy's
  behaviour on both routes.
- **Legacy `maxByteLength` clamps to 2^31-1** (`i32.trunc_sat_f64_s`)
  instead of throwing for a value past the i32-indexed backing, and the
  resizable length has no upper bound before `array.new_default` (a trap).
  Shared by both routes.
- **`ir-inline` recognises `__ir_map_*` by name** (`isAdapter`), so a source
  function with one of those names skips the inliner's size budget.
  Performance only (#7121 delta review, pre-existing).
- **`__ir_map_*` namesakes beside a real `Map` trap** with a null
  dereference on wasi/standalone, on main and on #7121's head alike (#7121
  delta review, pre-existing; the compile-failure half is fixed by #7121).
- **Legacy argument order.** Legacy validates the length before evaluating
  the `maxByteLength` expression; the spec evaluates the whole argument list
  first. The IR admits only a number-literal `maxByteLength`, so the
  difference is not observable on the IR route (#7121 review nit 2).

- **Known post-claim demote on main between #7121 and #7161.**
  - **What:** #7121 (slice 1) lets the selector claim a `<module-init>` that
    reads a certified ArrayBuffer var as a plain value: `var j; j = ab;` or
    `var j = ab;`. From-ast then refuses it, and the unit demotes to legacy
    with a warning.
  - **Impact:** the output is legacy's, so this is a demote, not a
    miscompile.
  - **Fix:** 1af545db (#7161). It refuses the read at selection
    (`expr-native-buffer-escape`) for both classes. The regression
    "an ArrayBuffer handle assignment" in `tests/issue-7274-*` covers it.
  - **Window:** from #7121's merge until #7161's.
- **Legacy DataView `byteLength` evaluation order.** Legacy evaluates the
  length operand after the detached / offset-bounds checks (never, when the
  offset is out of range); ArgumentListEvaluation evaluates it first. The
  IR follows the spec. Not yet observable on the IR route; it will be once
  `try` claims (slice-2 review finding 7). Filed as **#7316**.
- **A length-tracking DataView** over a resizable buffer keeps its
  construction-time length after `resize`. Both routes share the window
  emitter, so they agree, and both are wrong (RV7161 N6). Filed as **#7317**.
- **Known post-claim demote, newly reachable (RV7161 N4).**
  - **Repro:** a DataView module-init that also contains `throw <literal>`,
    e.g. `var v = new DataView(new ArrayBuffer(4)); try { throw 1; } catch (e) {}`.
  - **What happens:** the module-init is now claimed, then demotes with
    "throw val not in slice 9". The output is legacy's.
  - **Not slice-2 logic:** `var v = 4; try { throw 1 } catch (v) {}` demotes
    the same way on a84cddb1, with no buffer involved.
  - **Owner:** **#7318**. #7132 lists `throw 1` under "Not taken", and #7281
    (PR #7147) covers only the string-concat throw.
- **Wasi reach (RV7161 N5).** With the test262 harness, `--target wasi`
  rejects `<module-init>` at selection (`constructor-resolution-unsupported`),
  so the wasi adapters are only reached by non-harness programs today.
- **`DataView#buffer` and the BigInt accessors** stay on legacy (slice 2).
  `buffer` needs the window's backing as a certified ArrayBuffer handle; the
  BigInt accessors need a BigInt operand in the IR.
- **A shadowing `function DataView(b) { this.n = 1; }`** returns a native view
  on legacy (`v.n` is `undefined`), on main and on this branch alike. The IR
  refuses the shadowed constructor, so the route is legacy.

- **The 7 closure / object-literal files.** They need planned-closure bodies
  that can capture script vars and construct intrinsics (#7271 piece 1, lane
  R9), plus object-literal method closures.
