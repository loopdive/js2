// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { Instr, LocalDef, ValType, WasmModule } from "../ir/types.js";
import type { ClassLayout } from "./layout.js";

export interface LinearStringLiteralData {
  readonly offset: number;
  readonly bytes: readonly number[];
  readonly cacheGlobalIdx: number;
}

/** Module-level context for linear-memory codegen */
export interface LinearContext {
  mod: WasmModule;
  checker: ts.TypeChecker;
  /** Map from function name to its absolute index (imports + locals) */
  funcMap: Map<string, number>;
  /** Number of imported functions */
  numImportFuncs: number;
  /**
   * Declared signatures of extern-C imports, by import field name (#4539).
   *
   * Present only for names declared via `LinearOptions.externImports`. The
   * call path uses it to marshal at the boundary: this backend compiles a TS
   * `number` to f64, so an import declaring `i32` needs an explicit
   * conversion in each direction. Absent name ⇒ an ordinary internal call.
   */
  externImportSigs?: Map<string, { index: number; params: ValType[]; results: ValType[] }>;
  /** Current function context (set during function compilation) */
  currentFunc: LinearFuncContext | null;
  /** Errors accumulated during codegen */
  errors: { message: string; line: number; column: number }[];
  /** Class layouts for class declarations */
  classLayouts: Map<string, ClassLayout>;
  /** String literal data segment: string value → relocatable bytes + assigned artifact offset. */
  stringLiterals: Map<string, LinearStringLiteralData>;
  /** Current data segment write offset */
  dataSegmentOffset: number;
  /**
   * Linked mode only (#4540): index of the `__rodata_bias` global holding
   * `runtimeDataBase - linkTimeDataBase`. When set, every literal reference is
   * emitted as `bias + <link-time offset>` instead of a bare constant, because
   * the literal image is copied into a block obtained from the engine's
   * allocator rather than written at a link-time address we do not own.
   * Undefined in standalone mode, where the emitted bytes are unchanged.
   */
  roDataBiasGlobalIdx?: number;
  /** Counter for generating unique lambda function names */
  lambdaCounter: number;
  /** Function indices to populate in the funcref table */
  tableEntries: number[];
  /** Global index for __closure_env (env pointer for closures) */
  closureEnvGlobalIdx: number;
  /** Module-level variables → wasm global index */
  moduleGlobals: Map<string, number>;
  /** Module-level collection types (for Set, Map, Array globals) */
  moduleCollectionTypes: Map<string, CollectionKind>;
}

/** Collection type tag for tracking variable types */
export type CollectionKind = "Array" | "Uint8Array" | "ArrayOrUint8Array" | "Map" | "Set";

/** (#2716) A `finally` block pending replay on early-exit paths out of its try. */
export interface FinallyEntry {
  /** The `finally` block statements to replay. */
  block: ts.Block;
  /** `breakStack.length` at try-entry — used to decide if a `break` replays it. */
  breakDepth: number;
  /** `continueStack.length` at try-entry — used to decide if a `continue` replays it. */
  continueDepth: number;
}

/** Per-function context for linear-memory codegen */
export interface LinearFuncContext {
  /** Function name */
  name: string;
  /** Parameters (the first N locals) */
  params: { name: string; type: ValType }[];
  /** Additional locals declared in the body */
  locals: LocalDef[];
  /** All local names → index (params first, then locals) */
  localMap: Map<string, number>;
  /** Return type */
  returnType: ValType | null; // null = void
  /** Accumulated body instructions */
  body: Instr[];
  /** Block depth for br labels */
  blockDepth: number;
  /** Break label depth stack */
  breakStack: number[];
  /** Continue label depth stack */
  continueStack: number[];
  /**
   * (#2716) Stack of enclosing `try { … } finally { … }` blocks whose `finally`
   * must run on every completion path out of the try. Normal fall-through runs
   * the finally inline; `return` / `break` / `continue` replay the applicable
   * finally blocks before the jump. Each entry records the break/continue
   * nesting at try-entry so a `break`/`continue` only replays the finallys that
   * sit BETWEEN it and its target loop/switch.
   */
  finallyStack: FinallyEntry[];
  /** Track which locals are collection types (varName → kind) */
  collectionTypes: Map<string, CollectionKind>;
  /** Parameters that are callback/function-typed (param name → call_indirect type index) */
  callbackParams: Map<string, number>;
}

/** Add a local variable to the current function context */
export function addLocal(fctx: LinearFuncContext, name: string, type: ValType): number {
  const index = fctx.params.length + fctx.locals.length;
  fctx.locals.push({ name, type });
  fctx.localMap.set(name, index);
  return index;
}
