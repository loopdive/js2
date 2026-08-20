// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// ---------------------------------------------------------------------------
// Stable module-index handles (#2710 — late-bind module indices).
//
// `FuncHandle` / `GlobalHandle` / `TypeHandle` name the three module index
// spaces whose *live positions* shift when late imports / string-constant
// globals are appended, or DCE removes type/func entries. Instructions and type
// defs reference functions / globals / types through these named types so that
// — in a later slice — a single `resolveLayout()` pass becomes the sole place a
// concrete final index is assigned (at serialization), eliminating the whole
// class of "a baked index went stale when the index space changed" bugs.
//
// SLICE 1 (this change): the three are *transparent aliases* of `number` — zero
// runtime change, fully interchangeable with `number`, so the tree stays
// `tsc`-clean AND every emitted byte is identical (proven by
// `scripts/prove-emit-identity.mjs`). Their only job here is to (a) establish
// the vocabulary and (b) pin it onto the correct, discriminated union arms.
// Crucially `GlobalHandle` is applied ONLY to `global.{get,set}`, NOT to
// `local.{get,set,tee}`: locals are function-scoped and never shift, and
// `src/emit/binary.ts` already discriminates on `op` at the encode seams, so
// the global arms can later dereference while the local arms pass through raw.
//
// A LATER SLICE promotes these to true branded types, e.g.
//   `type FuncHandle = number & { readonly __func: unique symbol }`
// At that point `tsc` mechanically enumerates every remaining positional read
// (`mod.functions[h]`, `h - numImportFuncs`, `h + delta`) as a compile error —
// the structural guard that makes the bug class unreachable by construction.
// Branding now (transparently) keeps that future flip to a one-line change here.
// ---------------------------------------------------------------------------
export type FuncHandle = number;
export type GlobalHandle = number;
export type TypeHandle = number;

export interface ExternClassMeta {
  importPrefix: string;
  namespacePath: string[];
  className: string;
  constructorParams: ValType[];
  methods: Map<string, { params: ValType[]; results: ValType[] }>;
  properties: Map<string, { type: ValType; readonly: boolean }>;
}

export interface WasmModule {
  types: TypeDef[];
  imports: Import[];
  functions: WasmFunction[];
  exports: WasmExport[];
  tables: Table[];
  elements: Element[];
  globals: GlobalDef[];
  tags: TagDef[];
  stringPool: string[];
  /** Extern class metadata (for .d.ts and imports helper generation) */
  externClasses: ExternClassMeta[];
  /** Node builtin module names detected from imports (#1044) */
  nodeBuiltinModules: Set<string>;
  /**
   * Exact compiler-owned platform-capability import allocators.
   *
   * Import names and signatures are public ABI and therefore cannot prove
   * who allocated a slot: user source can deliberately declare the same
   * spelling.  This sidecar keys the actual module import object so later
   * capability/Program-ABI planning can distinguish a certified provider
   * slot from an ambient look-alike without serializing mutable authority.
   */
  platformCapabilityImportProvenance?: Map<Import, { readonly capabilityId: string; readonly providerId: string }>;
  /**
   * JSX runtime import specifier detected during import preprocessing (#1540).
   * `"react/jsx-runtime"` by default; `preact/jsx-runtime`, etc. for other
   * configured `jsxImportSource` values. Recorded so the import manifest
   * classifier can attach it to `jsx_runtime` ImportIntent entries.
   */
  jsxImportSource?: string;
  /** Map from import func name → string literal value (e.g. "__str_0" → "Hello") */
  stringLiteralValues: Map<string, string>;
  /** Set of function names that are async (for .d.ts generation) */
  asyncFunctions: Set<string>;
  /** Function indices referenced by ref.func that need declarative element segments */
  declaredFuncRefs: FuncHandle[];
  /**
   * #1916 S3 — stable-regime handle resolution table: ordinal → position in
   * `functions`. A stable handle `STABLE_FUNC_BASE + ordinal` (see
   * src/emit/resolve-layout.ts) is minted at registration and its position is
   * recorded here at push time (`pushDefinedFunc`, src/codegen/func-space.ts).
   * Lives on the module (not the codegen context) so mod-only passes
   * (stack-balance, fixups, dead-elim, emit) can resolve handles.
   */
  funcOrdinalToPosition: number[];
  /** Linear memory definitions */
  memories: { min: number; max?: number }[];
  /**
   * Data segments for linear memory (string literals, etc.).
   *
   * `passive` (#4540): a passive segment carries **no address**. It is not
   * written at instantiation; the module copies it somewhere it OWNS with
   * `memory.init`. That distinction is load-bearing in the ADR-0020 link
   * topology, where the memory belongs to the engine artifact: an ACTIVE
   * segment writes at its link-time offset straight through whatever the
   * engine has there (measured: the artifact's shadow stack is [0, 65536) and
   * its static data [65536, 170392), so our default bases at 64 / 1024 /
   * 16384 all land inside them). `offset` is ignored for passive segments and
   * is kept only so the array element type stays uniform.
   */
  dataSegments: { offset: number; bytes: Uint8Array; passive?: boolean }[];
  /** Whether the module has top-level executable statements (module init code) */
  hasTopLevelStatements?: boolean;
  /** Wasm start function index — runs automatically on instantiation (#907) */
  startFuncIdx?: FuncHandle;
  /**
   * Per-export TS-level type annotations (#1700). Surfaced so the JS-host
   * `wrapExports` can faithfully marshal `Uint8Array` (and other TypedArray)
   * params/results that share the same Wasm signature as `number[]`. Keyed
   * by export name. Only populated for exports whose params/result reference
   * TypedArray types.
   */
  exportSignatures?: Record<string, ExportSignature>;
  /**
   * Codegen diagnostics produced while lowering this module (#1868). The
   * linear-memory backend (`generateLinearModule` / `generateLinearMultiModule`)
   * accumulates unsupported-construct errors into its `ctx.errors` array; it
   * surfaces them here so `compiler.ts` can fail the compile instead of
   * emitting a structurally invalid binary (e.g. a stack-underflowing
   * `local.set` after an unhandled `String.prototype.repeat`).
   */
  codegenErrors?: { message: string; line: number; column: number; severity?: "error" | "warning" | "degrade" }[];
  /**
   * (#3009) Host imports dropped by the strict `--no-host-imports` gate
   * (`addImport` under `ctx.strictNoHostImports`). The gate drops the import
   * and pushes a `degrade` diagnostic, but a producer that baked the dropped
   * import's (now `undefined`) function index into a helper body — e.g.
   * console.log's native-string extern bridge `__str_to_extern` calling the
   * dropped `__str_from_mem` / `__str_to_mem` / `__str_extern_len` — would then
   * hit `absoluteFuncIndex` with `funcIdx=undefined` and crash with an opaque
   * "stable handle undefined (ordinal NaN)" internal error. Recorded here so
   * finalize-time handle resolution can turn that crash into a clean, actionable
   * leak diagnostic that NAMES the dropped-and-coupled host import(s). Lives on
   * the module (not the codegen context) because the emit/resolve chokepoints
   * that dereference baked handles only have `mod`.
   */
  strictDroppedHostImports?: { module: string; name: string }[];
}

/** TS-level kind hint for a single export parameter or result (#1700). */
export type TypedArrayKind = "uint8array" | "typed-array" | "other";

/** Source-level value kind that needs an explicit JS/Wasm boundary adapter. */
export type ExportBoundaryKind = TypedArrayKind | "string" | "symbol" | "promise" | "dynamic" | "aggregate";

/** TS-level boundary classification of one export's params and result. */
export interface ExportSignature {
  /** Per-parameter boundary kind, positionally. */
  params: ExportBoundaryKind[];
  /** Boundary kind of the return value. */
  result: ExportBoundaryKind;
}

export type TypeDef = FuncTypeDef | StructTypeDef | ArrayTypeDef | RecGroupDef | SubTypeDef;

export interface FuncTypeDef {
  kind: "func";
  name?: string;
  params: ValType[];
  results: ValType[];
}
export interface StructTypeDef {
  kind: "struct";
  name: string;
  fields: FieldDef[];
  /** Type index of the parent struct (for class inheritance sub-typing) */
  superTypeIdx?: TypeHandle;
  /** When true and superTypeIdx is set, emit sub_final instead of sub (leaf types in hierarchy) */
  final?: boolean;
}
export interface ArrayTypeDef {
  kind: "array";
  name: string;
  element: ValType;
  mutable: boolean;
}
export interface RecGroupDef {
  kind: "rec";
  types: TypeDef[];
}
export interface SubTypeDef {
  kind: "sub";
  name: string;
  superType: TypeHandle | null;
  final: boolean;
  type: StructTypeDef | ArrayTypeDef | FuncTypeDef;
}
export interface FieldDef {
  name: string;
  type: ValType;
  mutable: boolean;
  /**
   * The field's constructor initializer is a call proven to return the native
   * open `$Object` carrier (for example acorn's `this.options = getOptions()`).
   * This is an optimisation hint only: consumers must keep the canonical
   * dynamic fallback because the mutable field may subsequently be replaced.
   */
  dynamicObjectCarrier?: true;
  /**
   * The physical carrier was inferred as numeric, but whole-program source
   * analysis proved every definition/write produces a JS boolean (#2847).
   * Kept separate from ValType so finalize-time host boxing can recover the
   * boolean without changing the already-emitted struct storage ABI.
   */
  jsBoolean?: true;
  /**
   * This source property is only assigned on conditional/loop paths. A hidden
   * companion slot records per-instance own-property presence so an untouched
   * default slot is distinguishable from an explicit null/zero assignment.
   */
  presenceTracked?: true;
  /**
   * (#3780) Bit index of this field's presence flag inside the struct's packed
   * presence words. Only set together with {@link presenceTracked}. The word
   * holding it is the field named `$presence_<bit >>> 5>`; the mask is
   * `1 << (bit & 31)`. Packing matters for allocation volume: acorn's `Node`
   * carries 63 conditionally-assigned properties, which as one `i32` slot each
   * cost 252 bytes of every AST node — roughly half the object.
   */
  presenceBit?: number;
}

export type ValType =
  // (#1788) `boolean` and (#2785) `symbol` are structural-only BRANDS on the
  // overloaded `i32` carrier (the same idea as `bigint` on `i64`): every
  // `.kind === "i32"` check still matches, so branded values keep bare-i32
  // codegen. The brand is consulted at the BOX site (`coerceType(i32 →
  // externref)`) to pick the type-correct helper — `__box_boolean` /
  // `__box_symbol` instead of `__box_number` — so a boolean (`i32` 1) is not
  // boxed as the number 1 and a symbol HANDLE (`i32` id) is not boxed as a
  // number. Keep both brands optional + inert.
  | { kind: "i32"; boolean?: true; symbol?: true }
  | { kind: "i64"; bigint?: boolean }
  | { kind: "f32" }
  // (#2864 wave-2 S1) `undefSentinel` is the same kind of structural-only BRAND
  // on the `f64` carrier: it marks an f64 that was read out of a slot which
  // genuinely CAN hold `undefined` (today: a native generator's IteratorResult
  // `value` field, whose UNDEF_F64_BITS pattern MEANS undefined — see
  // value-tags.ts). Every `.kind === "f64"` check still matches, so numeric
  // codegen is byte-identical; the brand is consulted only at the BOX site
  // (`coerceType(f64 → externref)`) to pick sentinel-aware boxing instead of a
  // bare `__box_number`. This is deliberately NOT a change to the generic f64
  // box, whose #3315 note is correct: an ARBITRARY f64 carrying the sentinel
  // bits is a computed NaN (`Math.abs` preserves the payload) and must stay a
  // number. The brand is exactly the "dedicated identity-carrying slot" seam
  // that note points at. Keep it optional + inert.
  | { kind: "f64"; undefSentinel?: true }
  | { kind: "v128" }
  | { kind: "i8" }
  | { kind: "i16" }
  | { kind: "ref"; typeIdx: TypeHandle }
  | { kind: "ref_null"; typeIdx: TypeHandle }
  | { kind: "funcref" }
  | { kind: "externref" }
  | { kind: "ref_extern" }
  | { kind: "eqref" }
  | { kind: "anyref" };

export interface WasmFunction {
  name: string;
  typeIdx: TypeHandle;
  locals: LocalDef[];
  body: Instr[];
  exported: boolean;
}

export interface LocalDef {
  name: string;
  type: ValType;
}

/** Source position for source map generation */
export interface SourcePos {
  file: string;
  line: number;
  column: number;
}

type InstrBase =
  // locals are function-scoped and never shift — they stay raw `number`.
  | { op: "local.get"; index: number }
  | { op: "local.set"; index: number }
  | { op: "local.tee"; index: number }
  // globals share the `index` field name with locals but live in the module
  // index space, so they carry a GlobalHandle (binary.ts discriminates on `op`).
  | { op: "global.get"; index: GlobalHandle }
  | { op: "global.set"; index: GlobalHandle }
  | { op: "i32.const"; value: number }
  | { op: "i64.const"; value: bigint }
  | { op: "i64.add" }
  | { op: "i64.sub" }
  | { op: "i64.mul" }
  | { op: "i64.div_s" }
  | { op: "i64.div_u" }
  | { op: "i64.rem_s" }
  | { op: "i64.rem_u" }
  | { op: "i64.eq" }
  | { op: "i64.ne" }
  | { op: "i64.lt_s" }
  | { op: "i64.lt_u" }
  | { op: "i64.le_s" }
  | { op: "i64.le_u" }
  | { op: "i64.gt_s" }
  | { op: "i64.gt_u" }
  | { op: "i64.ge_s" }
  | { op: "i64.ge_u" }
  | { op: "i64.eqz" }
  | { op: "i64.and" }
  | { op: "i64.or" }
  | { op: "i64.xor" }
  | { op: "i64.shl" }
  | { op: "i64.shr_s" }
  | { op: "i64.shr_u" }
  | { op: "i64.extend_i32_s" }
  | { op: "i64.extend_i32_u" }
  | { op: "i64.trunc_f64_s" }
  | { op: "i64.reinterpret_f64" }
  | { op: "i32.reinterpret_f32" }
  | { op: "f32.reinterpret_i32" }
  | { op: "f64.convert_i64_s" }
  | { op: "f64.convert_i64_u" } // (#3173) DataView getBigUint64 — unsigned i64 → f64
  | { op: "f64.reinterpret_i64" }
  | { op: "f64.const"; value: number }
  | { op: "f32.const"; value: number }
  | { op: "i32.add" }
  | { op: "i32.sub" }
  | { op: "i32.mul" }
  | { op: "i32.eq" }
  | { op: "i32.ne" }
  | { op: "i32.lt_s" }
  | { op: "i32.le_s" }
  | { op: "i32.gt_s" }
  | { op: "i32.ge_s" }
  | { op: "i32.ge_u" }
  | { op: "i32.eqz" }
  | { op: "i32.and" }
  | { op: "i32.or" }
  | { op: "i32.xor" }
  | { op: "i32.shl" }
  | { op: "i32.shr_s" }
  | { op: "i32.shr_u" }
  | { op: "i32.clz" }
  | { op: "i32.wrap_i64" }
  | { op: "i32.trunc_f64_u" }
  | { op: "i32.trunc_sat_f64_s" }
  | { op: "i32.trunc_sat_f64_u" }
  | { op: "i64.trunc_sat_f64_s" }
  | { op: "f64.add" }
  | { op: "f64.sub" }
  | { op: "f64.mul" }
  | { op: "f64.div" }
  | { op: "f64.eq" }
  | { op: "f64.ne" }
  | { op: "f64.lt" }
  | { op: "f64.le" }
  | { op: "f64.gt" }
  | { op: "f64.ge" }
  | { op: "f64.sqrt" }
  | { op: "f64.abs" }
  | { op: "f64.neg" }
  | { op: "f64.floor" }
  | { op: "f64.ceil" }
  | { op: "f64.trunc" }
  | { op: "f64.nearest" }
  | { op: "f64.copysign" }
  | { op: "f64.min" }
  | { op: "f64.max" }
  | { op: "i32.trunc_f64_s" }
  | { op: "f64.convert_i32_s" }
  | { op: "f64.convert_i32_u" }
  | { op: "block"; blockType: BlockType; body: Instr[] }
  | { op: "loop"; blockType: BlockType; body: Instr[] }
  | { op: "if"; blockType: BlockType; then: Instr[]; else?: Instr[] }
  | { op: "br"; depth: number }
  | { op: "br_if"; depth: number }
  // #2952 slice 4 — full payload (was a stub the encoder rejected, #1939):
  // pops an i32 selector; branches to targets[selector], or defaultDepth
  // when the selector is out of range. Field names match the depth-bump
  // walker in codegen/statements/exceptions.ts (targets / defaultDepth).
  | { op: "br_table"; targets: number[]; defaultDepth: number }
  | { op: "return" }
  | { op: "end" }
  | { op: "call"; funcIdx: FuncHandle }
  | { op: "return_call"; funcIdx: FuncHandle }
  | { op: "call_indirect"; typeIdx: TypeHandle; tableIdx: number }
  | { op: "drop" }
  | { op: "select" }
  | { op: "unreachable" }
  | { op: "nop" }
  | { op: "struct.new"; typeIdx: TypeHandle }
  | { op: "struct.get"; typeIdx: TypeHandle; fieldIdx: number }
  | { op: "struct.set"; typeIdx: TypeHandle; fieldIdx: number }
  | { op: "array.new"; typeIdx: TypeHandle }
  | { op: "array.new_fixed"; typeIdx: TypeHandle; length: number }
  | { op: "array.new_default"; typeIdx: TypeHandle }
  | { op: "array.get"; typeIdx: TypeHandle }
  | { op: "array.get_s"; typeIdx: TypeHandle }
  | { op: "array.get_u"; typeIdx: TypeHandle }
  | { op: "array.set"; typeIdx: TypeHandle }
  | { op: "array.len" }
  | { op: "array.copy"; dstTypeIdx: TypeHandle; srcTypeIdx: TypeHandle }
  | { op: "array.fill"; typeIdx: TypeHandle }
  | { op: "ref.null"; typeIdx: TypeHandle }
  | { op: "ref.null.extern" }
  | { op: "ref.null.eq" }
  | { op: "ref.null.func" }
  | { op: "ref.is_null" }
  | { op: "ref.as_non_null" }
  | { op: "ref.cast"; typeIdx: TypeHandle }
  | { op: "ref.cast_null"; typeIdx: TypeHandle }
  | { op: "ref.test"; typeIdx: TypeHandle }
  | { op: "ref.eq" }
  | { op: "ref.func"; funcIdx: FuncHandle }
  | { op: "call_ref"; typeIdx: TypeHandle }
  | { op: "return_call_ref"; typeIdx: TypeHandle }
  | { op: "memory.size" }
  | { op: "memory.grow" }
  // Bulk memory (#4540). `memory.init` copies from a PASSIVE data segment to a
  // runtime-chosen destination — the mechanism that lets linked-mode literal
  // data live at an address we allocated instead of a link-time constant.
  // Stack: [dest:i32, src_offset:i32, len:i32] -> []
  | { op: "memory.init"; dataIdx: number }
  | { op: "data.drop"; dataIdx: number }
  // Bulk memory, the other half (#4540 own-allocator slice). A real `calloc`
  // must zero and a real `realloc` must relocate; hand-written byte loops for
  // either put an interpreter loop on the allocator's hot path. Neither of
  // these names a data segment, so neither needs the data-count section.
  // Stack: memory.copy [dest:i32, src:i32, len:i32] -> []
  //        memory.fill [dest:i32, byte:i32, len:i32] -> []
  | { op: "memory.copy" }
  | { op: "memory.fill" }
  | { op: "try"; blockType: BlockType; body: Instr[]; catches: CatchClause[]; catchAll?: Instr[] }
  | { op: "try_table"; blockType: BlockType; body: Instr[]; catches: TryTableCatch[] }
  | { op: "throw"; tagIdx: number }
  | { op: "rethrow"; depth: number }
  | { op: "any.convert_extern" }
  | { op: "extern.convert_any" }
  // (#3673) i31 small-int boxing — ref.i31: i32 -> (ref i31); i31.get_s:
  // (ref null i31) -> i32. Abstract-heap-type ref.test/ref.cast reuse the
  // existing variants with typeIdx = I31_HEAP_TYPE (-20).
  | { op: "ref.i31" }
  | { op: "i31.get_s" }
  // Memory load/store (linear memory)
  | { op: "i32.load"; align: number; offset: number }
  | { op: "i32.load8_u"; align: number; offset: number }
  | { op: "i32.load8_s"; align: number; offset: number }
  | { op: "i32.load16_u"; align: number; offset: number }
  | { op: "i32.store"; align: number; offset: number }
  | { op: "i64.store"; align: number; offset: number }
  | { op: "i32.store8"; align: number; offset: number }
  | { op: "i32.store16"; align: number; offset: number }
  // Integer division and remainder
  | { op: "i32.div_u" }
  | { op: "i32.div_s" }
  | { op: "i32.rem_u" }
  | { op: "i32.rem_s" }
  // Unsigned comparisons (complements existing i32.lt_s etc.)
  | { op: "i32.lt_u" }
  | { op: "i32.le_u" }
  | { op: "i32.gt_u" }
  // f64 memory load/store (linear memory)
  | { op: "f64.load"; align: number; offset: number }
  | { op: "f64.store"; align: number; offset: number }
  // f32 memory load/store and conversion (linear memory)
  | { op: "f32.load"; align: number; offset: number }
  | { op: "f32.store"; align: number; offset: number }
  | { op: "f32.demote_f64" }
  | { op: "f64.promote_f32" }
  // SIMD v128 instructions
  | { op: "v128.const"; bytes: Uint8Array }
  | { op: "v128.load"; align: number; offset: number }
  | { op: "v128.store"; align: number; offset: number }
  | { op: "v128.not" }
  | { op: "v128.and" }
  | { op: "v128.andnot" }
  | { op: "v128.or" }
  | { op: "v128.xor" }
  | { op: "v128.bitselect" }
  | { op: "v128.any_true" }
  // i8x16
  | { op: "i8x16.splat" }
  | { op: "i8x16.extract_lane_s"; lane: number }
  | { op: "i8x16.extract_lane_u"; lane: number }
  | { op: "i8x16.replace_lane"; lane: number }
  | { op: "i8x16.eq" }
  | { op: "i8x16.ne" }
  | { op: "i8x16.all_true" }
  | { op: "i8x16.bitmask" }
  | { op: "i8x16.swizzle" }
  | { op: "i8x16.shuffle"; lanes: number[] }
  | { op: "i8x16.add" }
  | { op: "i8x16.sub" }
  | { op: "i8x16.min_u" }
  | { op: "i8x16.max_u" }
  // i16x8
  | { op: "i16x8.splat" }
  | { op: "i16x8.extract_lane_s"; lane: number }
  | { op: "i16x8.extract_lane_u"; lane: number }
  | { op: "i16x8.replace_lane"; lane: number }
  | { op: "i16x8.eq" }
  | { op: "i16x8.ne" }
  | { op: "i16x8.lt_s" }
  | { op: "i16x8.gt_s" }
  | { op: "i16x8.all_true" }
  | { op: "i16x8.bitmask" }
  | { op: "i16x8.add" }
  | { op: "i16x8.sub" }
  | { op: "i16x8.mul" }
  | { op: "i16x8.shl" }
  | { op: "i16x8.shr_u" }
  // i32x4
  | { op: "i32x4.splat" }
  | { op: "i32x4.extract_lane"; lane: number }
  | { op: "i32x4.replace_lane"; lane: number }
  | { op: "i32x4.eq" }
  | { op: "i32x4.ne" }
  | { op: "i32x4.all_true" }
  | { op: "i32x4.bitmask" }
  | { op: "i32x4.add" }
  | { op: "i32x4.sub" }
  | { op: "i32x4.mul" }
  | { op: "i32x4.shl" }
  | { op: "i32x4.shr_s" }
  | { op: "i32x4.shr_u" }
  // i64x2
  | { op: "i64x2.splat" }
  | { op: "i64x2.extract_lane"; lane: number }
  | { op: "i64x2.replace_lane"; lane: number }
  | { op: "i64x2.add" }
  | { op: "i64x2.sub" }
  | { op: "i64x2.mul" }
  | { op: "i64x2.eq" }
  | { op: "i64x2.ne" }
  // f32x4
  | { op: "f32x4.splat" }
  | { op: "f32x4.extract_lane"; lane: number }
  | { op: "f32x4.replace_lane"; lane: number }
  | { op: "f32x4.eq" }
  | { op: "f32x4.add" }
  | { op: "f32x4.sub" }
  | { op: "f32x4.mul" }
  | { op: "f32x4.div" }
  // f64x2
  | { op: "f64x2.splat" }
  | { op: "f64x2.extract_lane"; lane: number }
  | { op: "f64x2.replace_lane"; lane: number }
  | { op: "f64x2.eq" }
  | { op: "f64x2.ne" }
  | { op: "f64x2.add" }
  | { op: "f64x2.sub" }
  | { op: "f64x2.mul" }
  | { op: "f64x2.div" }
  // SIMD load/store lane
  | { op: "v128.load8_splat"; align: number; offset: number }
  | { op: "v128.load16_splat"; align: number; offset: number }
  | { op: "v128.load32_splat"; align: number; offset: number }
  | { op: "v128.load64_splat"; align: number; offset: number }
  | { op: "v128.load32_zero"; align: number; offset: number }
  | { op: "v128.load64_zero"; align: number; offset: number };

export type Instr = InstrBase & { sourcePos?: SourcePos };

export type BlockType = { kind: "empty" } | { kind: "val"; type: ValType } | { kind: "type"; typeIdx: TypeHandle };

export interface CatchClause {
  tagIdx: number;
  body: Instr[];
}

/** A standardized exception-handling clause attached to `try_table`. */
export interface TryTableCatch {
  kind: "catch" | "catch_ref" | "catch_all" | "catch_all_ref";
  /** Present for the tagged `catch` / `catch_ref` forms. */
  tagIdx?: number;
  /** Relative label depth of the enclosing handler block. */
  depth: number;
}

export interface TagDef {
  name: string;
  /** Type index of the tag's function signature (params = exception values) */
  typeIdx: TypeHandle;
}

export interface Import {
  module: string;
  name: string;
  desc: ImportDesc;
}
export type ImportDesc =
  | { kind: "func"; typeIdx: TypeHandle }
  | { kind: "table"; elementType: string; min: number; max?: number }
  | { kind: "global"; type: ValType; mutable: boolean }
  | { kind: "memory"; min: number; max?: number }
  | { kind: "tag"; typeIdx: TypeHandle };

export interface WasmExport {
  name: string;
  desc: { kind: "func" | "table" | "memory" | "global" | "tag"; index: number };
}
export interface Table {
  elementType: string;
  min: number;
  max?: number;
}
export interface Element {
  tableIdx: number;
  offset: Instr[];
  funcIndices: FuncHandle[];
}
export interface GlobalDef {
  name: string;
  type: ValType;
  mutable: boolean;
  init: Instr[];
}

export function createEmptyModule(): WasmModule {
  return {
    types: [],
    imports: [],
    functions: [],
    exports: [],
    tables: [],
    elements: [],
    globals: [],
    tags: [],
    stringPool: [],
    externClasses: [],
    nodeBuiltinModules: new Set(),
    platformCapabilityImportProvenance: new Map(),
    stringLiteralValues: new Map(),
    asyncFunctions: new Set(),
    declaredFuncRefs: [],
    funcOrdinalToPosition: [],
    memories: [],
    dataSegments: [],
  };
}
