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

1. **ArrayBuffer**, files 1–3:
   - construct `(n)`, `(n, {})`, `(n, {maxByteLength: e})`;
   - `byteLength`, `maxByteLength`, `resizable`, `slice(a[, b])`.
2. **DataView**, files 4–6:
   - construct `(buf[, off[, len]])`;
   - `byteLength`, `byteOffset`, `buffer`, and all `get*/set*` with an
     optional little-endian argument.
3. **SharedArrayBuffer**, file 7: construct `()` / `(n)`, `byteLength`.

### Expected zero-legacy delta (stated before coding)

- **Bounded maximum:** +7 files on the stride, rows 1–7 above.
- **Likely range:** 5–7.
  - Row 6 depends on `Symbol("1")` lowering in module-init.
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
