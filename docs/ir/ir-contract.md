# The IR interchange contract — v5.1

> **Normative.** The #3030 contract is the union of this document,
> [`ir-module.schema.json`](ir-module.schema.json), and the exported
> `IR_FORMAT_VERSION` in [`src/ir/contract.ts`](../../src/ir/contract.ts).
> Ratified 2026-07-04 (Fable, #3030-T1). The umbrella issue
> `plan/issues/3030-ir-interchange-contract.md` tracks the implementation
> slices (T2 index purge, T3 serializer, T4 verifier rules, T5 schema gate,
> T6 example consumer). Architecture context:
> [`../architecture/target-architecture.md`](../architecture/target-architecture.md)
> — this contract is the L3/L4 interchange boundary.

**Audience:** external consumers — other engines (e.g. SpiderMonkey deriving
types statically ahead-of-time instead of warming inline caches), analysis
tools, and out-of-tree backends (MLIR-class) — plus the in-tree slices that
implement the serializer/verifier against this text.

---

## D1 — Format: canonical JSON

One JSON document per compiled module.

- Top-level field `irVersion` (string, semver `MAJOR.MINOR`).
- **Deterministic serialization**: object keys in the fixed order the schema
  lists them; object-shape field lists are name-sorted (already canonical in
  the IR); arrays preserve program order. Re-serializing a deserialized
  module MUST be byte-identical (the T3 round-trip property).
- No floating-point canonicalization surprises: numbers serialize via JS
  `JSON.stringify` semantics; non-finite f64 constants serialize as the
  strings `"NaN"`, `"Infinity"`, `"-Infinity"` (JSON has no literals for
  them); negative zero serializes as the string `"-0"`.
- `i64` constants serialize as **decimal strings** (JSON numbers cannot carry
  64-bit integers losslessly).
- A binary encoding remains out of scope (JSON gzips well; modules
  are per-file).

## D2 — Versioning

`IR_FORMAT_VERSION = "5.1"` (exported from `src/ir/contract.ts`). Version 5.1
adds optional prepared callable providers on `forof.string` and oversized
`string.const` materialization; version 5.0 made global and symbolic type
references carry required closed structural bindings. Their `name` fields are
compatibility/debug metadata. Source-qualified class shapes from version 4,
callable bindings from version 3, and
function/coverage `unitId` fields from version 2 remain required.

- **Additive** (minor bump): new instruction kinds, new optional fields, new
  enum members appended at the END of their table.
- **Breaking** (major bump): removing/renaming a field or kind, reordering
  an enum table, changing any serialized representation.
- All enum tables in §"Frozen enum tables" are **append-only, frozen-order**
  (the #1852 linear-tag-enum discipline).
- The T5 CI snapshot gate fails any PR that changes the serialized shape
  without bumping `IR_FORMAT_VERSION`.
- A consumer MUST reject a document whose major version it does not know,
  and MAY accept an unknown minor version (ignoring unknown kinds/fields is
  NOT safe for analysis soundness — a consumer that needs soundness treats
  unknown instruction kinds as "function not analyzable").

## D3 — Guarantees (what a consumer may rely on)

1. **Typed block-argument SSA.** Every function is a list of basic blocks;
   block 0 is the entry and its block args are exactly the function params.
   Every SSA value has a single defining site (a block arg or an
   instruction `result`), definitions dominate uses, and every block ends
   with exactly one terminator. There are no Φ nodes — branches pass values
   into target block-arg slots.
2. **Structural function artifacts and references.** Functions and their
   coverage rows are joined by `unitId`. Every `IrFuncRef` identifies a source
   unit, import, runtime symbol, intrinsic, or compiler support binding through
   a closed `IrCallableBinding`; its `name` is compatibility/debug data only.
   Every `IrGlobalRef` and `IrTypeRef` likewise carries a closed structural
   binding ID. No funcIdx / globalIdx / typeIdx appears anywhere in a serialized
   document (D5 closes the one historical leak inside `IrType`; see T2).
3. **Verified per-instruction `resultType`.** Every value-producing
   instruction carries its result type, and the verifier **re-derives** it
   from operand types per the §"Node inventory" rules (#1924).
   ⚠ _Effectivity:_ this guarantee is **effective from verifier ≥ T4**. At
   T1 the rules are normative text; until T4 lands, `resultType` is
   producer-claimed and a consumer requiring soundness must not build on it.
4. **Explicit dynamic boundaries.** A value is either statically typed or
   `dynamic`. Every crossing is a serialized `box` / `unbox` / `tag.test`
   instruction carrying its `JsTag` partition (#2949 R1–R6). This is the
   AOT-type-derivation payload: a consumer reads exactly where dynamism
   enters and which partition proof guards each unbox.
5. **Ordered effects.** The per-kind effect classification (§"Effect
   classification") is part of this contract; instruction order within a
   block is program order, and any reordering the compiler performed
   respected the classification (#2134). Effects are _derived_ (published
   table), not serialized per instruction in v5.1.
6. **Source positions.** Instructions and terminators may carry
   `site: {line, column}` (1-based line, 0-based column, in the `source`
   file named by the header). Alloc-site provenance rides on `alloc`
   (module-global stable id, ADR-0013). Every serialized function also carries
   its canonical `IrUnitId`; the display name remains compatibility/debug data.
7. **Complete coverage manifest.** The document header lists EVERY function
   in the module with `carrier: "ir" | "legacy"`. Only `"ir"` functions
   have serialized bodies; the contract reports partial coverage explicitly
   while that coverage grows (#2855/#2950/#2949).

## D4 — Exclusions (never serialized)

Layout handles (`IrVecLowering` etc.), `BackendLegality` sets, the Wasm
`Instr` union, resolver/lowering state — anything below the L4 legalization
line. A consumer never sees a WasmGC struct index or a linear memory offset.

**The `raw.wasm` rule (serializability predicate).** The in-memory IR has an
escape-hatch instruction `raw.wasm` embedding backend `Instr` ops. Because
D4 forbids serializing those ops, **a function whose body (including nested
buffers) contains `raw.wasm` is NOT serializable**: it appears in the
coverage manifest as `carrier: "legacy"`, `reason: "raw-wasm-bridge"`, with
no body. `raw.wasm` therefore does NOT appear in the serialized instruction
inventory below.

**The slot-type rule.** Wasm-local slots (`IrSlotDef.type`) are restricted to
the closed scalar `val` set of D5 in serialized documents. A function whose
slots carry module-relative ref types is not serializable until T2
symbolizes them.

## D5 — The type story (serialized `IrType`)

The serialized `IrType` carries **no module-relative index**. Grammar
(discriminated on `kind`):

| kind      | payload                                                           | meaning                                                                                |
| --------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `val`     | `val: ScalarVal`, `signed?: boolean`                              | one concrete Wasm-level scalar/opaque-ref slot                                         |
| `string`  | —                                                                 | backend-agnostic string                                                                |
| `object`  | `shape: {fields: [{name, type}]}` (name-sorted)                   | structural object shape                                                                |
| `closure` | `signature: {params: IrType[], returnType: IrType}`               | callable value; captures are NOT a type property                                       |
| `class`   | `shape: {classId, className, fields, methods, constructorParams}` | nominal class instance (`classId` is the identity; `className` is diagnostic metadata) |
| `extern`  | `className: string`                                               | opaque host-class reference (RegExp, Map, Date, …)                                     |
| `union`   | `members: IrType[]`                                               | tagged scalar union (v1: homogeneous-width scalar members)                             |
| `boxed`   | `inner: IrType`                                                   | single-field heap cell (mutable-capture ref cell)                                      |
| `dynamic` | `tag?: JsTag`                                                     | statically-unknown JS value; optional proven partition refinement (erased at joins)    |

`ScalarVal` is the **closed** set of non-indexed leaves (append-only table):

```
i32 (+ optional boolean / symbol brands) · i64 (+ optional bigint brand)
f32 · f64 · v128 · i8 · i16 · funcref · externref · ref_extern · eqref · anyref
```

`ref` / `ref_null` leaves — which in the in-memory compiler still carry a
module-relative `typeIdx` (the #1926 residue) — serialize as **symbolic type
names**: `{"kind": "ref" | "ref_null", "name": "<IrTypeRef name>"}`. Indices
are resolved only at lowering, on the compiler side. Executing this purge in
the in-memory `IrType` is **T2**; until T2 lands, functions whose types
contain a `ref`/`ref_null` leaf are manifest-listed as `carrier: "legacy"`
(reason `"module-relative-type"`) rather than serialized with an index.
Brands (`signed`, `boolean`, `symbol`, `bigint`) serialize explicitly when
present.

## Reference domains

Function references are structural. `IrFuncRef.binding` is exactly one of:

- `unit {unitId}` — one source or compiler-created function artifact;
- `import {module, field}` — one declared module import;
- `runtime {symbol}` — one compiler runtime symbol;
- `intrinsic {symbol}` — one semantic intrinsic whose provider is selected
  below the IR boundary; or
- `support {bindingId}` — one compiler-owned support callable.

`IrFuncRef.name` is retained for compatibility and diagnostics but is excluded
from binding equality and semantic provider selection. Version-3 legacy
adapters may consult it only after resolving the structural binding domain, to
join an exact unit/support binding to a pre-existing physical slot; they may
not classify a callable or choose a provider from the label. Runtime,
intrinsic, and import resolution uses `symbol` or `{module, field}` directly.

`IrGlobalRef.binding` is one of `source {bindingId}`,
`import {bindingId,module,field}`, `runtime {bindingId,symbol}`, or
`support {bindingId}`. Every ID belongs to the `global` binding domain.
`IrTypeRef.binding` is one of `source {bindingId}`,
`class {bindingId,classId}`, `runtime {bindingId,symbol}`, or
`support {bindingId}`; ordinary IDs belong to the `type` domain and class
layout IDs to the `class` domain. Reference equality and provider selection
exclude the compatibility `name`.

The current in-memory numeric `ref`/`ref_null` leaves do not yet carry an
`IrTypeRef`; replacing those leaves is D5/T2. Version 5 closes the explicit
type-reference vocabulary and resolver boundary without claiming that T2 has
landed.

## Document layout

```
IrModuleDocument
├─ irVersion: "5.1"
├─ source?: string
├─ coverage: [{unitId, name, carrier: "ir"|"legacy", exported, reason?}]   (D3.7)
└─ functions: [IrFunctionDoc]           (exactly the carrier:"ir" entries)
   ├─ unitId, name, exported, funcKind?: "regular"|"generator"|"async"
   ├─ params: [{value: ValueId, name, type: IrType}]
   ├─ resultTypes: [IrType]
   ├─ slots?: [{index, name, type: ScalarVal-only ValType}]        (D4)
   ├─ valueCount: number
   └─ blocks: [IrBlock]                 (blocks[0] = entry)
      ├─ id, blockArgs: [ValueId], blockArgTypes: [IrType]
      ├─ instrs: [IrInstr]              (§ Node inventory)
      └─ terminator: return | br | br_if | unreachable
```

`ValueId`, `BlockId`, `LabelId`, `AllocSiteId` are non-negative integers.
`ValueId` scope is one function; `AllocSiteId` is module-global and stable
across transformations (ADR-0013).

**Constants** (`const.value`): `{kind: "i32"|"f32"|"f64", value: number}`
(f64 non-finite/−0 per D1), `{kind: "i64", value: "<decimal string>"}`,
`{kind: "bool", value: boolean}`, `{kind: "null", ty: IrType}`,
`{kind: "undefined"}`.

**Terminators:**

| kind          | fields                                           | rule                                                         |
| ------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| `return`      | `values: [ValueId]`                              | value types must equal `resultTypes` (arity + per-slot type) |
| `br`          | `branch: {target, args}`                         | arg types must equal the target block's `blockArgTypes`      |
| `br_if`       | `condition`, `ifTrue: branch`, `ifFalse: branch` | condition is `val:i32`; both branches type-check as `br`     |
| `unreachable` | —                                                | —                                                            |

## Node inventory + type rules

Notation: operands are SSA `ValueId`s; `τ(v)` is the (verified) type of `v`;
`⇒` gives the required `resultType`; `∅` = void (`result: null`). _Effects_
column keys into §"Effect classification". _Buffers_ lists nested
`IrInstr[]` regions (structured-IR, ADR-0018) in evaluation order. These
tables are the single source the T4 verifier implements — doc and verifier
must not diverge (T4 acceptance).

### Values, scalars, control expressions

| kind     | operands                             | immediates     | result rule                                                                                                                                                | effects         | buffers        |
| -------- | ------------------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------------- |
| `const`  | —                                    | `value: Const` | i32⇒`val:i32` · i64⇒`val:i64` · f32⇒`val:f32` · f64⇒`val:f64` · bool⇒`val:i32` · null⇒`value.ty` · undefined⇒producer-declared carrier (pinned by T4)      | pure            | —              |
| `binary` | `lhs`, `rhs`                         | `op: IrBinop`  | per-op: `f64.*` arith⇒`val:f64`; all comparisons⇒`val:i32`; `i32.and/or`⇒`val:i32`; `js.*`⇒`val:f64` (or `val:i32` when both operands i32-narrowed, #1126) | pure            | —              |
| `unary`  | `rand`                               | `op: IrUnop`   | `f64.*`⇒`val:f64` · `i32.eqz`⇒`val:i32` · `i32.trunc_sat_f64_s`⇒`val:i32` · `ref.is_null`⇒`val:i32`                                                        | pure            | —              |
| `select` | `condition`, `whenTrue`, `whenFalse` | —              | `τ(whenTrue) = τ(whenFalse)` ⇒ that type; condition `val:i32`; both arms evaluated (no short-circuit)                                                      | pure            | —              |
| `if`     | `cond`, `thenValue`, `elseValue`     | —              | short-circuiting value if; `τ(thenValue) = τ(elseValue) = resultType`; carrier values defined inside the matching arm                                      | join of buffers | `then`, `else` |

### Calls and module state

| kind         | operands | immediates          | result rule                                            | effects      |
| ------------ | -------- | ------------------- | ------------------------------------------------------ | ------------ |
| `call`       | `args[]` | `target: FuncRef`   | the bound callable's declared return type (∅ for void) | full barrier |
| `global.get` | —        | `target: GlobalRef` | the named global's declared type                       | reads heap   |
| `global.set` | `value`  | `target: GlobalRef` | ∅; `τ(value)` = global's type                          | writes heap  |
| `slot.read`  | —        | `slotIndex`         | `val` of the slot's declared ValType                   | slot-read    |
| `slot.write` | `value`  | `slotIndex`         | ∅; `τ(value)` = slot's declared type                   | slot-write   |

### Dynamic boundary (D3.4 — the AOT payload)

| kind       | operands | immediates                       | result rule                                                                                                                                                                 | effects |
| ---------- | -------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `box`      | `value`  | `toType: IrType`                 | ⇒ `toType`. union target: `τ(value)`'s ValType ∈ members. dynamic target: `τ(value)` NOT dynamic (re-box rejected)                                                          | pure    |
| `unbox`    | `value`  | `tag?: ValType`, `jsTag?: JsTag` | union operand: `tag` REQUIRED, ⇒ `val:tag`. dynamic operand: `jsTag` REQUIRED with a payload partition, ⇒ the partition's payload type. Caller must hold a `tag.test` proof | pure    |
| `tag.test` | `value`  | `tag?: ValType`, `jsTag?: JsTag` | ⇒ `val:i32` (1 = runtime tag matches). union operand: `tag` REQUIRED. dynamic operand: `jsTag` REQUIRED (any partition, incl. Null/Undefined)                               | pure    |

### Strings

| kind            | operands     | immediates        | result rule                              | effects |
| --------------- | ------------ | ----------------- | ---------------------------------------- | ------- |
| `string.const`  | —            | `value: string`, `storage?: GlobalRef`, `materializer?: FuncRef` | ⇒ `string`; storage and materializer are mutually exclusive | pure    |
| `string.concat` | `lhs`, `rhs` | —                 | operands `string` ⇒ `string`             | pure    |
| `string.eq`     | `lhs`, `rhs` | `negate: boolean` | operands `string` ⇒ `val:i32`            | pure    |
| `string.len`    | `value`      | —                 | operand `string` ⇒ `val:f64` (JS Number) | pure    |

### Objects, closures, ref cells, classes

| kind           | operands             | immediates                                                | result rule                                                                    | effects      |
| -------------- | -------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------ |
| `object.new`   | `values[]`           | `shape`                                                   | `values` parallel to `shape.fields` (arity + per-field type) ⇒ `object{shape}` | pure (alloc) |
| `object.get`   | `value`              | `name`                                                    | `τ(value)=object`, `name ∈ shape` ⇒ the field's type                           | reads heap   |
| `object.set`   | `value`, `newValue`  | `name`                                                    | ∅; `τ(newValue)` = field's type                                                | writes heap  |
| `closure.new`  | `captures[]`         | `liftedFunc: FuncRef`, `signature`, `captureFieldTypes[]` | `captures` parallel to `captureFieldTypes` ⇒ `closure{signature}`              | pure (alloc) |
| `closure.cap`  | `self`               | `index`                                                   | valid only in lifted bodies w/ `closureSubtype`; ⇒ `captureFieldTypes[index]`  | reads heap   |
| `closure.call` | `callee`, `args[]`   | —                                                         | `τ(callee)=closure`; args match `signature.params` ⇒ `signature.returnType`    | full barrier |
| `refcell.new`  | `value`              | —                                                         | ⇒ `boxed{inner: τ(value)}`                                                     | pure (alloc) |
| `refcell.get`  | `cell`               | —                                                         | `τ(cell)=boxed` ⇒ `cell.inner`                                                 | reads heap   |
| `refcell.set`  | `cell`, `value`      | —                                                         | ∅; `τ(value)` = `cell.inner`                                                   | writes heap  |
| `class.new`    | `args[]`             | `shape`                                                   | args match `shape.constructorParams` ⇒ `class{shape}`                          | full barrier |
| `class.get`    | `value`              | `fieldName`                                               | `τ(value)=class`, field ∈ shape ⇒ field type                                   | reads heap   |
| `class.set`    | `value`, `newValue`  | `fieldName`                                               | ∅; `τ(newValue)` = field type                                                  | writes heap  |
| `class.call`   | `receiver`, `args[]` | `methodName`                                              | method ∈ shape; args match method params ⇒ method returnType (∅ if null)       | full barrier |

### Vectors (arrays)

| kind            | operands       | immediates            | result rule                                                             | effects      |
| --------------- | -------------- | --------------------- | ----------------------------------------------------------------------- | ------------ |
| `vec.len`       | `vec`          | —                     | ⇒ `val:f64` (JS Number semantics)                                       | reads heap   |
| `vec.get`       | `vec`, `index` | —                     | `τ(index)=val:i32` ⇒ the vec's element type (= `resultType`)            | reads heap   |
| `vec.new_fixed` | `elements[]`   | `elementType: IrType` | every `τ(element)` = `elementType` ⇒ the vec ref type for `elementType` | pure (alloc) |

### Iteration + structured statement loops (buffers per ADR-0018)

| kind           | operands    | immediates                                    | result rule                                           | effects         | buffers                  |
| -------------- | ----------- | --------------------------------------------- | ----------------------------------------------------- | --------------- | ------------------------ |
| `forof.vec`    | `vec`       | `elementType`, slot indices, `loopLabel?`     | ∅                                                     | join of body    | `body`                   |
| `forof.iter`   | `iterable`  | slot indices, `loopLabel?`                    | ∅                                                     | full barrier    | `body`                   |
| `forof.string` | `str`       | slot indices, `provider?: FuncRef`, `loopLabel?` | ∅                                                   | join of body    | `body`                   |
| `while.loop`   | `condValue` | `loopLabel?`                                  | ∅; `τ(condValue)=val:i32`, defined in `cond`          | join of buffers | `cond`, `body`           |
| `for.loop`     | `condValue` | `loopLabel?`                                  | ∅; as `while.loop`                                    | join of buffers | `cond`, `body`, `update` |
| `br.label`     | —           | `label: LabelId`, `mode: "break"\|"continue"` | ∅; label must name an enclosing loop/labeled frame    | control         | —                        |
| `if.stmt`      | `cond`      | —                                             | ∅; `τ(cond)=val:i32`                                  | join of arms    | `then`, `else`           |
| `iter.new`     | `iterable`  | `async: boolean`                              | ⇒ `val:externref` (iterator object)                   | full barrier    | —                        |
| `iter.next`    | `iter`      | —                                             | ⇒ `val:externref` (IterResult); advances the iterator | full barrier    | —                        |
| `iter.done`    | `resultObj` | —                                             | ⇒ `val:i32`                                           | reads heap      | —                        |
| `iter.value`   | `resultObj` | —                                             | ⇒ `val:externref`                                     | reads heap      | —                        |
| `iter.return`  | `iter`      | —                                             | ∅ (protocol close)                                    | full barrier    | —                        |

### Generators / async

| kind            | operands  | result rule                                | effects      |
| --------------- | --------- | ------------------------------------------ | ------------ |
| `gen.push`      | `value`   | ∅ (yield one element into the buffer slot) | slot/heap    |
| `gen.epilogue`  | —         | ⇒ `val:externref` (the Generator object)   | full barrier |
| `gen.yieldStar` | `inner`   | delegated yield; per producer declaration  | full barrier |
| `await`         | `operand` | ⇒ the settled value's declared type        | control      |
| `async.return`  | `value`   | ∅ (wraps in resolved Promise)              | control      |
| `async.throw`   | `reason`  | ∅ (wraps in rejected Promise)              | control      |

### Extern (host-class) ops

| kind             | operands             | immediates              | result rule                         | effects                                                            |
| ---------------- | -------------------- | ----------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| `extern.new`     | `args[]`             | `className`             | ⇒ `extern{className}`               | full barrier                                                       |
| `extern.call`    | `receiver`, `args[]` | `className`, `method`   | per method table; producer-declared | full barrier                                                       |
| `extern.prop`    | `receiver`           | `className`, `property` | producer-declared                   | reads heap                                                         |
| `extern.propSet` | `receiver`, `value`  | `className`, `property` | ∅                                   | writes heap                                                        |
| `extern.regex`   | —                    | `pattern`, `flags`      | ⇒ `extern{RegExp}`                  | pure (alloc; may throw on bad pattern — see #2134 divergence note) |

### Exceptions, early exit, coercion

| kind                  | operands | immediates                                    | result rule                                      | effects         | buffers                                     |
| --------------------- | -------- | --------------------------------------------- | ------------------------------------------------ | --------------- | ------------------------------------------- |
| `throw`               | `value`  | —                                             | ∅ (does not fall through)                        | control         | —                                           |
| `try`                 | —        | `catchClause?: {payloadSlot}`, `finallyBody?` | ∅                                                | join of buffers | `body`, `catchClause.body?`, `finallyBody?` |
| `early.return`        | `value?` | —                                             | ∅; `τ(value)` matches `resultTypes` when present | control         | —                                           |
| `coerce.to_externref` | `value`  | —                                             | ⇒ `val:externref`                                | pure            | —                                           |

## Effect classification (D3.5 — published, derived)

The per-kind classification lives in code at `src/ir/effects.ts`
(`effectsOf`) and is part of this contract. Facets:

| facet                                   | meaning                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `readsHeap`                             | reads mutable heap state (fields, globals, elements, host objects)      |
| `writesHeap`                            | writes heap state or has arbitrary effects (calls, iterator advance)    |
| `control`                               | throw / await / async completion — may neither be reordered NOR dropped |
| `allSlots` / `readSlots` / `writeSlots` | Wasm-local slot conflicts, precise per index                            |

Guarantee: within a block, the serialized instruction order is a valid
program order under this classification. A consumer scheduling or reasoning
about the IR must respect the same table. Adding a facet or reclassifying a
kind is a versioned change (D2).

## Conformance

- **Syntax:** [`ir-module.schema.json`](ir-module.schema.json) (JSON Schema
  2020-12). It pins the document/coverage/function/block/type/const/
  terminator shapes precisely, and instructions to the frozen `kind` table +
  base shape (per-kind operand arity/typing is normative HERE and checked by
  the verifier — the schema is the cheap gate, the verifier the real one).
- **Semantics:** `verifyIrFunction` (`src/ir/verify.ts`) is the boundary's
  conformance checker; T4 makes it re-derive every rule in §"Node inventory"
  and runs it identically on deserialized modules. What the verifier
  enforces is exactly what a consumer may rely on.

## Frozen enum tables (append-only, frozen order — D2)

- **JsTag** (`src/codegen/js-tag.ts`): `Null=0, Undefined=1, NumberI32=2,
NumberF64=3, Boolean=4, String=5, Object=6, Function=7`.
- **IrBinop / IrUnop**: the unions in `src/ir/nodes.ts` (order as declared).
- **Instruction kinds**: the `IrInstr` union in `src/ir/nodes.ts` minus
  `raw.wasm` (D4), as enumerated in the schema's `kind` table.
- **IrType kinds**: `val, string, object, closure, class, extern, union,
boxed, dynamic`.
- **ScalarVal**: the D5 closed set.
- **Effect facets**: the table above.

## Slice status

| Slice | What                                                        | Status at v5.1                                               |
| ----- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| T1    | this document + schema + `IR_FORMAT_VERSION`                | **v5 structural callable/global/type identity** (#3520)      |
| T2    | purge module-relative indices from in-memory `IrType` (D5)  | open — until then, affected functions are `carrier:"legacy"` |
| T3    | `serializeIrModule`/`deserializeIrModule` + `--emit-ir`     | open                                                         |
| T4    | verifier re-derivation of the §Node-inventory rules (#1924) | open — D3.3 effective from here                              |
| T5    | schema snapshot CI gate                                     | open                                                         |
| T6    | `scripts/ir-type-summary.mjs` example consumer              | open                                                         |
