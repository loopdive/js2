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

## Follow-ups

- **The 7 closure / object-literal files.** They need planned-closure bodies
  that can capture script vars and construct intrinsics (#7271 piece 1, lane
  R9), plus object-literal method closures.
