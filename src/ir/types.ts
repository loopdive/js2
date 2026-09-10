// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type {
  FuncHandle,
  GlobalHandle,
  TypeHandle,
  ValType,
  LocalDef,
  SourcePos,
  Instr,
  BlockType,
  CatchClause,
  TryTableCatch,
} from "../wasm/model/instructions.js";
export type {
  FuncHandle,
  GlobalHandle,
  TypeHandle,
  ValType,
  LocalDef,
  SourcePos,
  Instr,
  BlockType,
  CatchClause,
  TryTableCatch,
} from "../wasm/model/instructions.js";

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
  /**
   * A retained, explicitly encoded recursive type group used by separately
   * instantiated core-Wasm modules (#2527). The range addresses the flat
   * `types` table and is updated by any pass that compacts that table.
   */
  canonicalRuntimeRecGroup?: {
    start: number;
    end: number;
    abiVersion: number;
  };
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
   * An uninitialized optional numeric class field starts as JavaScript
   * `undefined`, represented in an f64 slot by the canonical signaling-NaN
   * sentinel rather than Wasm's numeric zero default.
   */
  undefinedDefault?: true;
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

export interface WasmFunction {
  name: string;
  typeIdx: TypeHandle;
  locals: LocalDef[];
  body: Instr[];
  exported: boolean;
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
