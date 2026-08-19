// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts, forEachChild } from "../ts-api.js";
import type { MultiTypedAST, TypedAST } from "../checker/index.js";
import type { BuildIrUnitInventoryOptions } from "../ir/identity.js";
import type { FuncTypeDef, Instr, ValType, WasmModule } from "../ir/types.js";
import {
  countImportedFuncs,
  declareExternCImports,
  declareImportedMemory,
  emitExternCBoundaryArg,
  emitExternCBoundaryResult,
  type ExternCImportSpec,
  resolveExternCValType,
} from "./c-abi.js";
import { createEmptyModule } from "../ir/types.js";
import { linearAllocatorPolicy, type LinearAllocatorPolicyId } from "../ir/analysis/linear-memory-plan.js";
import * as linearIr from "../ir/backend/linear-integration.js";
import { compileResolvedArrayPointer, emitResolvedArrayLocal } from "./array-pointer.js";
import type { CollectionKind, FinallyEntry, LinearContext, LinearFuncContext } from "./context.js";
import { addLocal } from "./context.js";
import type { ClassLayout } from "./layout.js";
import { computeClassLayout } from "./layout.js";
import * as linearCoercion from "./coercion-engine.js";
import { finalizeLinearArena } from "./export-arena.js";
import * as numberFormat from "./number-format.js";
import { addLinearStackArenaRuntime } from "./runtime-stack-arena.js";
import { compileLinearStringMethodCall } from "./string-methods.js";
import { addLinearStringRepeatRuntime, sourceMayUseLinearStringRepeat } from "./string-repeat.js";
import {
  addArrayRuntime,
  addFmodRuntime,
  addLinearIrVecRuntime,
  addLinearIrStringRuntime,
  addMapRuntime,
  addNumericMapRuntime,
  addNumericSetRuntime,
  addRuntime,
  addSetRuntime,
  addStringRuntime,
  addUint8ArrayRuntime,
  FMOD_FN,
} from "./runtime.js";
import {
  finalizeLinkedDataImage,
  LINKED_ARENA_DEFAULT_CHUNK_BYTES,
  type LinkedHeapOptions,
  RODATA_BIAS_GLOBAL,
} from "./linked-arena.js";
import { linearStringLiteralInstrs } from "./string-literals.js";

/** Type tag for class instances in linear memory */
const CLASS_TYPE_TAG = 5;

/**
 * Data segment base address — must be below HEAP_START (1024).
 *
 * **Standalone mode only** (#4540). In linked mode the segment is PASSIVE and
 * this value stops being an address: it becomes the base the literal offsets
 * were assigned from, which `__rodata_bias` corrects at runtime. An active
 * segment at 64 would be written at instantiation into the memory owner's
 * shadow stack, before any instruction of ours runs. See ADR-0022.
 */
const DATA_SEGMENT_BASE = 64;

function isUint8ArrayTypeText(text: string): boolean {
  return /^Uint8Array(?:<.*>)?$/.test(text.replace(/\s+/g, ""));
}

function isNumberArrayOrUint8ArrayUnionText(text: string): boolean {
  const parts = text.split("|").map((part) => part.trim());
  return parts.length === 2 && parts.includes("number[]") && parts.some(isUint8ArrayTypeText);
}

function sourceMayUseLinearIrStringRuntime(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(node) && (node.name.text === "charAt" || node.name.text === "charCodeAt")) {
      found = true;
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * Extract a 1-based {line, column} from an AST node for diagnostics (#1937).
 * Mirrors the GC backend's extractLocation (src/codegen/context/errors.ts);
 * falls back to {0,0} for synthetic nodes without a source file.
 */
function nodeLoc(node: ts.Node): { line: number; column: number } {
  try {
    const sf = node.getSourceFile();
    if (sf) {
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      return { line: line + 1, column: character + 1 };
    }
  } catch {
    // fall through to {0,0}
  }
  return { line: 0, column: 0 };
}

/**
 * Options for the linear-memory backend (#1856).
 */
export interface LinearOptions {
  /**
   * Enable conservative exported-call reclamation and expose the explicit
   * arena-management exports `__arena_reset` / `__arena_used`. Only modules
   * with primitive boundaries and no heap-backed globals are auto-wrapped;
   * others retain the monotonic arena so escaped pointers stay live.
   * See {@link import("./runtime.js").ArenaOptions}.
   */
  exposeArenaReset?: boolean;
  /** Shared IR allocation policy. Direct-backend fallbacks remain arena-backed. */
  allocationPolicy?: LinearAllocatorPolicyId;
  irInventoryOptions?: BuildIrUnitInventoryOptions;
  /**
   * External C functions this module calls (#4539). Declared before any
   * defined function so indices are stable; see `declareExternCImports`.
   */
  externImports?: readonly ExternCImportSpec[];
  /**
   * Import linear memory from another module instead of defining one — the
   * ADR-0020 link topology, where the engine artifact owns the memory.
   */
  importMemory?: {
    module: string;
    name: string;
    min: number;
    max?: number;
    /** memory64 index type (#4554). Refused for now; see declareImportedMemory. */
    indexType?: "i32" | "i64";
  };
  /**
   * Linked-mode heap (#4540) — REQUIRED whenever {@link importMemory} is set.
   *
   * Names the extern-C import that provides the host allocator. `__malloc` then
   * bump-allocates inside chunks carved from it and never calls `memory.grow`,
   * so the memory's owner stays its only grower.
   *
   * It is required rather than optional because the alternative is the measured
   * failure this option exists to remove: with a memory we do not own and the
   * standalone arena, `__heap_ptr` starts at 1024 — inside the pinned
   * artifact's 64 KiB shadow stack — so the first allocation writes through the
   * engine's stack. Making that combination unrepresentable is the fix; a
   * default would just move the trap.
   */
  linkedHeap?: {
    /** Name of the extern-C import providing `malloc(size: i32) -> ptr: i32`. */
    mallocImport: string;
    /** Bytes per carved chunk (default: one Wasm page). */
    chunkBytes?: number;
  };
  /**
   * Which allocator backs the heap (#4557).
   *
   * `"malloc-v1"` emits the real allocator — free lists, boundary tags,
   * coalescing, in-place `realloc` — and exports `js2wasm_malloc` /
   * `js2wasm_calloc` / `js2wasm_free` / `js2wasm_realloc` /
   * `js2wasm_usable_size` so the QuickJS artifact can install them through
   * `JS_NewRuntime2`. `__malloc` keeps its bump fast path; only the source of
   * its chunks moves, from the engine's heap to ours.
   *
   * Defaults to `"bump"`, which is #4540's shipped fallback and the reason it
   * was kept: if the measured comparison against the artifact's dlmalloc does
   * not hold, this option is simply not set.
   */
  heapAllocator?: "bump" | "malloc-v1";
}

/**
 * Resolve {@link LinearOptions.linkedHeap} into the runtime's concrete form,
 * and make the catastrophic combination unrepresentable (#4540).
 *
 * `importMemory` without `linkedHeap` is the measured corruption: the arena
 * would start bump-allocating at 1024, inside the memory owner's shadow stack.
 * `linkedHeap` without `importMemory` is meaningless — we own the memory, so
 * there is no host allocator to defer to. Both are refused here, before any
 * bytes exist, rather than diagnosed later from a corrupted heap.
 */
function resolveLinkedHeap(
  opts: LinearOptions,
  externImportIndices: Map<string, number>,
): LinkedHeapOptions | undefined {
  if (!opts.importMemory && !opts.linkedHeap) return undefined;
  if (opts.importMemory && !opts.linkedHeap) {
    throw new Error(
      "generateLinearModule: importMemory was set without linkedHeap. A module that does not own " +
        "its memory must carve its arena from the owner's allocator; the standalone arena would " +
        "start allocating at a fixed low address inside the owner's shadow stack (#4540).",
    );
  }
  if (opts.linkedHeap && !opts.importMemory) {
    throw new Error(
      "generateLinearModule: linkedHeap was set without importMemory. Carving from a host " +
        "allocator only makes sense when another module owns the address space (#4540).",
    );
  }
  const { mallocImport, chunkBytes } = opts.linkedHeap!;
  const mallocFuncIdx = externImportIndices.get(mallocImport);
  if (mallocFuncIdx === undefined) {
    throw new Error(
      `generateLinearModule: linkedHeap.mallocImport '${mallocImport}' is not among externImports. ` +
        "Declare it (params [i32], results [i32]) so the arena can call it (#4540).",
    );
  }
  return { mallocFuncIdx, chunkBytes: chunkBytes ?? LINKED_ARENA_DEFAULT_CHUNK_BYTES };
}

/**
 * Generate a WasmModule using the linear-memory backend.
 * Compiles TS functions to standard Wasm with i32/f64 values.
 */
export function generateLinearModule(ast: TypedAST, opts: LinearOptions = {}): WasmModule {
  const mod = createEmptyModule();
  // #4539 — imports FIRST, before any runtime function exists. A function's
  // index is `numImportFuncs + position`, so a later import would shift every
  // index; `declareExternCImports` throws rather than allow that. With no
  // imports requested this is a no-op and emitted output is unchanged.
  if (opts.importMemory) {
    const { module, name, min, max, indexType } = opts.importMemory;
    declareImportedMemory(mod, module, name, min, max, indexType);
  }
  const externImportIndices = declareExternCImports(mod, opts.externImports ?? []);
  // The index lives here rather than only in funcMap because an ambient
  // `declare function` of the same name is later registered as a user
  // function and would overwrite the funcMap entry — silently retargeting the
  // call at a body-less local slot with a TS-derived (f64) signature. Keeping
  // the extern binding in its own map makes it authoritative.
  // Types are RESOLVED through the address model here (#4554) so every later
  // consumer — the call site's boundary marshalling included — sees concrete
  // Wasm types and never has to re-decide how wide a handle is.
  const externImportSigs = new Map<string, { index: number; params: ValType[]; results: ValType[] }>();
  for (const spec of opts.externImports ?? []) {
    const index = externImportIndices.get(spec.name);
    if (index === undefined) continue;
    externImportSigs.set(spec.name, {
      index,
      params: spec.params.map((t) => resolveExternCValType(t)),
      results: spec.results.map((t) => resolveExternCValType(t)),
    });
  }
  const allocationPolicy = linearAllocatorPolicy(opts.allocationPolicy ?? "arena-v1");
  const linkedHeap = resolveLinkedHeap(opts, externImportIndices);
  const dataSegmentBase = numberFormat.addRuntime(
    mod,
    ast,
    opts.exposeArenaReset,
    DATA_SEGMENT_BASE,
    linkedHeap,
    opts.heapAllocator,
  );

  // Add memory and runtime functions first
  if (allocationPolicy.id === "analysis-stack-arena-v1") addLinearStackArenaRuntime(mod);
  addUint8ArrayRuntime(mod);
  addArrayRuntime(mod);
  addStringRuntime(mod);
  if (sourceMayUseLinearStringRepeat(ast.sourceFile)) addLinearStringRepeatRuntime(mod);
  addMapRuntime(mod);
  addSetRuntime(mod);
  addNumericMapRuntime(mod);
  addNumericSetRuntime(mod);
  addFmodRuntime(mod); // #2144 — exact f64 remainder for the `%` arm
  // #2956 L2: construction needs one value-first indexed store helper.
  // Register it only for the overlay so the explicit `=0` escape hatch stays
  // byte-identical to the pre-IR direct backend.
  if (linearIr.linearIrEnabled()) {
    addLinearIrVecRuntime(mod);
    // The UTF-16 decoder is sizeable and only the charCodeAt plan needs it.
    // Register before user-slot assignment when the source can request it.
    if (sourceMayUseLinearIrStringRuntime(ast.sourceFile)) addLinearIrStringRuntime(mod);
  }

  // Add __closure_env global (mutable i32, init 0) for closure support
  const closureEnvGlobalIdx = mod.globals.length;
  mod.globals.push({
    name: "__closure_env",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });

  // #4540 — linked mode rebases every literal reference through one global.
  // It must exist BEFORE any function is compiled, because each literal site
  // reads its index while being emitted. Not created in standalone mode, so
  // that lane's global layout (and emitted bytes) is untouched.
  let roDataBiasGlobalIdx: number | undefined;
  if (linkedHeap !== undefined) {
    roDataBiasGlobalIdx = mod.globals.length;
    mod.globals.push({
      name: RODATA_BIAS_GLOBAL,
      type: { kind: "i32" },
      mutable: true,
      init: [{ op: "i32.const", value: 0 }],
    });
  }

  const ctx: LinearContext = {
    mod,
    checker: ast.checker,
    funcMap: new Map(),
    // #4539 — derived, not hard-coded. Zero when nothing is imported, so
    // output is unchanged for every existing caller.
    numImportFuncs: countImportedFuncs(mod),
    currentFunc: null,
    errors: [],
    classLayouts: new Map(),
    stringLiterals: new Map(),
    dataSegmentOffset: dataSegmentBase,
    lambdaCounter: 0,
    tableEntries: [],
    closureEnvGlobalIdx,
    moduleGlobals: new Map(),
    moduleCollectionTypes: new Map(),
    externImportSigs: externImportSigs.size > 0 ? externImportSigs : undefined,
    ...(roDataBiasGlobalIdx !== undefined ? { roDataBiasGlobalIdx } : {}),
  };

  // #4539 — extern imports are callable by name. They occupy indices [0, n),
  // so registering them here lets the ordinary call path resolve them; the
  // signature map drives boundary marshalling at each call site.
  for (const spec of opts.externImports ?? []) {
    const idx = externImportIndices.get(spec.name);
    if (idx !== undefined) ctx.funcMap.set(spec.name, idx);
  }

  // Register runtime functions in funcMap
  for (let i = 0; i < mod.functions.length; i++) {
    ctx.funcMap.set(mod.functions[i].name, ctx.numImportFuncs + i);
  }

  // ── Class declaration pass: scan for classes and compute layouts ──
  const classDecls: ts.ClassDeclaration[] = [];
  for (const stmt of ast.sourceFile.statements) {
    if (ts.isClassDeclaration(stmt) && stmt.name) {
      classDecls.push(stmt);
      scanClassDeclaration(ctx, stmt);
    }
  }

  // ── Forward-register all functions: class ctors/methods first, then top-level ──
  const allFuncEntries: { kind: "ctor" | "method" | "func"; node: ts.Node; name: string; className?: string }[] = [];

  for (const classDecl of classDecls) {
    const className = classDecl.name!.text;
    const layout = ctx.classLayouts.get(className)!;

    const ctorDecl = classDecl.members.find(ts.isConstructorDeclaration);
    allFuncEntries.push({ kind: "ctor", node: ctorDecl ?? classDecl, name: layout.ctorFuncName, className });

    // Methods
    for (const member of classDecl.members) {
      if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
        const methodName = member.name.text;
        const wasmMethodName = `${className}_${methodName}`;
        layout.methods.set(methodName, wasmMethodName);
        allFuncEntries.push({ kind: "method", node: member, name: wasmMethodName, className });
      }
      // Getter accessors
      if (ts.isGetAccessorDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
        const getterName = member.name.text;
        const wasmGetterName = `${className}_get_${getterName}`;
        layout.getters.set(getterName, wasmGetterName);
        allFuncEntries.push({ kind: "method", node: member, name: wasmGetterName, className });
      }
    }
  }

  // Top-level function declarations
  const funcDecls: ts.FunctionDeclaration[] = [];
  for (const stmt of ast.sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      funcDecls.push(stmt);
      allFuncEntries.push({ kind: "func", node: stmt, name: stmt.name.text });
    }
  }

  const runtimeFuncCount = ctx.mod.functions.length;
  const linearIrLegacySlots = [];
  const isIrTerminal = linearIr.terminalPredicate(ast.sourceFile, ast.checker, opts.irInventoryOptions);
  for (let i = 0; i < allFuncEntries.length; i++) {
    const entry = allFuncEntries[i];
    const funcIdx = ctx.numImportFuncs + runtimeFuncCount + i;
    ctx.funcMap.set(entry.name, funcIdx);
    if (isIrTerminal(entry.node))
      linearIrLegacySlots.push({ declaration: entry.node, legacyName: entry.name, funcIdx });
  }

  // ── Collect module-level variable declarations as wasm globals ──
  collectModuleGlobals(ctx, ast.sourceFile);

  // ── Compile class constructors and methods ──
  for (const classDecl of classDecls) {
    compileClassDeclaration(ctx, classDecl);
  }

  // ── #2956: IR overlay for selector-claimed top-level functions ──
  // Default-on since L4. Run after exact slot registration and module-global
  // collection, but before top-level body insertion. Demotions retain the
  // direct path and JS2WASM_LINEAR_IR=0 remains the escape hatch.
  const linearIrResult = linearIr.linearIrEnabled()
    ? linearIr.compileLinearIr(ctx, ast.sourceFile, allocationPolicy, linearIrLegacySlots, opts.irInventoryOptions)
    : undefined;

  // ── Compile top-level function declarations ──
  for (const decl of funcDecls) {
    const irArtifact = linearIrResult?.compiledArtifactFor(decl);
    if (irArtifact) {
      const { func: irFunc, legacySlot } = irArtifact;
      // Insert the IR-lowered body at this decl's slot position (push order
      // must match the forward-registered funcMap indices). Mirror
      // compileFunction's export record.
      ctx.mod.functions.push(irFunc);
      if (irFunc.exported) {
        ctx.mod.exports.push({
          name: irFunc.name,
          desc: { kind: "func", index: legacySlot.funcIdx },
        });
      }
      continue;
    }
    compileFunction(ctx, decl);
  }

  // Aggregate/ref-cell helpers follow every user slot, keeping funcMap stable
  // while IR lowering discovers object shapes lazily.
  for (const helper of linearIrResult?.helpers ?? []) {
    const actualFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    if (actualFuncIdx !== helper.funcIdx) {
      throw new Error(
        `linear-ir: deferred helper slot mismatch for '${helper.name}' (expected ${helper.funcIdx}, got ${actualFuncIdx})`,
      );
    }
    ctx.mod.functions.push(linearIr.materializeLinearIrHelper(ctx, helper));
  }

  // ── Emit data segments for string literals ──
  numberFormat.emitLinearStringData(ctx, dataSegmentBase);
  finalizeLinearArena(mod, ast, opts.exposeArenaReset);

  emitClosureTable(ctx);

  // #4540 — LAST, so the start function's index is stable: every earlier
  // finalizer may still append functions, and a start index computed before
  // them would name someone else's body.
  if (roDataBiasGlobalIdx !== undefined) {
    finalizeLinkedDataImage(mod, roDataBiasGlobalIdx, dataSegmentBase);
  }

  // Surface codegen diagnostics so compiler.ts fails the compile rather than
  // emitting a structurally invalid binary for unsupported constructs (#1868).
  if (ctx.errors.length > 0) mod.codegenErrors = ctx.errors;

  return mod;
}

/**
 * Generate a WasmModule from multiple TS source files using the linear-memory backend.
 * Cross-file imports are resolved by the TypeScript checker; we iterate all source files.
 */
export function generateLinearMultiModule(multiAst: MultiTypedAST, opts: LinearOptions = {}): WasmModule {
  const mod = createEmptyModule();

  addRuntime(mod, { exposeArenaReset: opts.exposeArenaReset });
  addUint8ArrayRuntime(mod);
  addArrayRuntime(mod);
  addStringRuntime(mod);
  if (multiAst.sourceFiles.some(sourceMayUseLinearStringRepeat)) addLinearStringRepeatRuntime(mod);
  addMapRuntime(mod);
  addSetRuntime(mod);
  addNumericMapRuntime(mod);
  addNumericSetRuntime(mod);
  addFmodRuntime(mod); // #2144 — exact f64 remainder for the `%` arm

  // Add __closure_env global for closure support
  const closureEnvGlobalIdx = mod.globals.length;
  mod.globals.push({
    name: "__closure_env",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });

  const ctx: LinearContext = {
    mod,
    checker: multiAst.checker,
    funcMap: new Map(),
    // #4539 — derived, not hard-coded. Zero when nothing is imported, so
    // output is unchanged for every existing caller.
    numImportFuncs: countImportedFuncs(mod),
    currentFunc: null,
    errors: [],
    classLayouts: new Map(),
    stringLiterals: new Map(),
    dataSegmentOffset: DATA_SEGMENT_BASE,
    lambdaCounter: 0,
    tableEntries: [],
    closureEnvGlobalIdx,
    moduleGlobals: new Map(),
    moduleCollectionTypes: new Map(),
  };

  // Register runtime functions in funcMap
  for (let i = 0; i < mod.functions.length; i++) {
    ctx.funcMap.set(mod.functions[i].name, ctx.numImportFuncs + i);
  }

  // ── Class declaration pass: scan all source files ──
  const classDecls: ts.ClassDeclaration[] = [];
  for (const sf of multiAst.sourceFiles) {
    for (const stmt of sf.statements) {
      if (ts.isClassDeclaration(stmt) && stmt.name) {
        classDecls.push(stmt);
        scanClassDeclaration(ctx, stmt);
      }
    }
  }

  // ── Forward-register all functions across all files ──
  const allFuncEntries: {
    kind: "ctor" | "method" | "func";
    node: ts.Node;
    name: string;
    className?: string;
    isEntry: boolean;
  }[] = [];

  for (const classDecl of classDecls) {
    const className = classDecl.name!.text;
    const layout = ctx.classLayouts.get(className)!;
    const isEntry = classDecl.getSourceFile() === multiAst.entryFile;

    allFuncEntries.push({ kind: "ctor", node: classDecl, name: layout.ctorFuncName, className, isEntry });

    for (const member of classDecl.members) {
      if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
        const methodName = member.name.text;
        const wasmMethodName = `${className}_${methodName}`;
        layout.methods.set(methodName, wasmMethodName);
        allFuncEntries.push({ kind: "method", node: member, name: wasmMethodName, className, isEntry });
      }
      if (ts.isGetAccessorDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
        const getterName = member.name.text;
        const wasmGetterName = `${className}_get_${getterName}`;
        layout.getters.set(getterName, wasmGetterName);
        allFuncEntries.push({ kind: "method", node: member, name: wasmGetterName, className, isEntry });
      }
    }
  }

  // Top-level functions across all source files
  const funcDeclsByFile: { decl: ts.FunctionDeclaration; isEntry: boolean }[] = [];
  for (const sf of multiAst.sourceFiles) {
    const isEntry = sf === multiAst.entryFile;
    for (const stmt of sf.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        funcDeclsByFile.push({ decl: stmt, isEntry });
        allFuncEntries.push({ kind: "func", node: stmt, name: stmt.name.text, isEntry });
      }
    }
  }

  // Assign function indices
  const runtimeFuncCount = ctx.mod.functions.length;
  for (let i = 0; i < allFuncEntries.length; i++) {
    const entry = allFuncEntries[i];
    const funcIdx = ctx.numImportFuncs + runtimeFuncCount + i;
    ctx.funcMap.set(entry.name, funcIdx);
  }

  // ── Collect module-level variable declarations as wasm globals ──
  for (const sf of multiAst.sourceFiles) {
    collectModuleGlobals(ctx, sf);
  }

  // ── Compile class constructors and methods ──
  for (const classDecl of classDecls) {
    compileClassDeclaration(ctx, classDecl);
  }

  // ── Collect re-exported names from entry file ──
  // e.g. `export { link } from "./linker.js"` in the entry file
  const reExportedNames = new Set<string>();
  for (const stmt of multiAst.entryFile.statements) {
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const spec of stmt.exportClause.elements) {
        reExportedNames.add(spec.name.text);
      }
    }
  }
  // ── Compile top-level functions (only export entry file's exports) ──
  for (const { decl, isEntry } of funcDeclsByFile) {
    compileFunctionMulti(ctx, decl, isEntry, reExportedNames);
  }

  // ── Fix up function indices after lambda insertion ──
  // Lambdas generated during compilation are inserted into mod.functions,
  // which shifts indices of subsequently compiled functions. Rebuild the
  // funcMap from actual positions and patch all call/ref.func instructions.
  fixupFuncIndices(ctx);

  // ── Emit data segments for string literals ──
  if (ctx.stringLiterals.size > 0) {
    const totalSize = ctx.dataSegmentOffset - DATA_SEGMENT_BASE;
    const bytes = new Uint8Array(totalSize);
    for (const literal of ctx.stringLiterals.values()) {
      bytes.set(literal.bytes, literal.offset - DATA_SEGMENT_BASE);
    }
    mod.dataSegments.push({ offset: DATA_SEGMENT_BASE, bytes });
  }
  finalizeLinearArena(mod, multiAst, opts.exposeArenaReset);

  emitClosureTable(ctx);

  // Surface codegen diagnostics so compiler.ts fails the compile rather than
  // emitting a structurally invalid binary for unsupported constructs (#1868).
  if (ctx.errors.length > 0) mod.codegenErrors = ctx.errors;

  return mod;
}

/** Like compileFunction but only exports if isEntry is true or re-exported */
function compileFunctionMulti(
  ctx: LinearContext,
  decl: ts.FunctionDeclaration,
  isEntry: boolean,
  reExportedNames: Set<string>,
): void {
  const name = decl.name!.text;
  const hasExportKeyword = decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  // Export if: (1) directly exported from entry file, or (2) re-exported by entry file
  const isExported = (hasExportKeyword && isEntry) || reExportedNames.has(name);

  // Build parameter types
  const params: { name: string; type: ValType }[] = [];
  for (const p of decl.parameters) {
    const paramName = ts.isIdentifier(p.name) ? p.name.text : "_";
    const type = resolveParamTypeFromChecker(ctx, p);
    params.push({ name: paramName, type });
  }

  const returnType = resolveType(ctx, decl.type);
  const isVoid = returnType === null;
  const paramTypes = params.map((p) => p.type);
  const resultTypes: ValType[] = isVoid ? [] : [returnType];
  const typeIdx = ctx.mod.types.length;
  const funcTypeDef: FuncTypeDef = {
    kind: "func",
    name: `$type_${name}`,
    params: paramTypes,
    results: resultTypes,
  };
  ctx.mod.types.push(funcTypeDef);

  const fctx: LinearFuncContext = {
    name,
    params,
    locals: [],
    localMap: new Map(),
    returnType: isVoid ? null : returnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    finallyStack: [],
    collectionTypes: new Map(),
    callbackParams: new Map(),
  };

  for (let i = 0; i < params.length; i++) {
    fctx.localMap.set(params[i].name, i);
  }

  ctx.currentFunc = fctx;
  detectCallbackParams(ctx, fctx, decl.parameters);
  detectParamCollectionTypes(ctx, fctx, decl.parameters);
  const funcIdx = ctx.funcMap.get(name)!;

  if (decl.body) {
    for (const stmt of decl.body.statements) {
      compileStatement(ctx, fctx, stmt);
    }
  }

  if (!isVoid) {
    fctx.body.push({ op: "unreachable" });
  }

  ctx.mod.functions.push({
    name,
    typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: isExported,
  });

  if (isExported) {
    ctx.mod.exports.push({
      name,
      desc: { kind: "func", index: funcIdx },
    });
  }

  ctx.currentFunc = null;
}

function compileFunction(ctx: LinearContext, decl: ts.FunctionDeclaration): void {
  const name = decl.name!.text;
  const isExported = decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;

  // Build parameter types
  const params: { name: string; type: ValType }[] = [];
  for (const p of decl.parameters) {
    const paramName = ts.isIdentifier(p.name) ? p.name.text : "_";
    const type = resolveParamTypeFromChecker(ctx, p);
    params.push({ name: paramName, type });
  }

  // Resolve return type
  const returnType = resolveType(ctx, decl.type);
  const isVoid = returnType === null;

  // Register function type
  const paramTypes = params.map((p) => p.type);
  const resultTypes: ValType[] = isVoid ? [] : [returnType];
  const typeIdx = ctx.mod.types.length;
  const funcTypeDef: FuncTypeDef = {
    kind: "func",
    name: `$type_${name}`,
    params: paramTypes,
    results: resultTypes,
  };
  ctx.mod.types.push(funcTypeDef);

  // Create function context
  const fctx: LinearFuncContext = {
    name,
    params,
    locals: [],
    localMap: new Map(),
    returnType: isVoid ? null : returnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    finallyStack: [],
    collectionTypes: new Map(),
    callbackParams: new Map(),
  };

  // Register params in localMap
  for (let i = 0; i < params.length; i++) {
    fctx.localMap.set(params[i].name, i);
  }

  ctx.currentFunc = fctx;
  detectCallbackParams(ctx, fctx, decl.parameters);
  detectParamCollectionTypes(ctx, fctx, decl.parameters);

  // Function index was already registered in the forward declaration pass
  const funcIdx = ctx.funcMap.get(name)!;

  // Compile body
  if (decl.body) {
    for (const stmt of decl.body.statements) {
      compileStatement(ctx, fctx, stmt);
    }
  }

  // If the function returns a value, add unreachable at the end.
  // This handles the case where all code paths return early (e.g. if/else
  // with return in both branches). Wasm validation requires the stack to
  // match the return type at the end of the function body.
  if (!isVoid) {
    fctx.body.push({ op: "unreachable" });
  }

  // Add function to module
  ctx.mod.functions.push({
    name,
    typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: isExported,
  });

  if (isExported) {
    ctx.mod.exports.push({
      name,
      desc: { kind: "func", index: funcIdx },
    });
  }

  ctx.currentFunc = null;
}

/**
 * (#2716) Does a `finally` block itself perform a `return` / `break` / `continue`
 * (a completion that would override the pending early-exit being replayed)?
 *
 * Such a finally needs the spec's completion-override semantics, which the
 * simple replay model below does not implement — so we refuse loudly (like the
 * try/catch gate, #1838) rather than miscompile. The scan does NOT descend into
 * nested function/class bodies (their early exits belong to a different frame)
 * but DOES descend into nested loops/switches: a `break`/`continue` whose target
 * is INSIDE the finally is fine, so we only flag exits not captured by a
 * breakable/iteration construct within the finally.
 */
function finallyBlockHasOwnEarlyExit(block: ts.Block): boolean {
  let found = false;
  const visit = (node: ts.Node, inBreakable: boolean, inLoop: boolean): void => {
    if (found) return;
    // Don't cross into a new function/class scope — their exits are unrelated.
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isMethodDeclaration(node)
    ) {
      return;
    }
    if (ts.isReturnStatement(node)) {
      found = true;
      return;
    }
    if (ts.isBreakStatement(node) && !inBreakable) {
      found = true;
      return;
    }
    if (ts.isContinueStatement(node) && !inLoop) {
      found = true;
      return;
    }
    const isLoop =
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node);
    const isBreakable = isLoop || ts.isSwitchStatement(node);
    ts.forEachChild(node, (child) => visit(child, inBreakable || isBreakable, inLoop || isLoop));
  };
  for (const s of block.statements) visit(s, false, false);
  return found;
}

/**
 * (#2716) Replay the given `finally` blocks (already ordered innermost-first)
 * inline at the current program point, ahead of an early-exit jump. localMap is
 * snapshotted/restored around each replay so any block-scoped declaration in the
 * finally does not leak its name binding into the surrounding code (the backing
 * locals stay allocated; only the name→index map is scoped).
 */
function replayFinallyBlocks(ctx: LinearContext, fctx: LinearFuncContext, entries: FinallyEntry[]): void {
  for (const entry of entries) {
    const savedMap = new Map(fctx.localMap);
    for (const s of entry.block.statements) compileStatement(ctx, fctx, s);
    fctx.localMap = savedMap;
  }
}

function compileStatement(ctx: LinearContext, fctx: LinearFuncContext, stmt: ts.Statement): void {
  if (ts.isReturnStatement(stmt)) {
    // (#2716) Run every enclosing finally before leaving the function. The
    // return value is already on the stack; the finally blocks are side-effect
    // statements (a finally with its own early-exit is refused at the try site),
    // so they don't disturb it. Innermost finally first.
    if (fctx.finallyStack.length > 0 && stmt.expression) {
      // Evaluate the return value into a temp, run finallys, then reload it, so a
      // finally that reads/writes globals can't clobber the in-flight value.
      const rt = fctx.returnType ?? { kind: "f64" };
      const tmp = fctx.params.length + fctx.locals.length;
      fctx.locals.push({ name: `__retval_${tmp}`, type: rt });
      compileExpression(ctx, fctx, stmt.expression);
      fctx.body.push({ op: "local.set", index: tmp });
      replayFinallyBlocks(ctx, fctx, [...fctx.finallyStack].reverse());
      fctx.body.push({ op: "local.get", index: tmp });
      fctx.body.push({ op: "return" });
      return;
    }
    if (fctx.finallyStack.length > 0) {
      replayFinallyBlocks(ctx, fctx, [...fctx.finallyStack].reverse());
      fctx.body.push({ op: "return" });
      return;
    }
    if (stmt.expression) {
      compileExpression(ctx, fctx, stmt.expression);
    }
    fctx.body.push({ op: "return" });
  } else if (ts.isVariableStatement(stmt)) {
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) {
        const varName = decl.name.text;
        // Detect collection type from annotation or initializer
        const collKind = detectCollectionKind(ctx, decl);
        // Determine type from initializer or annotation
        let type: ValType = { kind: "f64" }; // default to f64 for numbers
        if (collKind) {
          type = { kind: "i32" }; // collections are i32 pointers
          fctx.collectionTypes.set(varName, collKind);
        } else if (decl.type) {
          const resolved = resolveType(ctx, decl.type);
          if (resolved) type = resolved;
        } else if (decl.initializer) {
          type = inferExprType(ctx, fctx, decl.initializer);
        }
        const localIdx = addLocal(fctx, varName, type);
        if (decl.initializer) {
          compileExpression(ctx, fctx, decl.initializer);
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      } else if (ts.isArrayBindingPattern(decl.name) && decl.initializer) {
        // Array destructuring: const [a, b, c] = arr
        compileArrayDestructuring(ctx, fctx, decl.name, decl.initializer);
      } else if (ts.isObjectBindingPattern(decl.name) && decl.initializer) {
        // Object destructuring: const { a, b: c } = obj
        compileObjectDestructuring(ctx, fctx, decl.name, decl.initializer);
      }
    }
  } else if (ts.isIfStatement(stmt)) {
    compileExpression(ctx, fctx, stmt.expression);
    // Convert f64 condition to i32 (0.0 = false, else true)
    emitTruthyCoercion(fctx, inferExprType(ctx, fctx, stmt.expression), { ctx, expr: stmt.expression });

    const thenBody: Instr[] = [];
    const savedBody = fctx.body;
    fctx.body = thenBody;
    fctx.blockDepth++;
    compileStatement(ctx, fctx, stmt.thenStatement);
    fctx.blockDepth--;

    let elseBody: Instr[] | undefined;
    if (stmt.elseStatement) {
      elseBody = [];
      fctx.body = elseBody;
      fctx.blockDepth++;
      compileStatement(ctx, fctx, stmt.elseStatement);
      fctx.blockDepth--;
    }

    fctx.body = savedBody;

    // Determine block type
    const blockType = { kind: "empty" as const };
    fctx.body.push({
      op: "if",
      blockType,
      then: thenBody,
      ...(elseBody ? { else: elseBody } : {}),
    });
  } else if (ts.isBlock(stmt)) {
    for (const s of stmt.statements) {
      compileStatement(ctx, fctx, s);
    }
  } else if (ts.isWhileStatement(stmt)) {
    // block { loop { br_if !cond @block; body; br @loop } }
    const loopBody: Instr[] = [];
    const savedBody = fctx.body;

    // Compile condition (break out if false)
    fctx.body = loopBody;
    compileExpression(ctx, fctx, stmt.expression);
    emitTruthyCoercion(fctx, inferExprType(ctx, fctx, stmt.expression), { ctx, expr: stmt.expression });
    fctx.body.push({ op: "i32.eqz" });
    fctx.body.push({ op: "br_if", depth: 1 }); // break to outer block

    // Push break/continue stack
    fctx.breakStack.push(fctx.blockDepth);
    fctx.continueStack.push(fctx.blockDepth + 1);
    fctx.blockDepth += 2;

    compileStatement(ctx, fctx, stmt.statement);

    fctx.blockDepth -= 2;
    fctx.breakStack.pop();
    fctx.continueStack.pop();

    fctx.body.push({ op: "br", depth: 0 }); // continue loop

    fctx.body = savedBody;
    fctx.body.push({
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: loopBody,
        },
      ],
    });
  } else if (ts.isForStatement(stmt)) {
    // Compile initializer outside loop
    if (stmt.initializer) {
      if (ts.isVariableDeclarationList(stmt.initializer)) {
        compileStatement(ctx, fctx, ts.factory.createVariableStatement(undefined, stmt.initializer));
      } else {
        compileExpression(ctx, fctx, stmt.initializer);
        fctx.body.push({ op: "drop" });
      }
    }

    const loopBody: Instr[] = [];
    const savedBody = fctx.body;
    fctx.body = loopBody;

    // Condition
    if (stmt.condition) {
      compileExpression(ctx, fctx, stmt.condition);
      emitTruthyCoercion(fctx, inferExprType(ctx, fctx, stmt.condition), { ctx, expr: stmt.condition });
      fctx.body.push({ op: "i32.eqz" });
      fctx.body.push({ op: "br_if", depth: 1 }); // break to outer block
    }

    // Body goes in an inner block so `continue` falls out of it and still
    // runs the incrementor (a br straight to the loop head would skip it
    // and re-test the condition with a stale induction variable, #1937).
    // Nesting inside the body: block(+1) loop(+2) inner-block(+3); the
    // stacks store (interior depth - 1) of the target label.
    const innerBody: Instr[] = [];
    fctx.body = innerBody;
    fctx.breakStack.push(fctx.blockDepth); // outer block
    fctx.continueStack.push(fctx.blockDepth + 2); // inner block
    fctx.blockDepth += 3;

    compileStatement(ctx, fctx, stmt.statement);

    fctx.blockDepth -= 3;
    fctx.breakStack.pop();
    fctx.continueStack.pop();

    fctx.body = loopBody;
    fctx.body.push({ op: "block", blockType: { kind: "empty" }, body: innerBody });

    // Incrementor
    if (stmt.incrementor) {
      compileExpression(ctx, fctx, stmt.incrementor);
      fctx.body.push({ op: "drop" });
    }

    fctx.body.push({ op: "br", depth: 0 }); // continue loop

    fctx.body = savedBody;
    fctx.body.push({
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: loopBody,
        },
      ],
    });
  } else if (ts.isForOfStatement(stmt)) {
    // for (const x of arr) { ... }
    compileForOfStatement(ctx, fctx, stmt);
  } else if (ts.isDoStatement(stmt)) {
    // do { ... } while (cond)
    compileDoWhileStatement(ctx, fctx, stmt);
  } else if (ts.isSwitchStatement(stmt)) {
    // switch (expr) { case ...: ... }
    compileSwitchStatement(ctx, fctx, stmt);
  } else if (ts.isTryStatement(stmt)) {
    // #1838 — the linear backend does not yet lower JS exception handling. The
    // previous behaviour silently inlined the try body and DISCARDED the catch
    // clause, so `try { throw e } catch (e) { handler }` ran the (unreachable)
    // throw and never the handler — a silent divergence from JS with no
    // diagnostic. Until the EH `try`/`catch` lowering (the emitter supports it,
    // src/emit/binary.ts) is wired through this backend, raise a clear compile
    // error rather than miscompile. A try with no catch (try/finally) is still
    // safe to inline: the finally always runs and there is no handler to drop.
    if (stmt.catchClause) {
      // Throw rather than push to ctx.errors: the linear backend's ctx.errors
      // are not surfaced into the compile result, so a push would still
      // silently miscompile. The compiler.ts try/catch around
      // generateLinearM(ulti)Module converts a thrown Error into a
      // `Codegen error:` failed result, which is what we want.
      throw new Error(
        "try/catch is not yet supported by the linear/standalone backend — emitting it " +
          "would silently drop the catch handler (#1838). A Wasm-EH try/catch lowering is " +
          "the planned fix; a bare `try { ... }` with only `finally` is supported.",
      );
    } else if (stmt.finallyBlock) {
      // try { ... } finally { ... } — no catch to lose. (#2716) The finally must
      // run on EVERY completion path out of the try, not just fall-through: an
      // early `return` / `break` / `continue` in the try body used to inline
      // straight to the exit and SKIP the trailing finally. We register the
      // finally on fctx.finallyStack so those exits replay it before jumping,
      // and still emit it inline for the normal fall-through path.
      if (finallyBlockHasOwnEarlyExit(stmt.finallyBlock)) {
        // A finally that itself returns/breaks/continues needs completion-
        // override semantics the replay model doesn't implement — refuse loudly
        // (like try/catch, #1838) rather than miscompile.
        throw new Error(
          "try/finally where the `finally` block itself performs a return/break/continue is not " +
            "yet supported by the linear/standalone backend (#2716) — it requires completion-override " +
            "semantics; a `finally` with only side effects is supported.",
        );
      }
      const entry: FinallyEntry = {
        block: stmt.finallyBlock,
        breakDepth: fctx.breakStack.length,
        continueDepth: fctx.continueStack.length,
      };
      fctx.finallyStack.push(entry);
      for (const s of stmt.tryBlock.statements) {
        compileStatement(ctx, fctx, s);
      }
      fctx.finallyStack.pop();
      // Normal fall-through completion: run finally inline.
      replayFinallyBlocks(ctx, fctx, [entry]);
    } else {
      // Bare `try { ... }` with neither catch nor finally — inline the body.
      for (const s of stmt.tryBlock.statements) {
        compileStatement(ctx, fctx, s);
      }
    }
  } else if (ts.isExpressionStatement(stmt)) {
    compileExpression(ctx, fctx, stmt.expression);
    // Only drop if the expression produces a value
    if (!isVoidExpression(ctx, stmt.expression)) {
      fctx.body.push({ op: "drop" });
    }
  } else if (ts.isBreakStatement(stmt) || ts.isContinueStatement(stmt)) {
    // #1937 — break/continue were previously never compiled: the dispatcher
    // had no arm for them, so `while (true) { if (x) break; }` silently
    // became an infinite loop. The loop lowerings maintain breakStack/
    // continueStack as (interior block depth - 1) of the target label, so
    // the relative br depth from the current nesting is
    // `blockDepth - target - 1` (every if/block/loop arm increments
    // fctx.blockDepth around the statements it compiles into).
    const isBreak = ts.isBreakStatement(stmt);
    const kw = isBreak ? "break" : "continue";
    if (stmt.label) {
      ctx.errors.push({
        message: `Unsupported in linear backend: labeled ${kw} ('${stmt.label.text}')`,
        ...nodeLoc(stmt),
      });
    } else {
      const stack = isBreak ? fctx.breakStack : fctx.continueStack;
      if (stack.length === 0) {
        ctx.errors.push({
          message: `'${kw}' outside of ${isBreak ? "a loop or switch" : "a loop"}`,
          ...nodeLoc(stmt),
        });
      } else {
        // (#2716) Replay any finally blocks that sit BETWEEN this break/continue
        // and its target. A finally is "inside" the target iff it was entered
        // when the break/continue nesting was already at the current depth (i.e.
        // inside the innermost loop/switch the jump exits). Innermost first.
        // Replaying inline keeps blockDepth balanced, so the br depth below is
        // unchanged.
        const targetDepth = stack.length;
        const pending = fctx.finallyStack.filter((e) =>
          isBreak ? e.breakDepth === targetDepth : e.continueDepth === targetDepth,
        );
        if (pending.length > 0) {
          replayFinallyBlocks(ctx, fctx, [...pending].reverse());
        }
        fctx.body.push({ op: "br", depth: fctx.blockDepth - stack[stack.length - 1]! - 1 });
      }
    }
  } else if (ts.isThrowStatement(stmt)) {
    // #1937 — `throw` used to lower to a bare `unreachable`, silently
    // replacing exception semantics with a trap (no catch can ever see it,
    // and the exit status differs from JS). Until a Wasm-EH lowering lands
    // (the emitter supports try/catch, see #1838), refuse loudly like
    // try/catch does rather than miscompile.
    ctx.errors.push({
      message:
        "Unsupported in linear backend: 'throw' (would silently become a trap; " +
        "Wasm-EH lowering is the planned fix, see #1838/#1937)",
      ...nodeLoc(stmt),
    });
    fctx.body.push({ op: "unreachable" }); // keep downstream stack analysis sane
  } else if (
    ts.isEmptyStatement(stmt) ||
    ts.isTypeAliasDeclaration(stmt) ||
    ts.isInterfaceDeclaration(stmt) ||
    ts.isDebuggerStatement(stmt)
  ) {
    // Type-only / no-op statements: nothing to emit.
  } else {
    // #1937 — fail-loud default arm: any statement kind without an explicit
    // arm above used to fall through silently, emitting zero instructions
    // and diverging from JS with no diagnostic. The #1868 gate in
    // compiler.ts turns these errors into success:false.
    ctx.errors.push({
      message: `Unsupported statement in linear backend: ${ts.SyntaxKind[stmt.kind]}`,
      ...nodeLoc(stmt),
    });
  }
}

// ── ForOfStatement ─────────────────────────────────────────────────────

function compileForOfStatement(ctx: LinearContext, fctx: LinearFuncContext, stmt: ts.ForOfStatement): void {
  // Compile the iterable expression (the array)
  compileExpression(ctx, fctx, stmt.expression);
  const arrLocal = addLocal(fctx, `__forof_arr_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.set", index: arrLocal });

  // Create index counter
  const idxLocal = addLocal(fctx, `__forof_idx_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: idxLocal });

  // Determine collection kind for the iterable
  const iterKind = getExprCollectionKind(ctx, fctx, stmt.expression);

  // Get length (use appropriate len function based on collection kind)
  const lenLocal = addLocal(fctx, `__forof_len_${fctx.locals.length}`, { kind: "i32" });
  if (iterKind === "ArrayOrUint8Array") {
    // Runtime dispatch: check tag byte at offset 0
    const arrLenIdx = ctx.funcMap.get("__arr_len")!;
    const u8LenIdx = ctx.funcMap.get("__u8arr_len")!;
    fctx.body.push({ op: "local.get", index: arrLocal });
    fctx.body.push({ op: "i32.load8_u", align: 0, offset: 0 });
    fctx.body.push({ op: "i32.const", value: 0x02 }); // Uint8Array tag
    fctx.body.push({ op: "i32.eq" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: arrLocal },
        { op: "call", funcIdx: u8LenIdx },
      ],
      else: [
        { op: "local.get", index: arrLocal },
        { op: "call", funcIdx: arrLenIdx },
      ],
    });
  } else {
    const lenFuncName = iterKind === "Uint8Array" ? "__u8arr_len" : "__arr_len";
    const arrLenIdx = ctx.funcMap.get(lenFuncName)!;
    fctx.body.push({ op: "local.get", index: arrLocal });
    fctx.body.push({ op: "call", funcIdx: arrLenIdx });
  }
  fctx.body.push({ op: "local.set", index: lenLocal });

  // Determine the loop variable name(s)
  const initDecl = stmt.initializer;
  let loopVarName: string | null = null;
  let destructuredNames: string[] | null = null;

  if (ts.isVariableDeclarationList(initDecl)) {
    const decl = initDecl.declarations[0];
    if (ts.isIdentifier(decl.name)) {
      loopVarName = decl.name.text;
    } else if (ts.isArrayBindingPattern(decl.name)) {
      // Destructuring: for (const [k, v] of map)
      destructuredNames = [];
      for (const el of decl.name.elements) {
        if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
          destructuredNames.push(el.name.text);
        }
      }
    }
  }

  // If it's a Map iteration with destructuring, delegate to compileForOfMap
  if (destructuredNames && iterKind === "Map") {
    compileForOfMap(ctx, fctx, stmt, arrLocal, destructuredNames);
    return;
  }

  // Create loop variable (for simple for-of)
  // Determine element type: use TypeChecker to check if elements are numbers or pointers
  let elementIsI32 = false;
  if (loopVarName) {
    try {
      // Check the type of the iterable's element type via the TypeChecker
      const iterType = ctx.checker.getTypeAtLocation(stmt.expression);
      const iterTypeStr = ctx.checker.typeToString(iterType);
      // If it's an array of non-numeric types (objects, strings, etc.), use i32
      if (iterTypeStr.endsWith("[]") && !iterTypeStr.startsWith("number") && !iterTypeStr.startsWith("boolean")) {
        elementIsI32 = true;
      }
    } catch {
      /* fall through */
    }
  }
  let loopVarIdx: number | undefined;
  if (loopVarName) {
    loopVarIdx = addLocal(fctx, loopVarName, elementIsI32 ? { kind: "i32" } : { kind: "f64" });
  }

  // Build loop body
  const loopBody: Instr[] = [];
  const savedBody = fctx.body;
  fctx.body = loopBody;

  // Break condition: idx >= len
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.ge_s" });
  fctx.body.push({ op: "br_if", depth: 1 }); // break to outer block

  // Load element: x = getter(arr, idx)
  if (loopVarIdx !== undefined) {
    if (iterKind === "ArrayOrUint8Array") {
      // Runtime dispatch: check tag byte at offset 0. Both arms must yield the
      // same type; __u8arr_get returns i32 (byte), __arr_get returns an f64 slot
      // (#1938). Reconcile to f64 (u8 side: f64.convert_i32_u inside `then`).
      const arrGetIdx = ctx.funcMap.get("__arr_get")!;
      const u8GetIdx = ctx.funcMap.get("__u8arr_get")!;
      fctx.body.push({ op: "local.get", index: arrLocal });
      fctx.body.push({ op: "i32.load8_u", align: 0, offset: 0 });
      fctx.body.push({ op: "i32.const", value: 0x02 }); // Uint8Array tag
      fctx.body.push({ op: "i32.eq" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "f64" } },
        then: [
          { op: "local.get", index: arrLocal },
          { op: "local.get", index: idxLocal },
          { op: "call", funcIdx: u8GetIdx },
          { op: "f64.convert_i32_u" },
        ],
        else: [
          { op: "local.get", index: arrLocal },
          { op: "local.get", index: idxLocal },
          { op: "call", funcIdx: arrGetIdx },
        ],
      });
      // Slot is now f64. A ref/string element needs decoding to its i32 handle.
      if (elementIsI32) {
        pushSlotToI32(fctx);
      }
    } else if (iterKind === "Uint8Array") {
      // u8 element is an i32 byte; convert to f64 unless the binding is i32.
      const u8GetIdx = ctx.funcMap.get("__u8arr_get")!;
      fctx.body.push({ op: "local.get", index: arrLocal });
      fctx.body.push({ op: "local.get", index: idxLocal });
      fctx.body.push({ op: "call", funcIdx: u8GetIdx });
      if (!elementIsI32) {
        fctx.body.push({ op: "f64.convert_i32_s" });
      }
    } else {
      // Array element is an f64 slot (#1938). For a number/boolean binding the
      // slot IS the value; for a ref/string binding decode to its i32 handle.
      const arrGetIdx = ctx.funcMap.get("__arr_get")!;
      fctx.body.push({ op: "local.get", index: arrLocal });
      fctx.body.push({ op: "local.get", index: idxLocal });
      fctx.body.push({ op: "call", funcIdx: arrGetIdx });
      if (elementIsI32) {
        pushSlotToI32(fctx);
      }
    }
    fctx.body.push({ op: "local.set", index: loopVarIdx });
  }

  // Body goes in an inner block so `continue` falls out of it and still
  // increments the index (#1937). Nesting: block(+1) loop(+2) inner(+3).
  const innerBody: Instr[] = [];
  fctx.body = innerBody;
  fctx.breakStack.push(fctx.blockDepth); // outer block
  fctx.continueStack.push(fctx.blockDepth + 2); // inner block
  fctx.blockDepth += 3;

  // Compile body
  compileStatement(ctx, fctx, stmt.statement);

  fctx.blockDepth -= 3;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  fctx.body = loopBody;
  fctx.body.push({ op: "block", blockType: { kind: "empty" }, body: innerBody });

  // Increment index
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: idxLocal });

  // Continue loop
  fctx.body.push({ op: "br", depth: 0 });

  fctx.body = savedBody;
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });
}

// ── ForOfMap (for-of over Map entries with destructuring) ──────────────

function compileForOfMap(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  stmt: ts.ForOfStatement,
  mapLocal: number,
  destructuredNames: string[],
): void {
  // Layout: [header 8B][count:u32 at +8][cap:u32 at +12][entries at +16...]
  // Entry: [hash:u32][key:i32][val:i32] = 12 bytes each

  const idxLocal = addLocal(fctx, `__forof_map_idx_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: idxLocal });

  const capLocal = addLocal(fctx, `__forof_map_cap_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: mapLocal });
  fctx.body.push({ op: "i32.load", align: 2, offset: 12 });
  fctx.body.push({ op: "local.set", index: capLocal });

  // Determine Map key/value types via TypeChecker
  let keyIsI32 = false;
  let valIsI32 = false;
  try {
    const mapType = ctx.checker.getTypeAtLocation(stmt.expression);
    const mapStr = ctx.checker.typeToString(ctx.checker.getNonNullableType(mapType));
    // Parse Map<K, V> to determine key and value types
    const match = mapStr.match(/^Map<(.+),\s*(.+)>$/);
    if (match) {
      const keyStr = match[1].trim();
      const valStr = match[2].trim();
      if (keyStr !== "number" && keyStr !== "boolean") keyIsI32 = true;
      if (valStr !== "number" && valStr !== "boolean") valIsI32 = true;
    } else {
      // Default: string keys, object values
      keyIsI32 = true;
      valIsI32 = true;
    }
  } catch {
    /* default: f64 */
  }

  // Create locals for destructured variables
  const keyVarIdx =
    destructuredNames.length > 0
      ? addLocal(fctx, destructuredNames[0], keyIsI32 ? { kind: "i32" } : { kind: "f64" })
      : undefined;
  const valVarIdx =
    destructuredNames.length > 1
      ? addLocal(fctx, destructuredNames[1], valIsI32 ? { kind: "i32" } : { kind: "f64" })
      : undefined;

  // Register collection types for destructured variables using TypeChecker
  try {
    const mapType = ctx.checker.getTypeAtLocation(stmt.expression);
    const mapStr = ctx.checker.typeToString(ctx.checker.getNonNullableType(mapType));
    const match = mapStr.match(/^Map<(.+),\s*(.+)>$/);
    if (match) {
      const valStr = match[2].trim();
      if (valStr.endsWith("[]") || valStr.startsWith("Array<")) {
        if (destructuredNames.length > 1) {
          fctx.collectionTypes.set(destructuredNames[1], "Array");
        }
      } else if (valStr.startsWith("Map<") || valStr === "Map") {
        if (destructuredNames.length > 1) {
          fctx.collectionTypes.set(destructuredNames[1], "Map");
        }
      } else if (valStr.startsWith("Set<") || valStr === "Set") {
        if (destructuredNames.length > 1) {
          fctx.collectionTypes.set(destructuredNames[1], "Set");
        }
      }
    }
  } catch {
    /* ignore */
  }

  const loopBody: Instr[] = [];
  const savedBody = fctx.body;
  fctx.body = loopBody;

  // Break condition: idx >= cap
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "local.get", index: capLocal });
  fctx.body.push({ op: "i32.ge_s" });
  fctx.body.push({ op: "br_if", depth: 1 });

  // Compute entry address: map + 16 + idx * 12
  // Read hash at entry address
  const entryAddrLocal = addLocal(fctx, `__forof_entry_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: mapLocal });
  fctx.body.push({ op: "i32.const", value: 16 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "i32.const", value: 12 });
  fctx.body.push({ op: "i32.mul" });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: entryAddrLocal });

  // Check hash != 0 (non-empty entry)
  fctx.body.push({ op: "local.get", index: entryAddrLocal });
  fctx.body.push({ op: "i32.load", align: 2, offset: 0 });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.ne" });

  // If hash != 0, process this entry
  const thenBody: Instr[] = [];
  const savedBody2 = fctx.body;
  fctx.body = thenBody;

  // Load key: i32.load at entry + 4
  if (keyVarIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: entryAddrLocal });
    fctx.body.push({ op: "i32.load", align: 2, offset: 4 });
    if (!keyIsI32) fctx.body.push({ op: "f64.convert_i32_s" });
    fctx.body.push({ op: "local.set", index: keyVarIdx });
  }

  // Load val: i32.load at entry + 8
  if (valVarIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: entryAddrLocal });
    fctx.body.push({ op: "i32.load", align: 2, offset: 8 });
    if (!valIsI32) fctx.body.push({ op: "f64.convert_i32_s" });
    fctx.body.push({ op: "local.set", index: valVarIdx });
  }

  // The body lives inside the `if (hash != 0)` then-arm, which is its own
  // label: nesting is block(+1) loop(+2) if-then(+3). `continue` targets the
  // if-then label itself — exiting the if falls through to the index
  // increment below, which is exactly JS continue semantics (#1937).
  fctx.breakStack.push(fctx.blockDepth); // outer block
  fctx.continueStack.push(fctx.blockDepth + 2); // if-then arm
  fctx.blockDepth += 3;

  // Compile body
  compileStatement(ctx, fctx, stmt.statement);

  fctx.blockDepth -= 3;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  fctx.body = savedBody2;

  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: thenBody,
  });

  // Increment index
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: idxLocal });

  // Continue loop
  fctx.body.push({ op: "br", depth: 0 });

  fctx.body = savedBody;
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });
}

// ── DoWhileStatement ──────────────────────────────────────────────────

function compileDoWhileStatement(ctx: LinearContext, fctx: LinearFuncContext, stmt: ts.DoStatement): void {
  const loopBody: Instr[] = [];
  const savedBody = fctx.body;
  fctx.body = loopBody;

  // Body goes in an inner block so `continue` falls out of it into the
  // condition check (a br straight to the loop head would re-run the body
  // without testing the condition, #1937). Nesting: block(+1) loop(+2)
  // inner-block(+3); the stacks store (interior depth - 1) of the target.
  const innerBody: Instr[] = [];
  fctx.body = innerBody;
  fctx.breakStack.push(fctx.blockDepth); // outer block
  fctx.continueStack.push(fctx.blockDepth + 2); // inner block
  fctx.blockDepth += 3;

  // Compile body first (do-while executes body before checking condition)
  compileStatement(ctx, fctx, stmt.statement);

  fctx.blockDepth -= 3;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  fctx.body = loopBody;
  fctx.body.push({ op: "block", blockType: { kind: "empty" }, body: innerBody });

  // Compile condition
  compileExpression(ctx, fctx, stmt.expression);
  emitTruthyCoercion(fctx, inferExprType(ctx, fctx, stmt.expression), { ctx, expr: stmt.expression });
  // If condition is true, continue looping (br to loop)
  fctx.body.push({ op: "br_if", depth: 0 });

  fctx.body = savedBody;
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });
}

// ── SwitchStatement ────────────────────────────────────────────────────

/**
 * Is `s` guaranteed to transfer control (so execution cannot fall off its
 * end into the next switch case)? Conservative recursive check used by the
 * switch fall-through guard (#1937).
 */
function statementTerminates(s: ts.Statement): boolean {
  if (ts.isReturnStatement(s) || ts.isBreakStatement(s) || ts.isContinueStatement(s) || ts.isThrowStatement(s)) {
    return true;
  }
  if (ts.isBlock(s)) {
    return s.statements.length > 0 && statementTerminates(s.statements[s.statements.length - 1]!);
  }
  if (ts.isIfStatement(s)) {
    return !!s.elseStatement && statementTerminates(s.thenStatement) && statementTerminates(s.elseStatement);
  }
  return false;
}

function compileSwitchStatement(ctx: LinearContext, fctx: LinearFuncContext, stmt: ts.SwitchStatement): void {
  // Compile as cascading if/else, all wrapped in one block that serves as
  // the `break` target (#1937). Consecutive case clauses with empty bodies
  // (fall-through) are grouped into a single OR'd condition; fall-through
  // out of a NON-empty case body cannot be expressed in this lowering and
  // is rejected with a hard error below (it used to be silently dropped).
  compileExpression(ctx, fctx, stmt.expression);
  const switchExprType = inferExprType(ctx, fctx, stmt.expression);
  const switchLocal = addLocal(fctx, `__switch_${fctx.locals.length}`, switchExprType);
  fctx.body.push({ op: "local.set", index: switchLocal });

  // Everything below goes inside the break-target block. The stacks store
  // (interior depth - 1) of the target label, so push the pre-entry depth.
  const switchBody: Instr[] = [];
  const outerBody = fctx.body;
  fctx.body = switchBody;
  fctx.breakStack.push(fctx.blockDepth); // switch block (continue passes through to the enclosing loop)
  fctx.blockDepth += 1;

  let defaultClause: ts.CaseOrDefaultClause | null = null;

  // Track whether any case matched (for default clause guarding)
  let matchedLocal: number | undefined;
  // Pre-scan for default clause
  for (const c of stmt.caseBlock.clauses) {
    if (ts.isDefaultClause(c)) {
      matchedLocal = addLocal(fctx, `__switch_matched_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.set", index: matchedLocal });
      break;
    }
  }

  const clauseArr = Array.from(stmt.caseBlock.clauses);
  let i = 0;
  while (i < clauseArr.length) {
    const clause = clauseArr[i]!;
    if (ts.isDefaultClause(clause)) {
      // A mid-list default with a non-terminated body would fall through
      // into the next case in JS; this lowering hoists default to the end,
      // so reject rather than silently diverge (#1937).
      if (
        i < clauseArr.length - 1 &&
        clause.statements.length > 0 &&
        !statementTerminates(clause.statements[clause.statements.length - 1]!)
      ) {
        ctx.errors.push({
          message:
            "Unsupported in linear backend: switch default-clause fall-through into a following case " +
            "(end the default body with break/return)",
          ...nodeLoc(clause),
        });
      }
      defaultClause = clause;
      i++;
      continue;
    }

    // Collect consecutive case clauses with empty statements (fall-through)
    const caseExprs: ts.Expression[] = [clause.expression!];
    let bodyClause: ts.CaseClause = clause as ts.CaseClause;
    while (bodyClause.statements.length === 0 && i + 1 < clauseArr.length) {
      i++;
      const next = clauseArr[i]!;
      if (ts.isDefaultClause(next)) {
        defaultClause = next;
        break;
      }
      caseExprs.push((next as ts.CaseClause).expression!);
      bodyClause = next as ts.CaseClause;
    }

    // Build OR'd condition: switchVal === case1 || switchVal === case2 || ...
    for (let j = 0; j < caseExprs.length; j++) {
      fctx.body.push({ op: "local.get", index: switchLocal });
      compileExpression(ctx, fctx, caseExprs[j]!);
      if (switchExprType.kind === "f64") {
        fctx.body.push({ op: "f64.eq" });
      } else {
        fctx.body.push({ op: "i32.eq" });
      }
      if (j > 0) {
        fctx.body.push({ op: "i32.or" });
      }
    }

    // Fall-through out of a non-empty case body is silently dropped by the
    // cascading-if lowering (the next case's condition re-tests instead of
    // running its body) — hard error until a real br_table lowering lands
    // (#1937). The last clause has nothing to fall into, so it is exempt.
    if (
      i < clauseArr.length - 1 &&
      bodyClause.statements.length > 0 &&
      !statementTerminates(bodyClause.statements[bodyClause.statements.length - 1]!)
    ) {
      ctx.errors.push({
        message:
          "Unsupported in linear backend: switch case fall-through from a non-empty case body " +
          "(end the case with break/return)",
        ...nodeLoc(bodyClause),
      });
    }

    // Then body (an `if` arm is its own br label, so track the depth)
    const thenBody: Instr[] = [];
    const savedBody = fctx.body;
    fctx.body = thenBody;
    fctx.blockDepth += 1;
    if (matchedLocal !== undefined) {
      fctx.body.push({ op: "i32.const", value: 1 });
      fctx.body.push({ op: "local.set", index: matchedLocal });
    }
    for (const s of bodyClause.statements) {
      compileStatement(ctx, fctx, s);
    }
    fctx.blockDepth -= 1;
    fctx.body = savedBody;

    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: thenBody,
    });

    i++;
  }

  // Default clause — only execute if no case matched
  if (defaultClause) {
    if (matchedLocal !== undefined) {
      fctx.body.push({ op: "local.get", index: matchedLocal });
      fctx.body.push({ op: "i32.eqz" });
      const defaultBody: Instr[] = [];
      const savedBody = fctx.body;
      fctx.body = defaultBody;
      fctx.blockDepth += 1; // inside the `if` arm
      for (const s of defaultClause.statements) {
        compileStatement(ctx, fctx, s);
      }
      fctx.blockDepth -= 1;
      fctx.body = savedBody;
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: defaultBody,
      });
    } else {
      for (const s of defaultClause.statements) {
        compileStatement(ctx, fctx, s);
      }
    }
  }

  // Close the break-target block (#1937)
  fctx.blockDepth -= 1;
  fctx.breakStack.pop();
  fctx.body = outerBody;
  fctx.body.push({ op: "block", blockType: { kind: "empty" }, body: switchBody });
}

export function compileExpression(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.Expression): void {
  if (ts.isNumericLiteral(expr)) {
    fctx.body.push({ op: "f64.const", value: Number(expr.text) });
  } else if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    compileStringLiteral(ctx, fctx, expr.text);
  } else if (expr.kind === ts.SyntaxKind.ThisKeyword) {
    // `this` is the first parameter (index 0) in class methods/constructors
    fctx.body.push({ op: "local.get", index: 0 });
  } else if (expr.kind === ts.SyntaxKind.TrueKeyword) {
    fctx.body.push({ op: "f64.const", value: 1 });
  } else if (expr.kind === ts.SyntaxKind.FalseKeyword) {
    fctx.body.push({ op: "f64.const", value: 0 });
  } else if (expr.kind === ts.SyntaxKind.NullKeyword) {
    fctx.body.push({ op: "i32.const", value: 0 });
  } else if (ts.isBigIntLiteral(expr)) {
    const text = expr.text.replace(/n$/, "");
    fctx.body.push({ op: "f64.const", value: Number(text) });
  } else if (ts.isBinaryExpression(expr)) {
    compileBinaryExpression(ctx, fctx, expr);
  } else if (ts.isParenthesizedExpression(expr)) {
    compileExpression(ctx, fctx, expr.expression);
  } else if (ts.isIdentifier(expr)) {
    const name = expr.text;
    if (name === "undefined") {
      // undefined is represented as i32 0 (null pointer)
      fctx.body.push({ op: "i32.const", value: 0 });
    } else if (name === "Infinity") {
      fctx.body.push({ op: "f64.const", value: Infinity });
    } else if (name === "NaN") {
      fctx.body.push({ op: "f64.const", value: NaN });
    } else {
      const localIdx = fctx.localMap.get(name);
      if (localIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: localIdx });
      } else {
        // Check module-level globals
        const globalIdx = ctx.moduleGlobals.get(name);
        if (globalIdx !== undefined) {
          fctx.body.push({ op: "global.get", index: globalIdx });
        } else {
          ctx.errors.push({
            message: `Unknown identifier: ${name}`,
            line: 0,
            column: 0,
          });
        }
      }
    }
  } else if (ts.isPrefixUnaryExpression(expr)) {
    if (expr.operator === ts.SyntaxKind.MinusToken) {
      compileExpression(ctx, fctx, expr.operand);
      fctx.body.push({ op: "f64.neg" });
    } else if (expr.operator === ts.SyntaxKind.PlusToken) {
      compileExpression(ctx, fctx, expr.operand);
      // unary plus is a no-op for numbers
    } else if (expr.operator === ts.SyntaxKind.ExclamationToken) {
      compileExpression(ctx, fctx, expr.operand);
      emitTruthyCoercion(fctx, inferExprType(ctx, fctx, expr.operand), { ctx, expr: expr.operand });
      fctx.body.push({ op: "i32.eqz" });
      // Result is i32 (0 or 1), convert back to f64
      fctx.body.push({ op: "f64.convert_i32_s" });
    } else if (expr.operator === ts.SyntaxKind.TildeToken) {
      // Bitwise NOT: ~x = (x ^ -1). ToInt32 the operand (#2715: NaN/∞/large wrap,
      // never trap) so `~(0/0) === -1`.
      compileExprToInt32(ctx, fctx, expr.operand);
      fctx.body.push({ op: "i32.const", value: -1 });
      fctx.body.push({ op: "i32.xor" });
      fctx.body.push({ op: "f64.convert_i32_s" });
    } else if (expr.operator === ts.SyntaxKind.PlusPlusToken) {
      // ++x
      if (ts.isIdentifier(expr.operand)) {
        const idx = fctx.localMap.get(expr.operand.text);
        if (idx !== undefined) {
          fctx.body.push({ op: "local.get", index: idx });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: "f64.add" });
          fctx.body.push({ op: "local.tee", index: idx });
        }
      }
    } else if (expr.operator === ts.SyntaxKind.MinusMinusToken) {
      // --x
      if (ts.isIdentifier(expr.operand)) {
        const idx = fctx.localMap.get(expr.operand.text);
        if (idx !== undefined) {
          fctx.body.push({ op: "local.get", index: idx });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: "f64.sub" });
          fctx.body.push({ op: "local.tee", index: idx });
        }
      }
    }
  } else if (ts.isPostfixUnaryExpression(expr)) {
    if (ts.isIdentifier(expr.operand)) {
      const idx = fctx.localMap.get(expr.operand.text);
      if (idx !== undefined) {
        // Return old value
        fctx.body.push({ op: "local.get", index: idx });
        // Compute new value
        fctx.body.push({ op: "local.get", index: idx });
        fctx.body.push({ op: "f64.const", value: 1 });
        if (expr.operator === ts.SyntaxKind.PlusPlusToken) {
          fctx.body.push({ op: "f64.add" });
        } else {
          fctx.body.push({ op: "f64.sub" });
        }
        fctx.body.push({ op: "local.set", index: idx });
      }
    } else if (
      ts.isPropertyAccessExpression(expr.operand) &&
      expr.operand.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      // this.field++ / this.field--
      const propName = expr.operand.name.text;
      const className = inferClassName(ctx, fctx, expr.operand.expression);
      if (className) {
        const layout = ctx.classLayouts.get(className);
        if (layout) {
          const field = layout.fields.get(propName);
          if (field) {
            const tempLocal = addLocal(fctx, `$postfix_${propName}`, { kind: field.type });
            const thisIdx = fctx.localMap.get("this") ?? 0;
            // Load old value into temp
            fctx.body.push({ op: "local.get", index: thisIdx });
            if (field.type === "f64") {
              fctx.body.push({ op: "f64.load", align: 3, offset: field.offset });
            } else {
              fctx.body.push({ op: "i32.load", align: 2, offset: field.offset });
            }
            fctx.body.push({ op: "local.set", index: tempLocal });
            // Compute new value and store back
            fctx.body.push({ op: "local.get", index: thisIdx });
            fctx.body.push({ op: "local.get", index: tempLocal });
            if (field.type === "f64") {
              fctx.body.push({ op: "f64.const", value: expr.operator === ts.SyntaxKind.PlusPlusToken ? 1 : -1 });
              fctx.body.push({ op: "f64.add" });
              fctx.body.push({ op: "f64.store", align: 3, offset: field.offset });
            } else {
              fctx.body.push({ op: "i32.const", value: expr.operator === ts.SyntaxKind.PlusPlusToken ? 1 : -1 });
              fctx.body.push({ op: "i32.add" });
              fctx.body.push({ op: "i32.store", align: 2, offset: field.offset });
            }
            // Return old value
            fctx.body.push({ op: "local.get", index: tempLocal });
          }
        }
      }
    }
  } else if (ts.isArrayLiteralExpression(expr)) {
    // [] or [a, b, c]
    compileArrayLiteral(ctx, fctx, expr);
  } else if (ts.isNewExpression(expr)) {
    // new Uint8Array(n), new Map(), new Set()
    compileNewExpression(ctx, fctx, expr);
  } else if (ts.isPropertyAccessExpression(expr)) {
    // arr.length, map.size, set.size
    compilePropertyAccess(ctx, fctx, expr);
  } else if (ts.isElementAccessExpression(expr)) {
    // arr[i], u8[i]
    compileElementAccess(ctx, fctx, expr);
  } else if (ts.isCallExpression(expr)) {
    if (ts.isPropertyAccessExpression(expr.expression)) {
      // Method calls: arr.push(x), map.set(k,v), etc.
      compileMethodCall(ctx, fctx, expr);
    } else if (ts.isIdentifier(expr.expression)) {
      const funcName = expr.expression.text;
      // Built-in type conversion functions → just compile the argument
      if (funcName === "Number" || funcName === "Boolean") {
        if (expr.arguments.length > 0) {
          compileExpression(ctx, fctx, expr.arguments[0]);
        } else {
          fctx.body.push({ op: "f64.const", value: 0 });
        }
      } else if (funcName === "String") {
        // String() conversion — pass through for string args, else convert
        if (expr.arguments.length > 0) {
          compileExpression(ctx, fctx, expr.arguments[0]);
        } else {
          compileStringLiteral(ctx, fctx, "");
        }
      } else {
        // Check if this is a callback parameter (indirect call)
        const cbTypeIdx = fctx.callbackParams.get(funcName);
        if (cbTypeIdx !== undefined) {
          // Push arguments first, then the table index
          for (const arg of expr.arguments) {
            compileCallArg(ctx, fctx, arg);
          }
          const localIdx = fctx.localMap.get(funcName)!;
          fctx.body.push({ op: "local.get", index: localIdx }); // table index
          fctx.body.push({ op: "call_indirect", typeIdx: cbTypeIdx, tableIdx: 0 });
        } else {
          // #4539 — an extern-C binding wins over any same-named local slot.
          // A `declare function` is registered as a user function too, so
          // consulting funcMap first would retarget the call at a body-less
          // slot carrying a TS-derived signature.
          const externSig = ctx.externImportSigs?.get(funcName);
          const funcIdx = ctx.funcMap.get(funcName);
          if (externSig !== undefined) {
            // The declared C signature is authoritative and this backend's
            // `number` is f64, so arguments and result convert at the
            // boundary rather than being assumed to match.
            emitExternCCall(ctx, fctx, expr, funcName, externSig.index, externSig);
          } else if (funcIdx !== undefined) {
            for (const arg of expr.arguments) {
              compileCallArg(ctx, fctx, arg);
            }
            // Fill default values for missing parameters
            emitDefaultArgs(ctx, fctx, funcName, expr.arguments.length);
            fctx.body.push({ op: "call", funcIdx });
          } else {
            ctx.errors.push({
              message: `Unknown function: ${funcName}`,
              ...nodeLoc(expr),
            });
          }
        }
      }
    } else {
      // Callee is neither a property access nor an identifier (IIFE,
      // computed callee, …) — used to silently emit nothing (#1937).
      ctx.errors.push({
        message: `Unsupported call target in linear backend: ${ts.SyntaxKind[expr.expression.kind]}`,
        ...nodeLoc(expr),
      });
      fctx.body.push({ op: "f64.const", value: 0 });
    }
  } else if (ts.isNonNullExpression(expr)) {
    // Handle `expr!` (non-null assertion) - just compile the inner expression
    compileExpression(ctx, fctx, expr.expression);
  } else if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isTypeAssertionExpression(expr)) {
    // Type-level only (`x as T`, `x satisfies T`, `<T>x`) — compile the inner expression
    compileExpression(ctx, fctx, expr.expression);
  } else if (ts.isTemplateExpression(expr)) {
    compileTemplateExpression(ctx, fctx, expr);
  } else if (ts.isConditionalExpression(expr)) {
    // ternary: cond ? then : else
    compileExpression(ctx, fctx, expr.condition);
    emitTruthyCoercion(fctx, inferExprType(ctx, fctx, expr.condition), { ctx, expr: expr.condition });

    const resultType = inferExprType(ctx, fctx, expr.whenTrue);

    const thenBody: Instr[] = [];
    const elseBody: Instr[] = [];
    const savedBody = fctx.body;

    fctx.body = thenBody;
    compileExpression(ctx, fctx, expr.whenTrue);
    fctx.body = elseBody;
    compileExpression(ctx, fctx, expr.whenFalse);
    // Ensure else branch matches the block result type
    const elseType = inferExprType(ctx, fctx, expr.whenFalse);
    if (resultType.kind === "f64" && elseType.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
    } else if (resultType.kind === "i32" && elseType.kind === "f64") {
      fctx.body.push({ op: "i32.trunc_f64_s" });
    }
    fctx.body = savedBody;
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: resultType },
      then: thenBody,
      else: elseBody,
    });
  } else if (ts.isObjectLiteralExpression(expr)) {
    compileObjectLiteral(ctx, fctx, expr);
  } else {
    // #1937 — fail-loud default arm: any expression kind without an explicit
    // arm above (typeof, await, spread, tagged templates, regex literals, …)
    // used to compile to ZERO instructions — a silent stack-arity hole that
    // surfaced, at best, as an opaque validator error far from the source.
    // Push a located diagnostic (the #1868 gate fails the compile) and a
    // placeholder value so downstream stack accounting stays balanced.
    ctx.errors.push({
      message: `Unsupported expression in linear backend: ${ts.SyntaxKind[expr.kind]}`,
      ...nodeLoc(expr),
    });
    fctx.body.push({ op: "f64.const", value: 0 });
  }
}

/** Check if a call expression returns void (using TypeChecker + compiled function fallback) */
function isCallVoid(ctx: LinearContext, expr: ts.CallExpression): boolean {
  // First try TypeChecker
  try {
    const callType = ctx.checker.getTypeAtLocation(expr);
    const typeStr = ctx.checker.typeToString(callType);
    if (typeStr === "void") return true;
  } catch {
    /* fall through */
  }
  // Fallback: check compiled function
  if (ts.isIdentifier(expr.expression)) {
    const funcName = expr.expression.text;
    const wasmFunc = ctx.mod.functions.find((f) => f.name === funcName);
    if (wasmFunc) {
      const funcType = ctx.mod.types[wasmFunc.typeIdx];
      if (funcType && funcType.kind === "func" && funcType.results.length === 0) return true;
    }
  }
  return false;
}

/**
 * Check if an expression produces no value (void) when compiled.
 * Used by expression statement handler to decide whether to emit `drop`.
 *
 * NOTE: Collection method calls (.push(), .set(), etc.) are NOT considered void
 * here because their handlers push a dummy value to match TS semantics.
 * Only direct function calls and class method calls that truly return void
 * are detected.
 */
function isVoidExpression(ctx: LinearContext, expr: ts.Expression): boolean {
  if (!ts.isCallExpression(expr)) return false;

  // For method calls (property access), use TypeChecker.
  // But skip collection methods (.push() etc.) — their handlers always push a value.
  if (ts.isPropertyAccessExpression(expr.expression)) {
    try {
      const callType = ctx.checker.getTypeAtLocation(expr);
      const typeStr = ctx.checker.typeToString(callType);
      if (typeStr === "void") return true;
    } catch {
      /* fall through */
    }
    return false;
  }

  // For direct function calls, check TypeChecker + compiled function
  return isCallVoid(ctx, expr);
}

/** Emit zero/default values for missing function arguments (for default params) */
function emitDefaultArgs(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  funcName: string,
  providedArgCount: number,
): void {
  const wasmFunc = ctx.mod.functions.find((f) => f.name === funcName);
  if (!wasmFunc) return;
  const funcType = ctx.mod.types[wasmFunc.typeIdx];
  if (!funcType || funcType.kind !== "func") return;
  const expectedArgCount = funcType.params.length;
  for (let i = providedArgCount; i < expectedArgCount; i++) {
    const paramType = funcType.params[i];
    if (paramType.kind === "i32") {
      fctx.body.push({ op: "i32.const", value: 0 });
    } else {
      fctx.body.push({ op: "f64.const", value: 0 });
    }
  }
}

/** Classify a TypeScript property type string into wasm field type */
function classifyFieldType(
  typeStr: string,
  baseType: ts.Type,
  collKinds: Map<string, "Array" | "Uint8Array" | "Map" | "Set">,
  propName: string,
): "i32" | "f64" {
  // Collection types → i32 pointer
  if (typeStr.endsWith("[]") || typeStr.startsWith("Array<")) {
    collKinds.set(propName, "Array");
    return "i32";
  }
  if (isUint8ArrayTypeText(typeStr) || typeStr.includes("Uint8Array")) {
    collKinds.set(propName, "Uint8Array");
    return "i32";
  }
  if (typeStr.startsWith("Map<") || typeStr === "Map") {
    collKinds.set(propName, "Map");
    return "i32";
  }
  if (typeStr.startsWith("Set<") || typeStr === "Set") {
    collKinds.set(propName, "Set");
    return "i32";
  }
  // Primitives
  if (typeStr === "string") return "i32"; // string = pointer
  if (typeStr === "number") return "f64";
  if (typeStr === "boolean") return "f64";
  // Numeric literal types (e.g., 0 | 1 | 2 | 3 | 4 | 5)
  if (/^\d+(\s*\|\s*\d+)*$/.test(typeStr)) return "f64";
  // Check TypeFlags for numeric types
  if (baseType.getFlags() & ts.TypeFlags.NumberLike) return "f64";
  if (baseType.getFlags() & ts.TypeFlags.BooleanLike) return "f64";
  // Everything else is a pointer (objects, arrays, etc.)
  return "i32";
}

/** Compile an object literal expression as a heap-allocated struct */
function compileObjectLiteral(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.ObjectLiteralExpression): void {
  // Determine the type name from the TypeChecker
  // Use contextual type (from variable annotation or parameter type) first,
  // since getTypeAtLocation on object literals returns the anonymous structural type
  let typeName: string | undefined;
  try {
    const ctxType = ctx.checker.getContextualType(expr);
    if (ctxType) {
      const sym = ctxType.getSymbol() ?? ctxType.aliasSymbol;
      if (sym) {
        const name = sym.getName();
        if (name && name !== "__object" && name !== "__type") typeName = name;
      }
    }
    // Fallback: check parent node for type annotation
    if (!typeName && expr.parent && ts.isVariableDeclaration(expr.parent) && expr.parent.type) {
      const annotText = expr.parent.type.getText();
      if (annotText && !annotText.includes("{")) typeName = annotText;
    }
    // Last resort: getTypeAtLocation
    if (!typeName) {
      const type = ctx.checker.getTypeAtLocation(expr);
      const sym = type.getSymbol() ?? type.aliasSymbol;
      if (sym) {
        const name = sym.getName();
        if (name && name !== "__object" && name !== "__type") typeName = name;
      }
    }
  } catch {
    /* ignore */
  }

  // Collect ALL property definitions from the interface type (not just the literal).
  // This ensures optional fields that get assigned later have proper offsets.
  const propDefs: { name: string; type: "i32" | "f64" }[] = [];
  const collKinds = new Map<string, "Array" | "Uint8Array" | "Map" | "Set">();

  // First, try to get all fields from the contextual/interface type
  let usedInterfaceFields = false;
  try {
    const ctxType = ctx.checker.getContextualType(expr) ?? ctx.checker.getTypeAtLocation(expr);
    if (ctxType) {
      const props = ctxType.getProperties();
      if (props && props.length > 0) {
        usedInterfaceFields = true;
        for (const prop of props) {
          const propName = prop.getName();
          // Determine the type of the property, stripping null/undefined
          const rawType = ctx.checker.getTypeOfSymbolAtLocation(prop, expr);
          const baseType = ctx.checker.getNonNullableType(rawType);
          const typeStr = ctx.checker.typeToString(baseType);
          // Classify the field type
          const fieldType = classifyFieldType(typeStr, baseType, collKinds, propName);
          propDefs.push({ name: propName, type: fieldType });
        }
      }
    }
  } catch {
    /* fall through to literal-based approach */
  }

  // Fallback: collect from literal properties if interface fields couldn't be resolved
  if (!usedInterfaceFields) {
    for (const prop of expr.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
        const propName = prop.name.text;
        const exprType = inferExprType(ctx, fctx, prop.initializer);
        propDefs.push({ name: propName, type: exprType.kind === "i32" ? "i32" : "f64" });
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        const propName = prop.name.text;
        const exprType = inferExprType(ctx, fctx, prop.name);
        propDefs.push({ name: propName, type: exprType.kind === "i32" ? "i32" : "f64" });
      }
    }
  }

  // Create or reuse a layout for this type
  if (typeName && !ctx.classLayouts.has(typeName)) {
    const layout = computeClassLayout(typeName, propDefs);
    for (const [k, v] of collKinds) layout.fieldCollectionKinds.set(k, v);
    ctx.classLayouts.set(typeName, layout);
  }

  // For anonymous types without a name, create an ephemeral layout from propDefs
  if (!typeName && propDefs.length > 0) {
    typeName = `__anon_${ctx.lambdaCounter++}`;
    const anonLayout = computeClassLayout(typeName, propDefs);
    for (const [k, v] of collKinds) anonLayout.fieldCollectionKinds.set(k, v);
    ctx.classLayouts.set(typeName, anonLayout);
  }

  // Use the layout to determine total size (includes ALL interface fields)
  const layout = typeName ? ctx.classLayouts.get(typeName) : undefined;
  const HEADER_SIZE = 8;
  const FIELD_SIZE = 8;
  const totalSize = layout ? layout.totalSize : HEADER_SIZE + FIELD_SIZE * propDefs.length;
  const mallocIdx = ctx.funcMap.get("__malloc")!;

  // Allocate (zeroed by __malloc)
  fctx.body.push({ op: "i32.const", value: totalSize });
  fctx.body.push({ op: "call", funcIdx: mallocIdx });

  // Store in a temp local
  const tmpLocal = addLocal(fctx, `__obj_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.tee", index: tmpLocal });

  // Store header: tag byte (use a generic tag, e.g., 0x10 for anonymous objects)
  fctx.body.push({ op: "i32.const", value: 0x10 });
  fctx.body.push({ op: "i32.store8", align: 0, offset: 0 });
  fctx.body.push({ op: "local.get", index: tmpLocal });
  fctx.body.push({ op: "i32.const", value: totalSize - HEADER_SIZE });
  fctx.body.push({ op: "i32.store", align: 2, offset: 4 });

  // Store each property from the literal (uses layout offsets when available)
  for (const prop of expr.properties) {
    let pName: string | undefined;
    let initExpr: ts.Expression | undefined;
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
      pName = prop.name.text;
      initExpr = prop.initializer;
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      pName = prop.name.text;
      initExpr = prop.name;
    }
    if (!pName || !initExpr) continue;

    const field = layout?.fields.get(pName);
    const fieldOffset = field ? field.offset : undefined;
    if (fieldOffset === undefined) continue; // skip unknown fields

    fctx.body.push({ op: "local.get", index: tmpLocal });
    compileExpression(ctx, fctx, initExpr);
    const valType = inferExprType(ctx, fctx, initExpr);
    if (field!.type === "i32") {
      if (valType.kind !== "i32") {
        fctx.body.push({ op: "i32.trunc_f64_s" });
      }
      fctx.body.push({ op: "i32.store", align: 2, offset: fieldOffset });
    } else {
      if (valType.kind === "i32") {
        fctx.body.push({ op: "f64.convert_i32_s" });
      }
      fctx.body.push({ op: "f64.store", align: 3, offset: fieldOffset });
    }
  }

  // Leave pointer on stack
  fctx.body.push({ op: "local.get", index: tmpLocal });
}

/**
 * Compile a function call argument. If the argument is an arrow function,
 * compile it as a lambda and emit the closure setup + table index.
 * Otherwise, just compile the expression normally.
 */
function compileCallArg(ctx: LinearContext, fctx: LinearFuncContext, arg: ts.Expression): void {
  if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
    emitClosureSetup(ctx, fctx, arg);
  } else {
    compileExpression(ctx, fctx, arg);
  }
}

function compileBinaryExpression(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.BinaryExpression): void {
  const op = expr.operatorToken.kind;

  // Handle assignment
  if (op === ts.SyntaxKind.EqualsToken) {
    // Handle element access assignment: arr[i] = v, u8[i] = v
    if (ts.isElementAccessExpression(expr.left)) {
      compileElementAccessAssignment(ctx, fctx, expr.left, expr.right);
      return;
    }
    // Handle property assignment: obj.field = value
    if (ts.isPropertyAccessExpression(expr.left)) {
      compilePropertyAssignment(ctx, fctx, expr.left, expr.right);
      return;
    }
    if (ts.isIdentifier(expr.left)) {
      const idx = fctx.localMap.get(expr.left.text);
      if (idx !== undefined) {
        compileExpression(ctx, fctx, expr.right);
        fctx.body.push({ op: "local.tee", index: idx });
        return;
      }
      // Check module globals
      const gIdx = ctx.moduleGlobals.get(expr.left.text);
      if (gIdx !== undefined) {
        compileExpression(ctx, fctx, expr.right);
        fctx.body.push({ op: "global.set", index: gIdx });
        fctx.body.push({ op: "global.get", index: gIdx });
        return;
      }
    }
  }

  // #1976: string `+=` is concatenation, not numeric add. `s += t` for string
  // `s` must call __str_concat (both operands are i32 pointers) and store the
  // i32 result — the generic compound path below emits f64.add, which produces
  // an invalid module (i32/f64 mismatch). Handle local and global string LHS.
  if (op === ts.SyntaxKind.PlusEqualsToken && ts.isIdentifier(expr.left) && isStringExpr(ctx, fctx, expr.left)) {
    const strConcatIdx = ctx.funcMap.get("__str_concat");
    const localIdx = fctx.localMap.get(expr.left.text);
    if (strConcatIdx !== undefined && localIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: localIdx });
      compileExpression(ctx, fctx, expr.right);
      fctx.body.push({ op: "call", funcIdx: strConcatIdx });
      fctx.body.push({ op: "local.tee", index: localIdx });
      return;
    }
    const gIdx = ctx.moduleGlobals.get(expr.left.text);
    if (strConcatIdx !== undefined && gIdx !== undefined) {
      fctx.body.push({ op: "global.get", index: gIdx });
      compileExpression(ctx, fctx, expr.right);
      fctx.body.push({ op: "call", funcIdx: strConcatIdx });
      fctx.body.push({ op: "global.set", index: gIdx });
      fctx.body.push({ op: "global.get", index: gIdx });
      return;
    }
  }

  // Handle compound assignment (+=, -=, *=, /=, |=, &=, etc.)
  if (isCompoundAssignment(op) && ts.isIdentifier(expr.left)) {
    const idx = fctx.localMap.get(expr.left.text);
    if (idx !== undefined) {
      if (isBitwiseCompoundAssignment(op)) {
        // Bitwise compound: operate in i32 (JS ToInt32 operands — #2715), store f64 result
        compileExprToInt32(ctx, fctx, expr.left);
        compileExprToInt32(ctx, fctx, expr.right);
        fctx.body.push(bitwiseOp(bitwiseCompoundToOp(op)));
        if (op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken) {
          fctx.body.push({ op: "f64.convert_i32_u" });
        } else {
          fctx.body.push({ op: "f64.convert_i32_s" });
        }
        fctx.body.push({ op: "local.tee", index: idx });
      } else {
        fctx.body.push({ op: "local.get", index: idx });
        compileExpression(ctx, fctx, expr.right);
        fctx.body.push(compoundAssignmentOp(op));
        fctx.body.push({ op: "local.tee", index: idx });
      }
      return;
    }
    // Check module globals for compound assignment
    const gIdx = ctx.moduleGlobals.get(expr.left.text);
    if (gIdx !== undefined) {
      fctx.body.push({ op: "global.get", index: gIdx });
      compileExpression(ctx, fctx, expr.right);
      fctx.body.push(compoundAssignmentOp(op));
      fctx.body.push({ op: "global.set", index: gIdx });
      fctx.body.push({ op: "global.get", index: gIdx });
      return;
    }
  }

  // Handle compound assignment on property access (e.g. this.pos += n)
  if (isCompoundAssignment(op) && ts.isPropertyAccessExpression(expr.left)) {
    const propName = expr.left.name.text;
    const className = inferClassName(ctx, fctx, expr.left.expression);
    if (className) {
      const layout = ctx.classLayouts.get(className);
      const field = layout?.fields.get(propName);
      if (field) {
        // Load current value: obj.field
        compileExpression(ctx, fctx, expr.left.expression);
        const objLocal = addLocal(fctx, `$compound_obj`, { kind: "i32" });
        fctx.body.push({ op: "local.tee", index: objLocal });
        if (field.type === "f64") {
          fctx.body.push({ op: "f64.load", align: 3, offset: field.offset });
        } else {
          fctx.body.push({ op: "i32.load", align: 2, offset: field.offset });
        }
        // Compute new value: current op rhs
        compileExpression(ctx, fctx, expr.right);
        fctx.body.push(compoundAssignmentOp(op));
        // Store new value back
        const tempLocal = addLocal(fctx, `$compound_val`, field.type === "f64" ? { kind: "f64" } : { kind: "i32" });
        fctx.body.push({ op: "local.tee", index: tempLocal });
        // Swap: need obj ptr on stack first, then value
        const objLocal2 = objLocal; // reuse
        fctx.body.push({ op: "local.set", index: tempLocal }); // save value
        fctx.body.push({ op: "local.get", index: objLocal2 }); // obj ptr
        fctx.body.push({ op: "local.get", index: tempLocal }); // value
        if (field.type === "f64") {
          fctx.body.push({ op: "f64.store", align: 3, offset: field.offset });
        } else {
          fctx.body.push({ op: "i32.store", align: 2, offset: field.offset });
        }
        // Leave value on stack as expression result
        fctx.body.push({ op: "local.get", index: tempLocal });
        return;
      }
    }
  }

  // Bitwise operators: ToInt32 both operands per JS spec (#2715: NaN/∞/large
  // wrap mod 2^32, never trap — `(0/0)|0 === 0`).
  if (isBitwiseOp(op)) {
    compileExprToInt32(ctx, fctx, expr.left);
    compileExprToInt32(ctx, fctx, expr.right);
    fctx.body.push(bitwiseOp(op));
    // Unsigned right shift converts back with unsigned conversion
    if (op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken) {
      fctx.body.push({ op: "f64.convert_i32_u" });
    } else {
      fctx.body.push({ op: "f64.convert_i32_s" });
    }
    return;
  }

  // Check for comparison with undefined/null — use type-appropriate zero check
  const isUndefinedOrNull = (e: ts.Expression) =>
    (ts.isIdentifier(e) && e.text === "undefined") || e.kind === ts.SyntaxKind.NullKeyword;
  if (isComparisonOp(op) && (isUndefinedOrNull(expr.left) || isUndefinedOrNull(expr.right))) {
    const valueExpr = isUndefinedOrNull(expr.left) ? expr.right : expr.left;
    const valueType = inferExprType(ctx, fctx, valueExpr);
    compileExpression(ctx, fctx, valueExpr);
    if (valueType.kind === "i32") {
      fctx.body.push({ op: "i32.const", value: 0 });
      if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) {
        fctx.body.push({ op: "i32.eq" });
      } else {
        fctx.body.push({ op: "i32.ne" });
      }
    } else {
      // For f64 optional fields, use f64.const 0 as sentinel for undefined
      fctx.body.push({ op: "f64.const", value: 0 });
      if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) {
        fctx.body.push({ op: "f64.eq" });
      } else {
        fctx.body.push({ op: "f64.ne" });
      }
    }
    fctx.body.push({ op: "f64.convert_i32_s" });
    return;
  }

  // Check if both sides are string expressions — use string ops
  if (isStringExpr(ctx, fctx, expr.left) && isStringExpr(ctx, fctx, expr.right)) {
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) {
      compileExpression(ctx, fctx, expr.left);
      compileExpression(ctx, fctx, expr.right);
      const strEqIdx = ctx.funcMap.get("__str_eq")!;
      fctx.body.push({ op: "call", funcIdx: strEqIdx });
      // __str_eq returns i32 (0 or 1), convert to f64
      fctx.body.push({ op: "f64.convert_i32_s" });
      return;
    }
    if (op === ts.SyntaxKind.PlusToken) {
      compileExpression(ctx, fctx, expr.left);
      compileExpression(ctx, fctx, expr.right);
      const strConcatIdx = ctx.funcMap.get("__str_concat")!;
      fctx.body.push({ op: "call", funcIdx: strConcatIdx });
      return;
    }
    // #1976: string relationals (`<`/`<=`/`>`/`>=`) must compare by content, not
    // by pointer address. Route through __str_cmp (-1/0/1) then test the sign;
    // the result is an f64 boolean to match the rest of the expression lowering.
    if (
      op === ts.SyntaxKind.LessThanToken ||
      op === ts.SyntaxKind.LessThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanToken ||
      op === ts.SyntaxKind.GreaterThanEqualsToken
    ) {
      compileExpression(ctx, fctx, expr.left);
      compileExpression(ctx, fctx, expr.right);
      const strCmpIdx = ctx.funcMap.get("__str_cmp")!;
      fctx.body.push({ op: "call", funcIdx: strCmpIdx });
      fctx.body.push({ op: "i32.const", value: 0 });
      switch (op) {
        case ts.SyntaxKind.LessThanToken:
          fctx.body.push({ op: "i32.lt_s" });
          break;
        case ts.SyntaxKind.LessThanEqualsToken:
          fctx.body.push({ op: "i32.le_s" });
          break;
        case ts.SyntaxKind.GreaterThanToken:
          fctx.body.push({ op: "i32.gt_s" });
          break;
        default: // GreaterThanEqualsToken
          fctx.body.push({ op: "i32.ge_s" });
          break;
      }
      fctx.body.push({ op: "f64.convert_i32_s" });
      return;
    }
  }

  // Logical AND / OR: short-circuit evaluation yielding the OPERAND value
  // (#2184). JS `a || b` ⇒ `ToBoolean(a) ? a : b`; `a && b` ⇒
  // `ToBoolean(a) ? b : a`. The result is an *operand*, not a 0/1 boolean —
  // earlier lowering coerced to f64 and pushed `0`/`1` constants on the
  // short-circuit arm, which discarded the value (`"" || "x"` returned `0`
  // instead of `"x"`, `0 || 42` returned `1` instead of `42`).
  //
  // The boolean-context use (`if (a || b)`, `while`, `?:` condition) is handled
  // by callers that run emitTruthyCoercion on the result, so yielding the real
  // operand value stays correct there too (ToBoolean(operand) is what JS does).
  if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
    const leftType = inferExprType(ctx, fctx, expr.left);
    const rightType = inferExprType(ctx, fctx, expr.right);

    // Mixed-type operands (e.g. string `i32` vs number `f64`) can't share a
    // single `if` result ValType without a boxed/`any` representation: coercing
    // a string POINTER to f64 would corrupt both the value and its downstream
    // truthiness (a nonzero pointer reads as truthy even for `""`). This is the
    // documented same-typed-first scope (#2184) — for mixed types keep the
    // legacy boolean-producing lowering, which is correct in boolean context
    // (the dominant mixed-type use; #1975). A follow-up covers mixed values.
    if (leftType.kind !== rightType.kind) {
      compileExpression(ctx, fctx, expr.left);
      emitTruthyCoercion(fctx, leftType, { ctx, expr: expr.left });
      const thenBodyM: Instr[] = [];
      const elseBodyM: Instr[] = [];
      const savedBodyM = fctx.body;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
        fctx.body = thenBodyM;
        compileExprToF64(ctx, fctx, expr.right);
        fctx.body = savedBodyM;
        elseBodyM.push({ op: "f64.const", value: 0 });
      } else {
        thenBodyM.push({ op: "f64.const", value: 1 });
        fctx.body = elseBodyM;
        compileExprToF64(ctx, fctx, expr.right);
        fctx.body = savedBodyM;
      }
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "f64" } },
        then: thenBodyM,
        else: elseBodyM,
      });
      return;
    }

    // Same-typed operands carry their native value type (string i32-pointer,
    // f64, bool i32). Hold the LHS in a temp so its value is available on the
    // short-circuit arm after it has been consumed by the truthiness test.
    const resultType: ValType = leftType;
    const leftTemp = addLocal(fctx, `__logical_lhs_${fctx.locals.length}`, leftType);
    compileExpression(ctx, fctx, expr.left);
    fctx.body.push({ op: "local.tee", index: leftTemp });
    emitTruthyCoercion(fctx, leftType, { ctx, expr: expr.left });

    const emitLeftAsResult = () => {
      fctx.body.push({ op: "local.get", index: leftTemp });
    };
    const emitRightAsResult = () => {
      compileExpression(ctx, fctx, expr.right);
    };

    const thenBody: Instr[] = [];
    const elseBody: Instr[] = [];
    const savedBody = fctx.body;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      // &&: left truthy → right; else → left
      fctx.body = thenBody;
      emitRightAsResult();
      fctx.body = elseBody;
      emitLeftAsResult();
      fctx.body = savedBody;
    } else {
      // ||: left truthy → left; else → right
      fctx.body = thenBody;
      emitLeftAsResult();
      fctx.body = elseBody;
      emitRightAsResult();
      fctx.body = savedBody;
    }
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: resultType },
      then: thenBody,
      else: elseBody,
    });
    return;
  }

  // Check if both operands are i32 (pointers/non-numeric) for comparison ops
  const leftType = inferExprType(ctx, fctx, expr.left);
  const rightType = inferExprType(ctx, fctx, expr.right);
  const bothI32 = leftType.kind === "i32" && rightType.kind === "i32";

  if (bothI32 && isComparisonOp(op)) {
    // Use i32 comparison operators for pointer/non-numeric types
    compileExpression(ctx, fctx, expr.left);
    compileExpression(ctx, fctx, expr.right);
    switch (op) {
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsToken:
        fctx.body.push({ op: "i32.eq" });
        break;
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken:
        fctx.body.push({ op: "i32.ne" });
        break;
      case ts.SyntaxKind.LessThanToken:
        fctx.body.push({ op: "i32.lt_s" });
        break;
      case ts.SyntaxKind.LessThanEqualsToken:
        fctx.body.push({ op: "i32.le_s" });
        break;
      case ts.SyntaxKind.GreaterThanToken:
        fctx.body.push({ op: "i32.gt_s" });
        break;
      case ts.SyntaxKind.GreaterThanEqualsToken:
        fctx.body.push({ op: "i32.ge_s" });
        break;
    }
    // i32 comparison returns i32, convert to f64 like other comparisons
    fctx.body.push({ op: "f64.convert_i32_s" });
    return;
  }

  // Regular binary: compile both sides
  compileExpression(ctx, fctx, expr.left);
  compileExpression(ctx, fctx, expr.right);

  switch (op) {
    case ts.SyntaxKind.PlusToken:
      fctx.body.push({ op: "f64.add" });
      break;
    case ts.SyntaxKind.MinusToken:
      fctx.body.push({ op: "f64.sub" });
      break;
    case ts.SyntaxKind.AsteriskToken:
      fctx.body.push({ op: "f64.mul" });
      break;
    case ts.SyntaxKind.SlashToken:
      fctx.body.push({ op: "f64.div" });
      break;
    case ts.SyntaxKind.PercentToken: {
      // #2144 — call the `__fmod` runtime helper (exact IEEE-754 remainder,
      // shared algorithm with the WasmGC backend's #2056 work). The previous
      // inline `a - trunc(a/b)*b` formula (#1937) diverged from JS / the GC
      // backend: it produced `±Infinity` for extreme ratios (ratio ≳ 1e308,
      // e.g. `1e308 % 1e-308`), `NaN` for `x % Infinity` (0*Inf), and drifted
      // by ULPs / collapsed to 0 when the intermediate rounded. `__fmod`
      // handles all those cases exactly. Operands are already on the stack in
      // (a, b) order — the helper's signature is `(f64 a, f64 b) -> f64`.
      const fmodIdx = ctx.funcMap.get(FMOD_FN)!;
      fctx.body.push({ op: "call", funcIdx: fmodIdx });
      break;
    }
    case ts.SyntaxKind.LessThanToken:
      fctx.body.push({ op: "f64.lt" });
      break;
    case ts.SyntaxKind.LessThanEqualsToken:
      fctx.body.push({ op: "f64.le" });
      break;
    case ts.SyntaxKind.GreaterThanToken:
      fctx.body.push({ op: "f64.gt" });
      break;
    case ts.SyntaxKind.GreaterThanEqualsToken:
      fctx.body.push({ op: "f64.ge" });
      break;
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      fctx.body.push({ op: "f64.eq" });
      break;
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      fctx.body.push({ op: "f64.ne" });
      break;
    default:
      ctx.errors.push({
        message: `Unsupported binary operator: ${ts.SyntaxKind[op]}`,
        ...nodeLoc(expr),
      });
      // Both operands are already on the stack — collapse them to one
      // placeholder value so downstream stack accounting stays balanced
      // (the #1868 gate fails the compile regardless).
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "f64.const", value: 0 });
  }

  // Comparison operators return i32 (0 or 1), convert to f64
  if (isComparisonOp(op)) {
    fctx.body.push({ op: "f64.convert_i32_s" });
  }
}

function isComparisonOp(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.LessThanToken ||
    op === ts.SyntaxKind.LessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanEqualsToken ||
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.EqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken
  );
}

function isBitwiseOp(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.AmpersandToken ||
    op === ts.SyntaxKind.BarToken ||
    op === ts.SyntaxKind.CaretToken ||
    op === ts.SyntaxKind.LessThanLessThanToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken
  );
}

function bitwiseOp(op: ts.SyntaxKind): Instr {
  switch (op) {
    case ts.SyntaxKind.AmpersandToken:
      return { op: "i32.and" };
    case ts.SyntaxKind.BarToken:
      return { op: "i32.or" };
    case ts.SyntaxKind.CaretToken:
      return { op: "i32.xor" };
    case ts.SyntaxKind.LessThanLessThanToken:
      return { op: "i32.shl" };
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
      return { op: "i32.shr_s" };
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      return { op: "i32.shr_u" };
    default:
      return { op: "unreachable" };
  }
}

/** Convert a bitwise compound assignment token to its corresponding bitwise operator token */
function bitwiseCompoundToOp(op: ts.SyntaxKind): ts.SyntaxKind {
  switch (op) {
    case ts.SyntaxKind.BarEqualsToken:
      return ts.SyntaxKind.BarToken;
    case ts.SyntaxKind.AmpersandEqualsToken:
      return ts.SyntaxKind.AmpersandToken;
    case ts.SyntaxKind.CaretEqualsToken:
      return ts.SyntaxKind.CaretToken;
    case ts.SyntaxKind.LessThanLessThanEqualsToken:
      return ts.SyntaxKind.LessThanLessThanToken;
    case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
      return ts.SyntaxKind.GreaterThanGreaterThanToken;
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
      return ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken;
    default:
      return op;
  }
}

function isCompoundAssignment(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.PlusEqualsToken ||
    op === ts.SyntaxKind.MinusEqualsToken ||
    op === ts.SyntaxKind.AsteriskEqualsToken ||
    op === ts.SyntaxKind.SlashEqualsToken ||
    op === ts.SyntaxKind.BarEqualsToken ||
    op === ts.SyntaxKind.AmpersandEqualsToken ||
    op === ts.SyntaxKind.CaretEqualsToken ||
    op === ts.SyntaxKind.LessThanLessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken
  );
}

/** Is this a bitwise compound assignment (|=, &=, ^=, <<=, >>=, >>>=)? */
function isBitwiseCompoundAssignment(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.BarEqualsToken ||
    op === ts.SyntaxKind.AmpersandEqualsToken ||
    op === ts.SyntaxKind.CaretEqualsToken ||
    op === ts.SyntaxKind.LessThanLessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken
  );
}

function compoundAssignmentOp(op: ts.SyntaxKind): Instr {
  switch (op) {
    case ts.SyntaxKind.PlusEqualsToken:
      return { op: "f64.add" };
    case ts.SyntaxKind.MinusEqualsToken:
      return { op: "f64.sub" };
    case ts.SyntaxKind.AsteriskEqualsToken:
      return { op: "f64.mul" };
    case ts.SyntaxKind.SlashEqualsToken:
      return { op: "f64.div" };
    default:
      return { op: "unreachable" };
  }
}

/** Convert a value to i32 truthiness (for conditions) */
function emitTruthyCoercion(
  fctx: LinearFuncContext,
  type: ValType,
  opts?: { ctx: LinearContext; expr: ts.Expression },
): void {
  if (type.kind === "f64") {
    // f64 → i32: abs(value) > 0.0. The previous `value != 0` test made NaN
    // truthy (NaN != 0 is true); JS ToBoolean(NaN) is false (#1937).
    // abs folds -0 to 0 and NaN > 0 is false, so this covers 0, -0 and NaN.
    fctx.body.push({ op: "f64.abs" });
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.gt" });
  } else if (type.kind === "i32") {
    // #1975: a string value is an i32 POINTER (always nonzero), so raw i32
    // truthiness would make every string — including "" — truthy. JS
    // ToBoolean(string) is `length !== 0`, so for a string-typed expression
    // replace the pointer on the stack with `__str_len(ptr) != 0`. Non-string
    // i32 values (numbers-as-i32, booleans) keep raw i32 truthiness.
    if (opts !== undefined && isStringExpr(opts.ctx, fctx, opts.expr)) {
      const strLenIdx = opts.ctx.funcMap.get("__str_len");
      if (strLenIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: strLenIdx });
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "i32.ne" });
      }
    }
    // else: already i32, no conversion needed
  }
}

// ── Collection detection ──────────────────────────────────────────────

/** Detect whether a variable declaration is a collection type */
function detectCollectionKind(ctx: LinearContext, decl: ts.VariableDeclaration): CollectionKind | null {
  // Check type annotation: number[], Array<number>, Uint8Array, Map<K,V>, Set<V>
  if (decl.type) {
    const text = decl.type.getText();
    if (text === "number[]" || text.startsWith("Array<")) return "Array";
    if (isUint8ArrayTypeText(text)) return "Uint8Array";
    if (text.startsWith("Map<") || text === "Map") return "Map";
    if (text.startsWith("Set<") || text === "Set") return "Set";
  }
  // Check initializer: [], [a,b], new Uint8Array(), new Map(), new Set()
  if (decl.initializer) {
    if (ts.isArrayLiteralExpression(decl.initializer)) return "Array";
    if (ts.isNewExpression(decl.initializer) && ts.isIdentifier(decl.initializer.expression)) {
      const ctorName = decl.initializer.expression.text;
      if (ctorName === "Uint8Array") return "Uint8Array";
      if (ctorName === "Map") return "Map";
      if (ctorName === "Set") return "Set";
    }
    // Detect new TextEncoder().encode(...) → Uint8Array
    if (ts.isCallExpression(decl.initializer) && ts.isPropertyAccessExpression(decl.initializer.expression)) {
      const pa = decl.initializer.expression;
      if (
        pa.name.text === "encode" &&
        ts.isNewExpression(pa.expression) &&
        ts.isIdentifier(pa.expression.expression) &&
        pa.expression.expression.text === "TextEncoder"
      ) {
        return "Uint8Array";
      }
    }
    // Use TypeChecker for initializer expressions (handles method calls, etc.)
    try {
      const rawType = ctx.checker.getTypeAtLocation(decl.initializer);
      const type = ctx.checker.getNonNullableType(rawType);
      const typeStr = ctx.checker.typeToString(type);
      if (isUint8ArrayTypeText(typeStr) || typeStr.includes("Uint8Array")) return "Uint8Array";
      if (typeStr.startsWith("Map<") || typeStr === "Map") return "Map";
      if (typeStr.startsWith("Set<") || typeStr === "Set") return "Set";
      if (typeStr === "number[]" || typeStr.endsWith("[]") || typeStr.startsWith("Array<")) return "Array";
    } catch {
      /* fall through */
    }
  }
  return null;
}

/** Get the collection kind for an expression (typically an identifier) */
function getExprCollectionKind(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.Expression,
): CollectionKind | null {
  if (ts.isIdentifier(expr)) {
    return fctx.collectionTypes.get(expr.text) ?? ctx.moduleCollectionTypes.get(expr.text) ?? null;
  }
  // Handle property access on class instances: this.data or obj.items
  if (ts.isPropertyAccessExpression(expr)) {
    const className = inferClassName(ctx, fctx, expr.expression);
    if (className) {
      const layout = ctx.classLayouts.get(className);
      if (layout) {
        const kind = layout.fieldCollectionKinds.get(expr.name.text);
        if (kind) return kind;
      }
    }
  }
  // Array literal expressions are always arrays
  if (ts.isArrayLiteralExpression(expr)) {
    return "Array";
  }
  // new Map() / new Set() / new Uint8Array()
  if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression)) {
    const name = expr.expression.text;
    if (name === "Map") return "Map";
    if (name === "Set") return "Set";
    if (name === "Uint8Array") return "Uint8Array";
  }
  // TypeChecker fallback for method calls and other expressions
  try {
    const rawType = ctx.checker.getTypeAtLocation(expr);
    const type = ctx.checker.getNonNullableType(rawType);
    const typeStr = ctx.checker.typeToString(type);
    if (isUint8ArrayTypeText(typeStr) || typeStr.includes("Uint8Array")) return "Uint8Array";
    if (typeStr.startsWith("Map<") || typeStr === "Map") return "Map";
    if (typeStr.startsWith("Set<") || typeStr === "Set") return "Set";
    if (typeStr.endsWith("[]") || typeStr.startsWith("Array<")) return "Array";
  } catch {
    /* fall through */
  }
  return null;
}

// ── Array literal ────────────────────────────────────────────────────

function compileArrayLiteral(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.ArrayLiteralExpression): void {
  const elements = expr.elements;
  const cap = Math.max(elements.length, 16);
  const arrNewIdx = ctx.funcMap.get("__arr_new")!;
  const arrPushIdx = ctx.funcMap.get("__arr_push")!;

  // Create array: __arr_new(cap) → i32 ptr
  fctx.body.push({ op: "i32.const", value: cap });
  fctx.body.push({ op: "call", funcIdx: arrNewIdx });

  if (elements.length > 0) {
    // Store ptr in a temp local so we can push elements
    const tmpLocal = addLocal(fctx, `__arr_tmp_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.set", index: tmpLocal });

    for (const elem of elements) {
      fctx.body.push({ op: "local.get", index: tmpLocal });
      // #1938: __arr_push takes an f64 slot. A numeric element flows straight
      // in as its f64 value (no truncation); a ref/bool element is compiled to
      // i32 and encoded into the low 4 bytes of the slot.
      if (inferExprType(ctx, fctx, elem).kind === "f64") {
        compileExprToF64(ctx, fctx, elem);
      } else {
        compileExprToI32(ctx, fctx, elem);
        pushI32ToSlot(fctx);
      }
      fctx.body.push({ op: "call", funcIdx: arrPushIdx });
    }

    // Leave the array pointer on the stack as the expression result
    fctx.body.push({ op: "local.get", index: tmpLocal });
  }
  // If empty array, __arr_new already left ptr on stack
}

// ── Array destructuring ──────────────────────────────────────────────

function compileObjectDestructuring(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  pattern: ts.ObjectBindingPattern,
  initializer: ts.Expression,
): void {
  // Compile initializer to get object pointer
  compileExpression(ctx, fctx, initializer);
  const objLocal = addLocal(fctx, `__obj_destr_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.set", index: objLocal });

  // Use TypeChecker to get the type of the initializer and compute field offsets
  let objType: ts.Type | null = null;
  try {
    objType = ctx.checker.getTypeAtLocation(initializer);
  } catch {
    /* ignore */
  }

  // Build property list with offsets (matching the TypeChecker-based property access fallback)
  const propOffsets = new Map<string, { offset: number; type: "i32" | "f64" }>();
  if (objType) {
    const props = objType.getProperties();
    let offset = 0;
    for (const prop of props) {
      let isF64 = false;
      try {
        const propType = ctx.checker.getTypeOfSymbolAtLocation(prop, initializer);
        const baseType = ctx.checker.getNonNullableType(propType);
        if (baseType.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) {
          isF64 = true;
        }
      } catch {
        /* default: i32 */
      }
      const fieldSize = isF64 ? 8 : 4;
      if (isF64 && offset % 8 !== 0) offset = Math.ceil(offset / 8) * 8;
      else if (!isF64 && offset % 4 !== 0) offset = Math.ceil(offset / 4) * 4;
      propOffsets.set(prop.getName(), { offset, type: isF64 ? "f64" : "i32" });
      offset += fieldSize;
    }
  }

  // For each binding element, extract the property value
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (!ts.isBindingElement(element)) continue;

    // Get property name and variable name
    const propName =
      element.propertyName && ts.isIdentifier(element.propertyName)
        ? element.propertyName.text
        : ts.isIdentifier(element.name)
          ? element.name.text
          : null;
    const varName = ts.isIdentifier(element.name) ? element.name.text : null;

    if (!propName || !varName) continue;

    const fieldInfo = propOffsets.get(propName);
    if (!fieldInfo) {
      ctx.errors.push({ message: `Object destructuring: unknown property "${propName}"`, ...nodeLoc(element) });
      continue;
    }

    const localType: ValType = fieldInfo.type === "f64" ? { kind: "f64" } : { kind: "i32" };
    const localIdx = addLocal(fctx, varName, localType);

    // Load field from object
    fctx.body.push({ op: "local.get", index: objLocal });
    if (fieldInfo.type === "f64") {
      fctx.body.push({ op: "f64.load", align: 3, offset: fieldInfo.offset });
    } else {
      fctx.body.push({ op: "i32.load", align: 2, offset: fieldInfo.offset });
    }
    fctx.body.push({ op: "local.set", index: localIdx });

    // Track collection types
    try {
      const propType = ctx.checker.getTypeAtLocation(element);
      const typeStr = ctx.checker.typeToString(ctx.checker.getNonNullableType(propType));
      if (typeStr.endsWith("[]")) fctx.collectionTypes.set(varName, "Array");
    } catch {
      /* ignore */
    }
  }
}

function compileArrayDestructuring(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  pattern: ts.ArrayBindingPattern,
  initializer: ts.Expression,
): void {
  // Compile the initializer (the array expression)
  compileExpression(ctx, fctx, initializer);
  const arrLocal = addLocal(fctx, `__destr_arr_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.set", index: arrLocal });

  const arrGetIdx = ctx.funcMap.get("__arr_get")!;

  // Determine element type via TypeChecker
  let elemIsI32 = false;
  try {
    const type = ctx.checker.getTypeAtLocation(initializer);
    const typeStr = ctx.checker.typeToString(ctx.checker.getNonNullableType(type));
    if (typeStr.endsWith("[]") && !typeStr.startsWith("number") && !typeStr.startsWith("boolean")) {
      elemIsI32 = true;
    }
    if (typeStr === "string[]") elemIsI32 = true;
  } catch {
    /* default: f64 */
  }

  for (let i = 0; i < pattern.elements.length; i++) {
    const element = pattern.elements[i];
    if (ts.isOmittedExpression(element)) continue;
    if (!ts.isBindingElement(element)) continue;

    // Check for rest element: ...name
    if (element.dotDotDotToken) {
      if (ts.isIdentifier(element.name)) {
        const varName = element.name.text;
        const localIdx = addLocal(fctx, varName, { kind: "i32" });
        // rest = __arr_slice(arr, i, __arr_len(arr))
        const arrSliceIdx = ctx.funcMap.get("__arr_slice")!;
        const arrLenIdx = ctx.funcMap.get("__arr_len")!;
        fctx.body.push({ op: "local.get", index: arrLocal });
        fctx.body.push({ op: "i32.const", value: i });
        fctx.body.push({ op: "local.get", index: arrLocal });
        fctx.body.push({ op: "call", funcIdx: arrLenIdx });
        fctx.body.push({ op: "call", funcIdx: arrSliceIdx });
        fctx.body.push({ op: "local.set", index: localIdx });
        // Register as Array collection type
        fctx.collectionTypes.set(varName, "Array");
      }
      continue;
    }

    if (ts.isIdentifier(element.name)) {
      const varName = element.name.text;
      const localIdx = addLocal(fctx, varName, elemIsI32 ? { kind: "i32" } : { kind: "f64" });

      // x = __arr_get(arr, i) → f64 slot (#1938)
      fctx.body.push({ op: "local.get", index: arrLocal });
      fctx.body.push({ op: "i32.const", value: i });
      fctx.body.push({ op: "call", funcIdx: arrGetIdx });
      if (elemIsI32) {
        pushSlotToI32(fctx); // ref/string slot → i32 handle
      }
      fctx.body.push({ op: "local.set", index: localIdx });
    }
  }
}

// ── NewExpression ────────────────────────────────────────────────────

function compileNewExpression(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.NewExpression): void {
  if (!ts.isIdentifier(expr.expression)) {
    ctx.errors.push({ message: "Unsupported new expression", ...nodeLoc(expr) });
    return;
  }
  const ctorName = expr.expression.text;

  if (ctorName === "Uint8Array") {
    if (expr.arguments && expr.arguments.length > 0) {
      const argType = inferExprType(ctx, fctx, expr.arguments[0]);
      // Check if arg is an ArrayBuffer (i32 pointer) vs a number (f64 size)
      // ArrayBuffer variables are i32 pointers; numeric sizes are f64
      // Use TypeChecker to distinguish
      let isArrayBuffer = false;
      try {
        const argTsType = ctx.checker.getTypeAtLocation(expr.arguments[0]);
        const argTypeStr = ctx.checker.typeToString(argTsType);
        isArrayBuffer = argTypeStr === "ArrayBuffer";
      } catch {
        /* fallback: not ArrayBuffer */
      }

      if (isArrayBuffer) {
        // new Uint8Array(arrayBuffer) → __u8arr_from_raw(buf+4, buf[0])
        const fromRawIdx = ctx.funcMap.get("__u8arr_from_raw")!;
        const abTmp = addLocal(fctx, "$u8_ab_tmp", { kind: "i32" });
        compileExpression(ctx, fctx, expr.arguments[0]); // buf ptr
        fctx.body.push({ op: "local.tee", index: abTmp });
        fctx.body.push({ op: "i32.const", value: 4 });
        fctx.body.push({ op: "i32.add" }); // data = buf + 4
        fctx.body.push({ op: "local.get", index: abTmp });
        fctx.body.push({ op: "i32.load", align: 2, offset: 0 }); // len = buf[0]
        fctx.body.push({ op: "call", funcIdx: fromRawIdx });
      } else {
        // Check if arg is a number[] (array) → __u8arr_from_arr(arrPtr)
        let isNumberArray = false;
        try {
          const argTypeStr = ctx.checker.typeToString(ctx.checker.getTypeAtLocation(expr.arguments[0]));
          isNumberArray = argTypeStr === "number[]" || argTypeStr.endsWith("[]");
        } catch {
          /* fallback */
        }
        if (isNumberArray) {
          const fromArrIdx = ctx.funcMap.get("__u8arr_from_arr")!;
          compileExpression(ctx, fctx, expr.arguments[0]);
          fctx.body.push({ op: "call", funcIdx: fromArrIdx });
        } else {
          // new Uint8Array(n) → __u8arr_new(n)
          const u8NewIdx = ctx.funcMap.get("__u8arr_new")!;
          compileExprToI32(ctx, fctx, expr.arguments[0]);
          fctx.body.push({ op: "call", funcIdx: u8NewIdx });
        }
      }
    } else {
      const u8NewIdx = ctx.funcMap.get("__u8arr_new")!;
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "call", funcIdx: u8NewIdx });
    }
  } else if (ctorName === "ArrayBuffer") {
    // new ArrayBuffer(n) → allocate [len:i32 at +0][data at +4], return pointer
    const mallocIdx = ctx.funcMap.get("__malloc")!;
    const tmpPtr = addLocal(fctx, "$ab_ptr", { kind: "i32" });
    if (expr.arguments && expr.arguments.length > 0) {
      compileExprToI32(ctx, fctx, expr.arguments[0]);
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    // Allocate 4 + n bytes (4 for the length prefix)
    const tmpLen = addLocal(fctx, "$ab_len", { kind: "i32" });
    fctx.body.push({ op: "local.tee", index: tmpLen });
    fctx.body.push({ op: "i32.const", value: 4 });
    fctx.body.push({ op: "i32.add" });
    fctx.body.push({ op: "call", funcIdx: mallocIdx });
    fctx.body.push({ op: "local.tee", index: tmpPtr });
    // Store length at offset 0
    fctx.body.push({ op: "local.get", index: tmpLen });
    fctx.body.push({ op: "i32.store", align: 2, offset: 0 });
    fctx.body.push({ op: "local.get", index: tmpPtr });
  } else if (ctorName === "Float64Array" || ctorName === "Float32Array") {
    // new Float64Array(buf) / new Float32Array(buf) → returns buf+4 (data pointer)
    // The ArrayBuffer layout is [len at +0][data at +4]
    if (expr.arguments && expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]);
      fctx.body.push({ op: "i32.const", value: 4 });
      fctx.body.push({ op: "i32.add" }); // skip length prefix to get data ptr
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
  } else if (ctorName === "Map") {
    // new Map(): call __nmap_new(16) with default capacity
    const nmapNewIdx = ctx.funcMap.get("__nmap_new")!;
    fctx.body.push({ op: "i32.const", value: 16 });
    fctx.body.push({ op: "call", funcIdx: nmapNewIdx });
  } else if (ctorName === "Set") {
    // new Set(): call __nset_new(16) with default capacity
    const nsetNewIdx = ctx.funcMap.get("__nset_new")!;
    fctx.body.push({ op: "i32.const", value: 16 });
    fctx.body.push({ op: "call", funcIdx: nsetNewIdx });
  } else {
    // Check if it's a known class
    const layout = ctx.classLayouts.get(ctorName);
    if (layout) {
      compileClassNewExpression(ctx, fctx, expr, ctorName, layout);
    } else {
      ctx.errors.push({ message: `Unsupported constructor: ${ctorName}`, ...nodeLoc(expr) });
    }
  }
}

// ── PropertyAccessExpression ─────────────────────────────────────────

function compilePropertyAccess(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.PropertyAccessExpression): void {
  const propName = expr.name.text;

  // Try to resolve compile-time constant values (e.g., SECTION.type from `as const` objects)
  try {
    const type = ctx.checker.getTypeAtLocation(expr);
    if (type.isNumberLiteral()) {
      fctx.body.push({ op: "f64.const", value: (type as any).value });
      return;
    }
    if (type.isStringLiteral()) {
      compileStringLiteral(ctx, fctx, (type as any).value);
      return;
    }
  } catch {
    /* fall through to runtime access */
  }

  const objKind = getExprCollectionKind(ctx, fctx, expr.expression);

  if (propName === "length" && (objKind === "Array" || objKind === "Uint8Array" || objKind === "ArrayOrUint8Array")) {
    if (objKind === "Array") compileResolvedArrayPointer(ctx, fctx, expr.expression, compileExpression);
    else compileExpression(ctx, fctx, expr.expression);
    if (objKind === "ArrayOrUint8Array") {
      // Runtime dispatch via tag byte
      const arrLenIdx = ctx.funcMap.get("__arr_len")!;
      const u8LenIdx = ctx.funcMap.get("__u8arr_len")!;
      const ptrLocal = addLocal(fctx, `__len_tmp_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "local.tee", index: ptrLocal });
      fctx.body.push({ op: "i32.load8_u", align: 0, offset: 0 });
      fctx.body.push({ op: "i32.const", value: 0x02 });
      fctx.body.push({ op: "i32.eq" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: ptrLocal },
          { op: "call", funcIdx: u8LenIdx },
        ],
        else: [
          { op: "local.get", index: ptrLocal },
          { op: "call", funcIdx: arrLenIdx },
        ],
      });
    } else {
      const lenFunc = objKind === "Array" ? "__arr_len" : "__u8arr_len";
      const funcIdx = ctx.funcMap.get(lenFunc)!;
      fctx.body.push({ op: "call", funcIdx });
    }
    // Convert i32 result to f64 (since our numeric values are f64)
    fctx.body.push({ op: "f64.convert_i32_s" });
    return;
  }

  // string.length → number of UTF-16 code units (JS semantics), NOT the
  // UTF-8 byte count (#1976). Linear strings are stored as UTF-8, so route the
  // user-facing `.length` through __str_length_utf16, which scans the bytes and
  // counts code units (astral code points = 2). __str_len (byte count) stays
  // the internal primitive for slice/indexOf, which index by byte offset.
  if (propName === "length" && isStringExpr(ctx, fctx, expr.expression)) {
    compileExpression(ctx, fctx, expr.expression);
    const strLenIdx = ctx.funcMap.get("__str_length_utf16")!;
    fctx.body.push({ op: "call", funcIdx: strLenIdx });
    fctx.body.push({ op: "f64.convert_i32_s" });
    return;
  }

  if (propName === "size" && (objKind === "Map" || objKind === "Set")) {
    // map.size or set.size → call __nmap_size / __nset_size
    compileExpression(ctx, fctx, expr.expression);
    const sizeFunc = objKind === "Map" ? "__nmap_size" : "__nset_size";
    const funcIdx = ctx.funcMap.get(sizeFunc)!;
    fctx.body.push({ op: "call", funcIdx });
    // Convert i32 result to f64
    fctx.body.push({ op: "f64.convert_i32_s" });
    return;
  }

  // Check if it's a class field access or getter
  const className = inferClassName(ctx, fctx, expr.expression);
  if (className) {
    const layout = ctx.classLayouts.get(className);
    if (layout) {
      const field = layout.fields.get(propName);
      if (field) {
        compileExpression(ctx, fctx, expr.expression);
        if (field.type === "f64") {
          fctx.body.push({ op: "f64.load", align: 3, offset: field.offset });
        } else {
          fctx.body.push({ op: "i32.load", align: 2, offset: field.offset });
        }
        return;
      }

      // Check for getter
      const getterFuncName = layout.getters.get(propName);
      if (getterFuncName) {
        const funcIdx = ctx.funcMap.get(getterFuncName);
        if (funcIdx !== undefined) {
          compileExpression(ctx, fctx, expr.expression);
          fctx.body.push({ op: "call", funcIdx });
          return;
        }
      }
    }
  }

  // TypeChecker-based fallback for anonymous object types
  try {
    const objType = ctx.checker.getTypeAtLocation(expr.expression);
    const baseType = ctx.checker.getNonNullableType(objType);
    const props = baseType.getProperties();
    if (props.length > 0) {
      // Calculate field offset by iterating properties in order
      // Start after the 8-byte header (tag + payload_size)
      const HEADER_SIZE = 8;
      const FIELD_SIZE = 8;
      let offset = HEADER_SIZE;
      let foundField: { offset: number; type: "i32" | "f64" } | null = null;
      for (const prop of props) {
        const rawPropType = ctx.checker.getTypeOfSymbolAtLocation(prop, expr);
        const propType = ctx.checker.getNonNullableType(rawPropType);
        const typeStr = ctx.checker.typeToString(propType);
        const isF64 =
          typeStr === "number" ||
          typeStr === "boolean" ||
          (propType.getFlags() & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) !== 0;

        if (prop.getName() === propName) {
          foundField = { offset, type: isF64 ? "f64" : "i32" };
          break;
        }
        offset += FIELD_SIZE; // uniform 8-byte fields to match computeClassLayout
      }
      if (foundField) {
        compileExpression(ctx, fctx, expr.expression);
        if (foundField.type === "f64") {
          fctx.body.push({ op: "f64.load", align: 3, offset: foundField.offset });
        } else {
          fctx.body.push({ op: "i32.load", align: 2, offset: foundField.offset });
        }
        return;
      }
    }
  } catch {
    /* fall through */
  }

  // Fallback: just report error for unsupported property access
  ctx.errors.push({
    message: `Unsupported property access: .${propName}`,
    line: 0,
    column: 0,
  });
}

// ── ElementAccessExpression ──────────────────────────────────────────

function compileElementAccess(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.ElementAccessExpression): void {
  const objKind = getExprCollectionKind(ctx, fctx, expr.expression);

  if (objKind === "Array") {
    // arr[i] → __arr_get(arr, i) → f64 slot (#1938)
    const getIdx = ctx.funcMap.get("__arr_get")!;
    compileResolvedArrayPointer(ctx, fctx, expr.expression, compileExpression); // arr ptr (i32)
    compileExprToI32(ctx, fctx, expr.argumentExpression); // index → i32
    fctx.body.push({ op: "call", funcIdx: getIdx });
    // The slot is an f64 bit pattern. For a number/boolean element the slot IS
    // the f64 value (no conversion). For an object/string element the i32
    // handle lives in the low 4 bytes — decode it back to i32.
    let elemIsNum = true;
    try {
      const elemType = ctx.checker.getTypeAtLocation(expr);
      const typeStr = ctx.checker.typeToString(elemType);
      if (typeStr !== "number" && typeStr !== "boolean") elemIsNum = false;
    } catch {
      /* default: assume number */
    }
    if (!elemIsNum) {
      pushSlotToI32(fctx);
    }
  } else if (objKind === "Uint8Array") {
    // u8[i] → __u8arr_get(u8, i) → i32, convert to f64 (always numeric)
    const getIdx = ctx.funcMap.get("__u8arr_get")!;
    compileExpression(ctx, fctx, expr.expression);
    compileExprToI32(ctx, fctx, expr.argumentExpression); // index → i32
    fctx.body.push({ op: "call", funcIdx: getIdx });
    fctx.body.push({ op: "f64.convert_i32_s" });
  } else {
    ctx.errors.push({
      message: "Unsupported element access on non-collection type",
      line: 0,
      column: 0,
    });
  }
}

// ── ElementAccess assignment (arr[i] = v) ────────────────────────────

function compileElementAccessAssignment(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  left: ts.ElementAccessExpression,
  right: ts.Expression,
): void {
  // #1938 — an element assignment used as an expression (`arr[i] = f()`) must
  // evaluate the RHS exactly once. The previous code compiled `right` twice
  // (once to store, once to leave as the expression value), so any
  // side-effecting RHS ran twice. Fix: compile the RHS into a scratch local,
  // store from the local, and leave the local on the stack as the result.
  const addScratch = (type: ValType): number => {
    const idx = fctx.params.length + fctx.locals.length;
    fctx.locals.push({ name: `__elemassign_${idx}`, type });
    return idx;
  };

  // Handle typed array views: new Float64Array(buf)[i] = v, new Float32Array(buf)[i] = v
  if (ts.isNewExpression(left.expression) && ts.isIdentifier(left.expression.expression)) {
    const typeName = left.expression.expression.text;
    if (typeName === "Float64Array" && left.expression.arguments?.length) {
      // new Float64Array(buf)[i] = value → buf + i*8, f64.store(value)
      const valLocal = addScratch({ kind: "f64" });
      compileExpression(ctx, fctx, right); // value (f64) — evaluated once
      fctx.body.push({ op: "local.set", index: valLocal });
      compileExpression(ctx, fctx, left.expression.arguments[0]); // buf ptr
      compileExprToI32(ctx, fctx, left.argumentExpression); // index
      fctx.body.push({ op: "i32.const", value: 3 }); // *8 = <<3
      fctx.body.push({ op: "i32.shl" });
      fctx.body.push({ op: "i32.add" }); // buf + index*8
      fctx.body.push({ op: "local.get", index: valLocal });
      fctx.body.push({ op: "f64.store", align: 3, offset: 0 });
      fctx.body.push({ op: "local.get", index: valLocal }); // expression result
      return;
    }
    if (typeName === "Float32Array" && left.expression.arguments?.length) {
      const valLocal = addScratch({ kind: "f64" });
      compileExpression(ctx, fctx, right); // value (f64) — evaluated once
      fctx.body.push({ op: "local.set", index: valLocal });
      compileExpression(ctx, fctx, left.expression.arguments[0]);
      compileExprToI32(ctx, fctx, left.argumentExpression);
      fctx.body.push({ op: "i32.const", value: 2 }); // *4 = <<2
      fctx.body.push({ op: "i32.shl" });
      fctx.body.push({ op: "i32.add" });
      fctx.body.push({ op: "local.get", index: valLocal });
      fctx.body.push({ op: "f32.demote_f64" });
      fctx.body.push({ op: "f32.store", align: 2, offset: 0 });
      fctx.body.push({ op: "local.get", index: valLocal }); // expression result
      return;
    }
  }

  const objKind = getExprCollectionKind(ctx, fctx, left.expression);

  if (objKind === "Array") {
    // arr[i] = v → __arr_set(arr, i, slot(v)); leave v as the expression result.
    //
    // #1938: element storage is now an 8-byte f64 slot. A numeric (or boolean)
    // RHS is an f64 and is stored verbatim — `[1.5][0]` no longer truncates. A
    // reference (string/object) RHS is an i32 handle encoded into the low 4
    // bytes of the slot. The scratch local holds the un-encoded value so the
    // assignment-as-expression yields the assigned value (f64 for numeric,
    // i32 for reference), matching the surrounding context.
    const setIdx = ctx.funcMap.get("__arr_set")!;
    // A numeric/boolean RHS compiles to f64; a reference (string/object) RHS to i32.
    const rightIsNumeric = inferExprType(ctx, fctx, right).kind === "f64";
    const valLocal = addScratch({ kind: rightIsNumeric ? "f64" : "i32" });
    compileExpression(ctx, fctx, right); // value — evaluated once
    fctx.body.push({ op: "local.set", index: valLocal });
    compileResolvedArrayPointer(ctx, fctx, left.expression, compileExpression); // arr ptr (i32)
    compileExprToI32(ctx, fctx, left.argumentExpression); // index → i32
    fctx.body.push({ op: "local.get", index: valLocal });
    if (!rightIsNumeric) {
      pushI32ToSlot(fctx); // encode i32 handle into the f64 slot
    }
    fctx.body.push({ op: "call", funcIdx: setIdx });
    fctx.body.push({ op: "local.get", index: valLocal }); // assigned value (f64 for numeric)
  } else if (objKind === "Uint8Array") {
    // u8[i] = v → __u8arr_set(u8, i, v); leave v as the expression result.
    // Uint8Array elements are always numeric; store the byte (i32) and return
    // the original f64 value as the expression result.
    const setIdx = ctx.funcMap.get("__u8arr_set")!;
    const valLocal = addScratch({ kind: "f64" });
    compileExpression(ctx, fctx, right); // value (f64) — evaluated once
    fctx.body.push({ op: "local.set", index: valLocal });
    compileExpression(ctx, fctx, left.expression);
    compileExprToI32(ctx, fctx, left.argumentExpression); // index → i32
    fctx.body.push({ op: "local.get", index: valLocal });
    // ToUint8 byte value (#2715): ToInt32 then `__u8arr_set`'s i32.store8 keeps the
    // low byte. NaN/∞ → 0, large values wrap mod 256, never trap.
    emitToInt32(fctx);
    fctx.body.push({ op: "call", funcIdx: setIdx });
    fctx.body.push({ op: "local.get", index: valLocal }); // assigned value (f64)
  } else {
    ctx.errors.push({
      message: "Unsupported element access assignment",
      line: 0,
      column: 0,
    });
  }
}

// ── Method calls ─────────────────────────────────────────────────────

function compileMethodCall(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.CallExpression): void {
  const propAccess = expr.expression as ts.PropertyAccessExpression;
  const methodName = propAccess.name.text;

  // Handle new TextDecoder().decode(bytes) → __str_from_u8arr(bytes)
  if (
    methodName === "decode" &&
    ts.isNewExpression(propAccess.expression) &&
    ts.isIdentifier(propAccess.expression.expression) &&
    propAccess.expression.expression.text === "TextDecoder"
  ) {
    const strFromU8Idx = ctx.funcMap.get("__str_from_u8arr")!;
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]);
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    fctx.body.push({ op: "call", funcIdx: strFromU8Idx });
    return;
  }

  // Handle new TextEncoder().encode(s) → __str_from_u8arr(s) (same layout copy)
  if (
    methodName === "encode" &&
    ts.isNewExpression(propAccess.expression) &&
    ts.isIdentifier(propAccess.expression.expression) &&
    propAccess.expression.expression.text === "TextEncoder"
  ) {
    const strFromU8Idx = ctx.funcMap.get("__str_from_u8arr")!;
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]);
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    fctx.body.push({ op: "call", funcIdx: strFromU8Idx });
    return;
  }

  const objKind = getExprCollectionKind(ctx, fctx, propAccess.expression);

  if (objKind === "Array") {
    compileArrayMethodCall(ctx, fctx, expr, propAccess, methodName);
  } else if (objKind === "Uint8Array") {
    compileUint8ArrayMethodCall(ctx, fctx, expr, propAccess, methodName);
  } else if (objKind === "Map") {
    compileMapMethodCall(ctx, fctx, expr, propAccess, methodName);
  } else if (objKind === "Set") {
    compileSetMethodCall(ctx, fctx, expr, propAccess, methodName);
  } else if (
    compileLinearStringMethodCall(ctx, fctx, expr, propAccess, methodName, {
      compileExpression,
      compileExprToI32,
      compileExprToF64,
      compileStringLiteral,
      isStringExpr,
    })
  ) {
    return;
  } else if (methodName === "toString") {
    // Exact no-radix Number::toString uses the host-free Ryū runtime.
    compileExpression(ctx, fctx, propAccess.expression);
    if (expr.arguments.length === 0 && inferExprType(ctx, fctx, propAccess.expression).kind === "f64") {
      linearCoercion.emitNumberToStringCall(ctx, fctx);
    }
    return;
  } else {
    // Check if it's a class method call
    const className = inferClassName(ctx, fctx, propAccess.expression);
    if (className) {
      const layout = ctx.classLayouts.get(className);
      if (layout) {
        const wasmMethodName = layout.methods.get(methodName);
        if (wasmMethodName) {
          const funcIdx = ctx.funcMap.get(wasmMethodName);
          if (funcIdx !== undefined) {
            // Push `this` (the object)
            compileExpression(ctx, fctx, propAccess.expression);
            // Push arguments (handles arrow function args as closures)
            for (const arg of expr.arguments) {
              compileCallArg(ctx, fctx, arg);
            }
            // Fill default values for missing parameters (skip `this`)
            emitDefaultArgs(ctx, fctx, wasmMethodName, expr.arguments.length + 1);
            fctx.body.push({ op: "call", funcIdx });
            return;
          }
        }
      }
    }
    ctx.errors.push({
      message: `Unsupported method call: .${methodName}()`,
      line: 0,
      column: 0,
    });
  }
}

function compileArrayMethodCall(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  methodName: string,
): void {
  if (methodName === "push") {
    // arr.push(v0, v1, …) → __arr_push(arr, slot(vi)) per arg (#1938: f64 slot).
    // Spec: push returns the array's NEW length, and every argument is appended
    // (#3332 — the direct linear path previously returned f64.const 0 and only
    // pushed arguments[0]). Evaluate the receiver once into a local so a
    // side-effecting receiver expression is not re-run per argument, then read
    // __arr_len back at the end for the expression-position result value.
    const pushIdx = ctx.funcMap.get("__arr_push")!;
    const lenIdx = ctx.funcMap.get("__arr_len")!;
    const arrLocal = addLocal(fctx, `__push_arr_${fctx.locals.length}`, { kind: "i32" });
    compileResolvedArrayPointer(ctx, fctx, propAccess.expression, compileExpression); // arr ptr (i32)
    fctx.body.push({ op: "local.set", index: arrLocal });
    for (const arg of expr.arguments) {
      emitResolvedArrayLocal(ctx, fctx, arrLocal);
      if (inferExprType(ctx, fctx, arg).kind === "f64") {
        compileExprToF64(ctx, fctx, arg); // numeric/boolean → f64 slot
      } else {
        compileExprToI32(ctx, fctx, arg); // ref → i32
        pushI32ToSlot(fctx); // → f64 slot
      }
      fctx.body.push({ op: "call", funcIdx: pushIdx });
    }
    // Expression position needs the new length (f64); __arr_push is void.
    fctx.body.push({ op: "local.get", index: arrLocal });
    fctx.body.push({ op: "call", funcIdx: lenIdx });
    fctx.body.push({ op: "f64.convert_i32_s" });
  } else if (
    methodName === "filter" ||
    methodName === "map" ||
    methodName === "some" ||
    methodName === "find" ||
    methodName === "flatMap"
  ) {
    // Inline expansion of higher-order array methods
    compileArrayHOF(ctx, fctx, expr, propAccess, methodName as "filter" | "map" | "some" | "find" | "flatMap");
  } else if (methodName === "join") {
    // arr.join(sep) → inline string concatenation
    compileArrayJoin(ctx, fctx, expr, propAccess);
  } else if (methodName === "length") {
    // arr.length (handled as property, but just in case)
    compileExpression(ctx, fctx, propAccess.expression);
    const lenIdx = ctx.funcMap.get("__arr_len")!;
    fctx.body.push({ op: "call", funcIdx: lenIdx });
    fctx.body.push({ op: "f64.convert_i32_s" });
  } else {
    ctx.errors.push({
      message: `Unsupported Array method: .${methodName}()`,
      line: 0,
      column: 0,
    });
  }
}

// ── Inline higher-order Array methods (filter/map/some/find) ──────────

function compileArrayHOF(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  method: "filter" | "map" | "some" | "find" | "flatMap",
): void {
  const arrLenIdx = ctx.funcMap.get("__arr_len")!;
  const arrGetIdx = ctx.funcMap.get("__arr_get")!;
  const arrNewIdx = ctx.funcMap.get("__arr_new")!;
  const arrPushIdx = ctx.funcMap.get("__arr_push")!;

  // Extract lambda parameter and body
  const callback = expr.arguments[0];
  if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
    ctx.errors.push({ message: `Array.${method}() requires inline arrow function`, ...nodeLoc(expr) });
    return;
  }
  const paramName =
    callback.parameters[0] && ts.isIdentifier(callback.parameters[0].name)
      ? callback.parameters[0].name.text
      : "__hof_param";
  // Optional second parameter (index)
  const indexParamName =
    callback.parameters[1] && ts.isIdentifier(callback.parameters[1].name) ? callback.parameters[1].name.text : null;

  // Determine element type (i32 for objects/strings, f64 for numbers)
  let elemIsI32 = true;
  try {
    const arrType = ctx.checker.getTypeAtLocation(propAccess.expression);
    const arrStr = ctx.checker.typeToString(ctx.checker.getNonNullableType(arrType));
    if (arrStr === "number[]" || arrStr === "boolean[]") elemIsI32 = false;
  } catch {
    /* default: i32 */
  }
  const elemType: ValType = elemIsI32 ? { kind: "i32" } : { kind: "f64" };

  // Create temp locals
  const arrLocal = addLocal(fctx, `__hof_arr_${fctx.locals.length}`, { kind: "i32" });
  const iLocal = addLocal(fctx, `__hof_i_${fctx.locals.length}`, { kind: "i32" });
  const lenLocal = addLocal(fctx, `__hof_len_${fctx.locals.length}`, { kind: "i32" });
  const elemLocal = addLocal(fctx, paramName, elemType);
  const indexLocal = indexParamName ? addLocal(fctx, indexParamName, { kind: "f64" }) : undefined;

  // filter/map/flatMap accumulate a new array (i32 pointer), `some` a boolean
  // (f64). #3908: `find` accumulates an ELEMENT, so its slot must carry
  // `elemType` — a hard-coded i32 made a `number[]` fail validation at both
  // ends: "local.set[0] expected type i32, found local.get of type f64".
  const resultType: ValType = method === "find" ? elemType : method === "some" ? { kind: "f64" } : { kind: "i32" };
  const resultLocal = addLocal(fctx, `__hof_result_${fctx.locals.length}`, resultType);

  compileResolvedArrayPointer(ctx, fctx, propAccess.expression, compileExpression);
  fctx.body.push({ op: "local.set", index: arrLocal });

  // lenLocal = __arr_len(arrLocal)
  fctx.body.push({ op: "local.get", index: arrLocal });
  fctx.body.push({ op: "call", funcIdx: arrLenIdx });
  fctx.body.push({ op: "local.set", index: lenLocal });

  // iLocal = 0
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });

  if (method === "filter" || method === "map" || method === "flatMap") {
    // resultLocal = __arr_new(16)
    fctx.body.push({ op: "i32.const", value: 16 });
    fctx.body.push({ op: "call", funcIdx: arrNewIdx });
    fctx.body.push({ op: "local.set", index: resultLocal! });
  } else if (method === "some") {
    // resultLocal = 0.0 (false)
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "local.set", index: resultLocal! });
  } else if (method === "find") {
    // resultLocal = the "not found" sentinel; #3908: must match elemType. A
    // null pointer for ref elements, 0.0 for f64 ones (`undefined` in a slot).
    fctx.body.push(elemIsI32 ? { op: "i32.const", value: 0 } : { op: "f64.const", value: 0 });
    fctx.body.push({ op: "local.set", index: resultLocal! });
  }

  // Build loop body
  const loopBody: Instr[] = [];
  const savedBody = fctx.body;
  fctx.body = loopBody;

  // Break: if (i >= len) break
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.ge_s" });
  fctx.body.push({ op: "br_if", depth: 1 });

  // elem = __arr_get(arr, i) → f64 slot (#1938)
  fctx.body.push({ op: "local.get", index: arrLocal });
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "call", funcIdx: arrGetIdx });
  if (elemIsI32) {
    pushSlotToI32(fctx); // ref/string slot → i32 handle
  }
  fctx.body.push({ op: "local.set", index: elemLocal });

  // Set index param if present
  if (indexLocal !== undefined) {
    fctx.body.push({ op: "local.get", index: iLocal });
    fctx.body.push({ op: "f64.convert_i32_s" });
    fctx.body.push({ op: "local.set", index: indexLocal });
  }

  // Compile callback body expression
  const bodyExpr = ts.isBlock(callback.body)
    ? callback.body.statements[0] && ts.isReturnStatement(callback.body.statements[0])
      ? callback.body.statements[0].expression
      : undefined
    : callback.body;

  if (!bodyExpr) {
    ctx.errors.push({ message: `Array.${method}() callback must have a simple expression body`, ...nodeLoc(callback) });
    fctx.body = savedBody;
    return;
  }

  if (method === "filter") {
    // if (callback(elem)) __arr_push(result, elem)
    compileExpression(ctx, fctx, bodyExpr);
    emitTruthyCoercion(fctx, inferExprType(ctx, fctx, bodyExpr), { ctx, expr: bodyExpr });
    const pushBody: Instr[] = [];
    const savedBody2 = fctx.body;
    fctx.body = pushBody;
    fctx.body.push({ op: "local.get", index: resultLocal! });
    fctx.body.push({ op: "local.get", index: elemLocal });
    // #1938: __arr_push takes an f64 slot. elemLocal is f64 for number/boolean
    // (push verbatim) and i32 for ref/string (encode into the slot).
    if (elemIsI32) {
      pushI32ToSlot(fctx);
    }
    fctx.body.push({ op: "call", funcIdx: arrPushIdx });
    fctx.body = savedBody2;
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: pushBody });
  } else if (method === "map") {
    // __arr_push(result, slot(callback(elem)))  (#1938: f64 slot — no truncation)
    fctx.body.push({ op: "local.get", index: resultLocal! });
    compileExpression(ctx, fctx, bodyExpr);
    // A numeric/boolean mapped value is an f64 → store verbatim (the truncation
    // that broke `[1.5,2.5].map(x=>x*2)` is gone). A ref mapped value is an i32
    // → encode into the slot.
    const mappedType = inferExprType(ctx, fctx, bodyExpr);
    if (mappedType.kind !== "f64") {
      pushI32ToSlot(fctx);
    }
    fctx.body.push({ op: "call", funcIdx: arrPushIdx });
  } else if (method === "some") {
    // if (callback(elem)) { result = 1.0; break; }
    compileExpression(ctx, fctx, bodyExpr);
    emitTruthyCoercion(fctx, inferExprType(ctx, fctx, bodyExpr), { ctx, expr: bodyExpr });
    const foundBody: Instr[] = [];
    const savedBody2 = fctx.body;
    fctx.body = foundBody;
    fctx.body.push({ op: "f64.const", value: 1 });
    fctx.body.push({ op: "local.set", index: resultLocal! });
    fctx.body.push({ op: "br", depth: 2 }); // break out of block+loop
    fctx.body = savedBody2;
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: foundBody });
  } else if (method === "find") {
    // if (callback(elem)) { result = elem; break; }
    compileExpression(ctx, fctx, bodyExpr);
    emitTruthyCoercion(fctx, inferExprType(ctx, fctx, bodyExpr), { ctx, expr: bodyExpr });
    const foundBody: Instr[] = [];
    const savedBody2 = fctx.body;
    fctx.body = foundBody;
    fctx.body.push({ op: "local.get", index: elemLocal });
    fctx.body.push({ op: "local.set", index: resultLocal! });
    fctx.body.push({ op: "br", depth: 2 }); // break out of block+loop
    fctx.body = savedBody2;
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: foundBody });
  } else if (method === "flatMap") {
    // innerArr = callback(elem); for j in innerArr: __arr_push(result, innerArr[j])
    const innerArrLocal = addLocal(fctx, `__hof_inner_${fctx.locals.length}`, { kind: "i32" });
    const jLocal = addLocal(fctx, `__hof_j_${fctx.locals.length}`, { kind: "i32" });
    const innerLenLocal = addLocal(fctx, `__hof_ilen_${fctx.locals.length}`, { kind: "i32" });
    compileExpression(ctx, fctx, bodyExpr);
    const innerType = inferExprType(ctx, fctx, bodyExpr);
    if (innerType.kind === "f64") {
      fctx.body.push({ op: "i32.trunc_f64_s" });
    }
    fctx.body.push({ op: "local.set", index: innerArrLocal });
    // innerLen = __arr_len(innerArr)
    fctx.body.push({ op: "local.get", index: innerArrLocal });
    fctx.body.push({ op: "call", funcIdx: arrLenIdx });
    fctx.body.push({ op: "local.set", index: innerLenLocal });
    // j = 0
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.set", index: jLocal });
    // Inner loop: for j in innerArr
    const innerLoopBody: Instr[] = [];
    // break: if (j >= innerLen) break
    innerLoopBody.push({ op: "local.get", index: jLocal });
    innerLoopBody.push({ op: "local.get", index: innerLenLocal });
    innerLoopBody.push({ op: "i32.ge_s" });
    innerLoopBody.push({ op: "br_if", depth: 1 });
    // __arr_push(result, __arr_get(innerArr, j))
    innerLoopBody.push({ op: "local.get", index: resultLocal! });
    innerLoopBody.push({ op: "local.get", index: innerArrLocal });
    innerLoopBody.push({ op: "local.get", index: jLocal });
    innerLoopBody.push({ op: "call", funcIdx: arrGetIdx });
    innerLoopBody.push({ op: "call", funcIdx: arrPushIdx });
    // j++
    innerLoopBody.push({ op: "local.get", index: jLocal });
    innerLoopBody.push({ op: "i32.const", value: 1 });
    innerLoopBody.push({ op: "i32.add" });
    innerLoopBody.push({ op: "local.set", index: jLocal });
    innerLoopBody.push({ op: "br", depth: 0 });

    fctx.body.push({
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: innerLoopBody,
        },
      ],
    });
  }

  // i++
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: iLocal });
  fctx.body.push({ op: "br", depth: 0 });

  fctx.body = savedBody;

  // Emit block+loop structure
  fctx.blockDepth += 2;
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });
  fctx.blockDepth -= 2;

  // Push result
  if (method === "filter" || method === "map" || method === "find" || method === "flatMap") {
    fctx.body.push({ op: "local.get", index: resultLocal! });
  } else if (method === "some") {
    fctx.body.push({ op: "local.get", index: resultLocal! });
  }

  // Clean up the lambda param from localMap so it doesn't conflict
  // (it stays in locals array but won't be resolved by name)
}

// ── Array.join() ──────────────────────────────────────────────────────

function compileArrayJoin(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): void {
  const arrLenIdx = ctx.funcMap.get("__arr_len")!;
  const arrGetIdx = ctx.funcMap.get("__arr_get")!;
  const strConcatIdx = ctx.funcMap.get("__str_concat")!;

  // Get separator (default ",")
  const sepArg = expr.arguments[0];

  // Create temp locals
  const arrLocal = addLocal(fctx, `__join_arr_${fctx.locals.length}`, { kind: "i32" });
  const iLocal = addLocal(fctx, `__join_i_${fctx.locals.length}`, { kind: "i32" });
  const lenLocal = addLocal(fctx, `__join_len_${fctx.locals.length}`, { kind: "i32" });
  const resultLocal = addLocal(fctx, `__join_result_${fctx.locals.length}`, { kind: "i32" });
  const sepLocal = addLocal(fctx, `__join_sep_${fctx.locals.length}`, { kind: "i32" });

  // arrLocal = source array
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.set", index: arrLocal });

  // lenLocal = __arr_len(arrLocal)
  fctx.body.push({ op: "local.get", index: arrLocal });
  fctx.body.push({ op: "call", funcIdx: arrLenIdx });
  fctx.body.push({ op: "local.set", index: lenLocal });

  // iLocal = 0
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });

  // resultLocal = "" (empty string)
  fctx.body.push({ op: "i32.const", value: 0 }); // empty string = null ptr (length 0)
  fctx.body.push({ op: "local.set", index: resultLocal });

  // sepLocal = separator string
  if (sepArg) {
    compileExprToI32(ctx, fctx, sepArg);
  } else {
    // Default separator is ","
    fctx.body.push({ op: "i32.const", value: 0 }); // placeholder
  }
  fctx.body.push({ op: "local.set", index: sepLocal });

  // Build loop body
  const loopBody: Instr[] = [];
  const savedBody = fctx.body;
  fctx.body = loopBody;

  // Break: if (i >= len) break
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.ge_s" });
  fctx.body.push({ op: "br_if", depth: 1 });

  // If i > 0, append separator
  const appendSepBody: Instr[] = [];
  const savedBody2 = fctx.body;
  fctx.body = appendSepBody;
  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({ op: "local.get", index: sepLocal });
  fctx.body.push({ op: "call", funcIdx: strConcatIdx });
  fctx.body.push({ op: "local.set", index: resultLocal });
  fctx.body = savedBody2;

  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.gt_s" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: appendSepBody });

  // Append element: result = __str_concat(result, arr[i])
  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({ op: "local.get", index: arrLocal });
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "call", funcIdx: arrGetIdx });
  // __arr_get returns an f64 slot (#1938); join concatenates string pointers,
  // so decode the slot back to the i32 string handle. (Joining a number[] was
  // already unsupported — it stringifies the raw handle — so this only changes
  // the slot decode, not that pre-existing limitation.)
  pushSlotToI32(fctx);
  fctx.body.push({ op: "call", funcIdx: strConcatIdx });
  fctx.body.push({ op: "local.set", index: resultLocal });

  // i++
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: iLocal });
  fctx.body.push({ op: "br", depth: 0 });

  fctx.body = savedBody;

  // Emit block+loop
  fctx.blockDepth += 2;
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });
  fctx.blockDepth -= 2;

  // Push result (string pointer)
  fctx.body.push({ op: "local.get", index: resultLocal });
}

function compileUint8ArrayMethodCall(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  methodName: string,
): void {
  if (methodName === "slice") {
    // u8.slice(start, end) → __u8arr_slice(u8, start, end)
    const sliceIdx = ctx.funcMap.get("__u8arr_slice")!;
    compileExpression(ctx, fctx, propAccess.expression); // u8 ptr
    if (expr.arguments.length >= 2) {
      compileExprToI32(ctx, fctx, expr.arguments[0]!); // start → i32
      compileExprToI32(ctx, fctx, expr.arguments[1]!); // end → i32
    } else if (expr.arguments.length === 1) {
      compileExprToI32(ctx, fctx, expr.arguments[0]!); // start → i32
      // end = length
      compileExpression(ctx, fctx, propAccess.expression);
      const lenIdx = ctx.funcMap.get("__u8arr_len")!;
      fctx.body.push({ op: "call", funcIdx: lenIdx });
    } else {
      // Full copy: start=0, end=length
      fctx.body.push({ op: "i32.const", value: 0 });
      compileExpression(ctx, fctx, propAccess.expression);
      const lenIdx = ctx.funcMap.get("__u8arr_len")!;
      fctx.body.push({ op: "call", funcIdx: lenIdx });
    }
    fctx.body.push({ op: "call", funcIdx: sliceIdx });
  } else if (methodName === "set") {
    // u8.set(source) → copy source bytes into u8
    // Inline loop: for (let i = 0; i < src.len; i++) dest[12+i] = src[12+i]
    const u8LenIdx = ctx.funcMap.get("__u8arr_len")!;
    const destLocal = addLocal(fctx, `__u8set_dest_${fctx.locals.length}`, { kind: "i32" });
    const srcLocal = addLocal(fctx, `__u8set_src_${fctx.locals.length}`, { kind: "i32" });
    const lenLocal = addLocal(fctx, `__u8set_len_${fctx.locals.length}`, { kind: "i32" });
    const iLocal = addLocal(fctx, `__u8set_i_${fctx.locals.length}`, { kind: "i32" });

    compileExpression(ctx, fctx, propAccess.expression); // dest u8 ptr
    fctx.body.push({ op: "local.set", index: destLocal });
    compileExprToI32(ctx, fctx, expr.arguments[0]!); // source u8 ptr
    fctx.body.push({ op: "local.set", index: srcLocal });

    // len = __u8arr_len(src)
    fctx.body.push({ op: "local.get", index: srcLocal });
    fctx.body.push({ op: "call", funcIdx: u8LenIdx });
    fctx.body.push({ op: "local.set", index: lenLocal });

    // i = 0
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.set", index: iLocal });

    // Copy loop
    fctx.body.push({
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: iLocal },
            { op: "local.get", index: lenLocal },
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            // dest[12+i] = src[12+i]
            { op: "local.get", index: destLocal },
            { op: "local.get", index: iLocal },
            { op: "i32.add" },
            { op: "local.get", index: srcLocal },
            { op: "local.get", index: iLocal },
            { op: "i32.add" },
            { op: "i32.load8_u", align: 0, offset: 12 },
            { op: "i32.store8", align: 0, offset: 12 },
            // i++
            { op: "local.get", index: iLocal },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: iLocal },
            { op: "br", depth: 0 },
          ],
        },
      ],
    });
  } else {
    ctx.errors.push({
      message: `Unsupported Uint8Array method: .${methodName}()`,
      line: 0,
      column: 0,
    });
  }
}

function compileMapMethodCall(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  methodName: string,
): void {
  if (methodName === "set") {
    // map.set(key, val) → __nmap_set(map, i32(key), i32(val))
    const setIdx = ctx.funcMap.get("__nmap_set")!;
    compileExpression(ctx, fctx, propAccess.expression); // map ptr (i32)
    compileExprToI32(ctx, fctx, expr.arguments[0]); // key → i32
    compileExprToI32(ctx, fctx, expr.arguments[1]); // val → i32
    fctx.body.push({ op: "call", funcIdx: setIdx });
    // map.set returns void in runtime, push dummy for drop
    fctx.body.push({ op: "f64.const", value: 0 });
  } else if (methodName === "get") {
    // map.get(key) → __nmap_get(map, i32(key)) → i32
    const getIdx = ctx.funcMap.get("__nmap_get")!;
    compileExpression(ctx, fctx, propAccess.expression);
    compileExprToI32(ctx, fctx, expr.arguments[0]); // key → i32
    fctx.body.push({ op: "call", funcIdx: getIdx });
    // Only convert to f64 for numeric/boolean map values; object/array values stay i32
    let valIsNum = true;
    try {
      const retType = ctx.checker.getTypeAtLocation(expr);
      const retStr = ctx.checker.typeToString(ctx.checker.getNonNullableType(retType));
      if (retStr !== "number" && retStr !== "boolean") valIsNum = false;
    } catch {
      /* default: assume number */
    }
    if (valIsNum) {
      fctx.body.push({ op: "f64.convert_i32_s" });
    }
  } else if (methodName === "has") {
    // map.has(key) → __nmap_has(map, i32(key)) → i32, convert to f64
    const hasIdx = ctx.funcMap.get("__nmap_has")!;
    compileExpression(ctx, fctx, propAccess.expression);
    compileExprToI32(ctx, fctx, expr.arguments[0]); // key → i32
    fctx.body.push({ op: "call", funcIdx: hasIdx });
    fctx.body.push({ op: "f64.convert_i32_s" });
  } else {
    ctx.errors.push({
      message: `Unsupported Map method: .${methodName}()`,
      line: 0,
      column: 0,
    });
  }
}

function compileSetMethodCall(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  methodName: string,
): void {
  if (methodName === "add") {
    // set.add(val) → __nset_add(set, i32(val))
    const addIdx = ctx.funcMap.get("__nset_add")!;
    compileExpression(ctx, fctx, propAccess.expression);
    compileExprToI32(ctx, fctx, expr.arguments[0]); // val → i32
    fctx.body.push({ op: "call", funcIdx: addIdx });
    // void return, push dummy for drop
    fctx.body.push({ op: "f64.const", value: 0 });
  } else if (methodName === "has") {
    // set.has(val) → __nset_has(set, i32(val)) → i32, convert to f64
    const hasIdx = ctx.funcMap.get("__nset_has")!;
    compileExpression(ctx, fctx, propAccess.expression);
    compileExprToI32(ctx, fctx, expr.arguments[0]); // val → i32
    fctx.body.push({ op: "call", funcIdx: hasIdx });
    fctx.body.push({ op: "f64.convert_i32_s" });
  } else {
    ctx.errors.push({
      message: `Unsupported Set method: .${methodName}()`,
      line: 0,
      column: 0,
    });
  }
}

/**
 * Compile an expression and convert to i32 if needed.
 * If the expression produces f64, emit i32.trunc_f64_s; if i32, no-op.
 *
 * NOTE: this uses the **trapping** `i32.trunc_f64_s` and is for internal
 * integer conversions (array indices, lengths, handles) where the value is
 * expected to be a representable integer. JS-number paths that require the
 * §7.1.6 `ToInt32` / `ToUint8` wrap (bitwise operators, integer typed-array
 * element stores) must use {@link compileExprToInt32} / {@link emitToInt32}
 * instead — those wrap mod 2³² and map NaN/±∞ to 0 rather than trapping (#2715).
 */
function compileExprToI32(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.Expression): void {
  const exprType = inferExprType(ctx, fctx, expr);
  compileExpression(ctx, fctx, expr);
  if (exprType.kind === "f64") {
    fctx.body.push({ op: "i32.trunc_f64_s" });
  }
}

/**
 * #2715 — JS ToInt32 (§7.1.6) for an f64 already on the stack → i32 bit pattern.
 *
 * NaN / ±Infinity → 0; finite values truncate toward zero then reduce mod 2³²
 * (large magnitudes WRAP, not saturate). Mirrors the WasmGC backend's
 * `emitToInt32` (src/codegen/binary-ops.ts): the non-trapping saturating
 * conversion removes the `i32.trunc_f64_s` trap on NaN/∞, and the explicit
 * `x - floor(x / 2³²) * 2³²` reduction supplies the modular wrap that saturation
 * alone does not. The `_u` saturating conversion then yields the correct 32-bit
 * pattern (reinterpreted as signed by the consumer).
 */
function emitToInt32(fctx: LinearFuncContext): void {
  const tmp = fctx.params.length + fctx.locals.length;
  fctx.locals.push({ name: `__toint32_${tmp}`, type: { kind: "f64" } });
  fctx.body.push({ op: "f64.trunc" }); // truncate toward zero (ToInteger)
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "local.get", index: tmp });
  fctx.body.push({ op: "f64.const", value: 4294967296 }); // 2^32
  fctx.body.push({ op: "f64.div" });
  fctx.body.push({ op: "f64.floor" });
  fctx.body.push({ op: "f64.const", value: 4294967296 });
  fctx.body.push({ op: "f64.mul" });
  fctx.body.push({ op: "f64.sub" }); // x - floor(x/2^32)*2^32 ∈ [0, 2^32)
  fctx.body.push({ op: "i32.trunc_sat_f64_u" }); // bit pattern; NaN/∞ → 0
}

/**
 * #2715 — compile an expression and coerce to i32 using JS `ToInt32` semantics
 * (for bitwise operands). An already-i32 value is left untouched (it is already a
 * 32-bit integer); an f64 value is run through {@link emitToInt32}.
 */
function compileExprToInt32(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.Expression): void {
  const exprType = inferExprType(ctx, fctx, expr);
  compileExpression(ctx, fctx, expr);
  if (exprType.kind === "f64") {
    emitToInt32(fctx);
  }
}

/**
 * Compile an expression and convert to f64 if needed.
 * If the expression produces i32, emit f64.convert_i32_s; if f64, no-op.
 */
function compileExprToF64(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.Expression): void {
  const exprType = inferExprType(ctx, fctx, expr);
  compileExpression(ctx, fctx, expr);
  if (exprType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
  }
}

// ── Array element slot encode/decode (#1938) ─────────────────────────
//
// Linear array element slots are 8-byte raw bit patterns the runtime never
// interprets (__arr_get/_set/_push take/return f64). The codegen owns the
// interpretation per element kind:
//   - number (f64): the slot IS the IEEE-754 value — no conversion.
//   - reference/boolean (i32 handle / 0|1): the i32 lives in the low 4 bytes,
//     shuffled in via i64.extend_i32_u → f64.reinterpret_i64 and out via the
//     inverse. This keeps the hot numeric path conversion-free and confines the
//     bit-cast to the rarer ref/bool sites.

/** Encode an i32 (ref/bool handle) already on the stack into an f64 array slot. */
function pushI32ToSlot(fctx: LinearFuncContext): void {
  fctx.body.push({ op: "i64.extend_i32_u" });
  fctx.body.push({ op: "f64.reinterpret_i64" });
}

/** Decode an f64 array slot already on the stack back into its i32 (ref/bool) handle. */
function pushSlotToI32(fctx: LinearFuncContext): void {
  fctx.body.push({ op: "i64.reinterpret_f64" });
  fctx.body.push({ op: "i32.wrap_i64" });
}

// ── Type inference and resolution ────────────────────────────────────

/** Infer the wasm type of an expression (simple heuristic) */
function inferExprType(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.Expression): ValType {
  // String literals and template expressions are i32 (pointers)
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr) || ts.isTemplateExpression(expr)) {
    return { kind: "i32" };
  }

  // #1976: string concatenation (`a + b` where either side is a string) yields
  // a string POINTER (i32). Decide this explicitly before the numeric default
  // so `const x = "a" + b` declares an i32 local matching __str_concat's result.
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    if (isStringExpr(ctx, fctx, expr.left) || isStringExpr(ctx, fctx, expr.right)) {
      return { kind: "i32" };
    }
  }

  // #2184: `&&`/`||` yield an OPERAND value, not a 0/1 boolean. The codegen
  // emits an `if` whose result ValType is the unified operand type (same-typed
  // operands carry their native type; mixed i32/f64 falls back to f64). This
  // inference MUST mirror the `resultType` computed in the lowering above so
  // callers (variable declaration, return) allocate a matching local.
  if (
    ts.isBinaryExpression(expr) &&
    (expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      expr.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    const lt = inferExprType(ctx, fctx, expr.left);
    const rt = inferExprType(ctx, fctx, expr.right);
    return lt.kind === rt.kind ? lt : { kind: "f64" };
  }

  // `this` is always an i32 pointer
  if (expr.kind === ts.SyntaxKind.ThisKeyword) {
    return { kind: "i32" };
  }

  // undefined and null are i32 (null pointer)
  if (expr.kind === ts.SyntaxKind.NullKeyword) {
    return { kind: "i32" };
  }
  if (ts.isIdentifier(expr) && expr.text === "undefined") {
    return { kind: "i32" };
  }

  // Collections and object literals produce i32 pointers
  if (ts.isArrayLiteralExpression(expr)) return { kind: "i32" };
  if (ts.isObjectLiteralExpression(expr)) return { kind: "i32" };
  if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression)) {
    const name = expr.expression.text;
    if (
      name === "Uint8Array" ||
      name === "Map" ||
      name === "Set" ||
      name === "ArrayBuffer" ||
      name === "Float64Array" ||
      name === "Float32Array"
    ) {
      return { kind: "i32" };
    }
    // Class constructors return i32 pointers
    if (ctx.classLayouts.has(name)) {
      return { kind: "i32" };
    }
  }
  if (ts.isIdentifier(expr)) {
    const kind = getExprCollectionKind(ctx, fctx, expr);
    if (kind) return { kind: "i32" };
    // Check local type
    const localIdx = fctx.localMap.get(expr.text);
    if (localIdx !== undefined) {
      if (localIdx < fctx.params.length) {
        return fctx.params[localIdx].type;
      } else {
        const localDef = fctx.locals[localIdx - fctx.params.length];
        if (localDef) return localDef.type;
      }
    }
    // Check module globals
    const gIdx = ctx.moduleGlobals.get(expr.text);
    if (gIdx !== undefined) {
      return ctx.mod.globals[gIdx].type;
    }
  }

  // Property access — check field type
  if (ts.isPropertyAccessExpression(expr)) {
    const propName = expr.name.text;
    // Check collection length/size
    const objKind = getExprCollectionKind(ctx, fctx, expr.expression);
    if (
      (propName === "length" && (objKind === "Array" || objKind === "Uint8Array" || objKind === "ArrayOrUint8Array")) ||
      (propName === "size" && (objKind === "Map" || objKind === "Set"))
    ) {
      return { kind: "f64" }; // length/size are returned as f64
    }
    if (propName === "length" && isStringExpr(ctx, fctx, expr.expression)) {
      return { kind: "f64" };
    }
    // Check class layout
    const className = inferClassName(ctx, fctx, expr.expression);
    if (className) {
      const layout = ctx.classLayouts.get(className);
      if (layout) {
        const field = layout.fields.get(propName);
        if (field) {
          return { kind: field.type };
        }
      }
    }
    // TypeChecker fallback for anonymous object types
    try {
      const type = ctx.checker.getTypeAtLocation(expr);
      const baseType = ctx.checker.getNonNullableType(type);
      if (baseType.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) return { kind: "f64" };
      return { kind: "i32" }; // strings, objects, arrays → pointer
    } catch {
      /* fall through */
    }
  }

  // NonNull assertion: unwrap
  if (ts.isNonNullExpression(expr)) {
    return inferExprType(ctx, fctx, expr.expression);
  }

  // Parenthesized: unwrap
  if (ts.isParenthesizedExpression(expr)) {
    return inferExprType(ctx, fctx, expr.expression);
  }

  // Element access: check TypeChecker for element type
  if (ts.isElementAccessExpression(expr)) {
    try {
      const type = ctx.checker.getTypeAtLocation(expr);
      const typeStr = ctx.checker.typeToString(type);
      if (typeStr === "number" || typeStr === "boolean") return { kind: "f64" };
      return { kind: "i32" }; // objects, strings → pointer
    } catch {
      /* fall through */
    }
  }

  // Postfix/prefix unary
  if (ts.isPostfixUnaryExpression(expr) || ts.isPrefixUnaryExpression(expr)) {
    // ! and ~ always convert result to f64 (via f64.convert_i32_s)
    if (
      ts.isPrefixUnaryExpression(expr) &&
      (expr.operator === ts.SyntaxKind.ExclamationToken || expr.operator === ts.SyntaxKind.TildeToken)
    ) {
      return { kind: "f64" };
    }
    return inferExprType(ctx, fctx, expr.operand);
  }

  // Call expression: check return type via TypeChecker
  if (ts.isCallExpression(expr)) {
    try {
      const type = ctx.checker.getTypeAtLocation(expr);
      const baseType = ctx.checker.getNonNullableType(type);
      if (baseType.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) return { kind: "f64" };
      const typeStr = ctx.checker.typeToString(baseType);
      if (typeStr !== "void") return { kind: "i32" };
    } catch {
      /* fall through */
    }
  }

  // Conditional (ternary) expression: type of the result
  if (ts.isConditionalExpression(expr)) {
    return inferExprType(ctx, fctx, expr.whenTrue);
  }

  // For the linear backend, numbers are f64 by default
  // Comparison results are i32 but get converted to f64
  return { kind: "f64" };
}

/**
 * Is this type (after stripping null/undefined) one the linear backend keeps
 * in an f64 value slot rather than an i32 pointer slot? (#3686 bug 2)
 *
 * The linear lane represents every JS number — and booleans, and its
 * best-effort bigints — as f64. Objects, arrays and strings are i32 pointers.
 * This asks the checker instead of matching source text, so a *type alias* to
 * a numeric type answers the same as the type it aliases.
 */
function isLinearScalarType(ctx: LinearContext, typeNode: ts.TypeNode): boolean {
  try {
    const resolved = ctx.checker.getNonNullableType(ctx.checker.getTypeFromTypeNode(typeNode));
    const scalar = ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike;
    if ((resolved.flags & scalar) !== 0) return true;
    // A union of numeric members (e.g. `type Bit = 0 | 1`) is still a number.
    if (resolved.isUnion()) return resolved.types.every((member) => (member.flags & scalar) !== 0);
    return false;
  } catch {
    return false;
  }
}

/**
 * Resolve a TS type annotation to a ValType.
 *
 * The `switch` on source text is the fast path for the spelled-out primitives.
 * Anything else used to fall straight into the `i32` (pointer) default — which
 * silently mis-typed **every type alias of a numeric type**, `type i32 = number`
 * and `type Meters = number` alike (#3686 bug 2). The signature slot came out
 * `i32` while the body compiled the arithmetic as `f64`, so the module failed
 * validation ("f64.add[0] expected type f64, found local.get of type i32").
 * The default now asks the checker before assuming "pointer".
 */
function resolveType(ctx: LinearContext, typeNode: ts.TypeNode | undefined): ValType | null {
  if (!typeNode) return null;
  // Strip "| undefined" and "| null" for optional types
  const text = typeNode
    .getText()
    .replace(/\s*\|\s*(undefined|null)/g, "")
    .trim();
  switch (text) {
    case "number":
      return { kind: "f64" };
    case "boolean":
      return { kind: "f64" }; // booleans as f64 (0.0/1.0)
    case "bigint":
      return { kind: "f64" }; // bigints as f64 (best-effort)
    case "void":
      return null;
    case "string":
      return { kind: "i32" }; // strings are pointers
    default:
      // Aliases (`type i32 = number`, `type Meters = number`) resolve here.
      return isLinearScalarType(ctx, typeNode) ? { kind: "f64" } : { kind: "i32" };
  }
}

/** Resolve parameter type using TypeChecker (for params without explicit type annotations) */
function resolveParamTypeFromChecker(ctx: LinearContext, param: ts.ParameterDeclaration): ValType {
  // First try explicit type annotation
  if (param.type) {
    const resolved = resolveType(ctx, param.type);
    if (resolved) return resolved;
  }
  // Fall back to checker inference
  try {
    const type = ctx.checker.getTypeAtLocation(param);
    const typeStr = ctx.checker.typeToString(type);
    if (typeStr === "number" || typeStr === "boolean" || typeStr === "bigint") return { kind: "f64" };
    if (typeStr === "void") return { kind: "f64" }; // shouldn't happen for params
    return { kind: "i32" }; // strings, objects, arrays → pointers
  } catch {
    return { kind: "f64" }; // default fallback
  }
}

// ── Class support ────────────────────────────────────────────────────

/** Scan a class declaration to extract field names and types, then compute layout. */
function scanClassDeclaration(ctx: LinearContext, classDecl: ts.ClassDeclaration): void {
  const className = classDecl.name!.text;
  const fieldDefs: { name: string; type: "i32" | "f64" }[] = [];
  const seenFields = new Set<string>();

  // Track collection kinds for fields
  const fieldCollectionKinds = new Map<string, "Array" | "Uint8Array" | "Map" | "Set">();

  // First: explicit property declarations
  for (const member of classDecl.members) {
    if (ts.isPropertyDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      const fieldName = member.name.text;
      const fieldType = resolveFieldType(ctx, member.type);
      fieldDefs.push({ name: fieldName, type: fieldType });
      seenFields.add(fieldName);
      // Detect collection kind from type annotation
      if (member.type) {
        const typeText = member.type.getText();
        if (typeText.endsWith("[]") || typeText.startsWith("Array<")) {
          fieldCollectionKinds.set(fieldName, "Array");
        } else if (isUint8ArrayTypeText(typeText)) {
          fieldCollectionKinds.set(fieldName, "Uint8Array");
        } else if (typeText.startsWith("Map<") || typeText === "Map") {
          fieldCollectionKinds.set(fieldName, "Map");
        } else if (typeText.startsWith("Set<") || typeText === "Set") {
          fieldCollectionKinds.set(fieldName, "Set");
        }
      }
    }
  }

  // Second: look at constructor body for `this.x = x` assignments
  for (const member of classDecl.members) {
    if (ts.isConstructorDeclaration(member) && member.body) {
      for (const stmt of member.body.statements) {
        if (ts.isExpressionStatement(stmt) && ts.isBinaryExpression(stmt.expression)) {
          const bin = stmt.expression;
          if (
            bin.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(bin.left) &&
            bin.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
            ts.isIdentifier(bin.left.name)
          ) {
            const fieldName = bin.left.name.text;
            if (!seenFields.has(fieldName)) {
              let fieldType: "i32" | "f64" = "f64";
              if (ts.isIdentifier(bin.right)) {
                for (const p of member.parameters) {
                  if (ts.isIdentifier(p.name) && p.name.text === bin.right.text && p.type) {
                    const resolved = resolveType(ctx, p.type);
                    if (resolved && resolved.kind === "i32") fieldType = "i32";
                  }
                }
              }
              fieldDefs.push({ name: fieldName, type: fieldType });
              seenFields.add(fieldName);
            }
          }
        }
      }
    }
  }

  const layout = computeClassLayout(className, fieldDefs);
  // Store collection kinds for fields
  for (const [fieldName, kind] of fieldCollectionKinds) {
    layout.fieldCollectionKinds.set(fieldName, kind);
  }
  ctx.classLayouts.set(className, layout);
}

/** Resolve a field type annotation to "i32" or "f64" */
function resolveFieldType(ctx: LinearContext, typeNode: ts.TypeNode | undefined): "i32" | "f64" {
  if (!typeNode) return "f64";
  const text = typeNode.getText();
  switch (text) {
    case "number":
      return "f64";
    case "boolean":
      return "f64";
    default:
      // Same alias hazard as resolveType: `v: i32` on a field used to land in
      // the i32/pointer slot while its reads/writes stayed f64 (#3686 bug 2).
      return isLinearScalarType(ctx, typeNode) ? "f64" : "i32";
  }
}

/** Compile a class declaration: emit constructor and method functions. */
function compileClassDeclaration(ctx: LinearContext, classDecl: ts.ClassDeclaration): void {
  const className = classDecl.name!.text;
  const layout = ctx.classLayouts.get(className)!;

  let ctorDecl: ts.ConstructorDeclaration | undefined;
  for (const member of classDecl.members) {
    if (ts.isConstructorDeclaration(member)) {
      ctorDecl = member;
      break;
    }
  }

  compileClassCtor(ctx, className, layout, ctorDecl, classDecl);

  for (const member of classDecl.members) {
    if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      compileClassMethod(ctx, className, layout, member);
    }
    if (ts.isGetAccessorDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      compileClassGetter(ctx, className, layout, member);
    }
  }
}

/** Compile a class constructor. Receives `this` as first parameter. */
function compileClassCtor(
  ctx: LinearContext,
  _className: string,
  layout: ClassLayout,
  ctorDecl: ts.ConstructorDeclaration | undefined,
  classDecl?: ts.ClassDeclaration,
): void {
  const ctorName = layout.ctorFuncName;

  const params: { name: string; type: ValType }[] = [{ name: "this", type: { kind: "i32" } }];

  if (ctorDecl) {
    for (const p of ctorDecl.parameters) {
      const paramName = ts.isIdentifier(p.name) ? p.name.text : "_";
      const type = resolveParamTypeFromChecker(ctx, p);
      params.push({ name: paramName, type });
    }
  }

  const paramTypes = params.map((p) => p.type);
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "func",
    name: `$type_${ctorName}`,
    params: paramTypes,
    results: [],
  });

  const fctx: LinearFuncContext = {
    name: ctorName,
    params,
    locals: [],
    localMap: new Map(),
    returnType: null,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    finallyStack: [],
    collectionTypes: new Map(),
    callbackParams: new Map(),
  };

  for (let i = 0; i < params.length; i++) {
    fctx.localMap.set(params[i].name, i);
  }

  ctx.currentFunc = fctx;

  // Compile field initializers (e.g., `private buf: number[] = []`)
  if (classDecl) {
    for (const member of classDecl.members) {
      if (ts.isPropertyDeclaration(member) && member.initializer && member.name && ts.isIdentifier(member.name)) {
        const fieldName = member.name.text;
        const field = layout.fields.get(fieldName);
        if (field) {
          fctx.body.push({ op: "local.get", index: 0 }); // this
          compileExpression(ctx, fctx, member.initializer);
          const valType = inferExprType(ctx, fctx, member.initializer);
          if (field.type === "i32") {
            if (valType.kind !== "i32") {
              fctx.body.push({ op: "i32.trunc_f64_s" });
            }
            fctx.body.push({ op: "i32.store", align: 2, offset: field.offset });
          } else {
            if (valType.kind === "i32") {
              fctx.body.push({ op: "f64.convert_i32_s" });
            }
            fctx.body.push({ op: "f64.store", align: 3, offset: field.offset });
          }
        }
      }
    }
  }

  if (ctorDecl?.body) {
    for (const stmt of ctorDecl.body.statements) {
      compileStatement(ctx, fctx, stmt);
    }
  }

  ctx.mod.functions.push({
    name: ctorName,
    typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: false,
  });

  ctx.currentFunc = null;
}

/** Compile a class method. Receives `this` as first parameter. */
function compileClassMethod(
  ctx: LinearContext,
  _className: string,
  layout: ClassLayout,
  methodDecl: ts.MethodDeclaration,
): void {
  const methodName = (methodDecl.name as ts.Identifier).text;
  const wasmMethodName = layout.methods.get(methodName)!;

  const params: { name: string; type: ValType }[] = [{ name: "this", type: { kind: "i32" } }];

  for (const p of methodDecl.parameters) {
    const paramName = ts.isIdentifier(p.name) ? p.name.text : "_";
    const type = resolveParamTypeFromChecker(ctx, p);
    params.push({ name: paramName, type });
  }

  const returnType = resolveType(ctx, methodDecl.type);
  const isVoid = returnType === null;

  const paramTypes = params.map((p) => p.type);
  const resultTypes: ValType[] = isVoid ? [] : [returnType];
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "func",
    name: `$type_${wasmMethodName}`,
    params: paramTypes,
    results: resultTypes,
  });

  const fctx: LinearFuncContext = {
    name: wasmMethodName,
    params,
    locals: [],
    localMap: new Map(),
    returnType: isVoid ? null : returnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    finallyStack: [],
    collectionTypes: new Map(),
    callbackParams: new Map(),
  };

  for (let i = 0; i < params.length; i++) {
    fctx.localMap.set(params[i].name, i);
  }

  ctx.currentFunc = fctx;
  detectCallbackParams(ctx, fctx, methodDecl.parameters);
  detectParamCollectionTypes(ctx, fctx, methodDecl.parameters);

  if (methodDecl.body) {
    for (const stmt of methodDecl.body.statements) {
      compileStatement(ctx, fctx, stmt);
    }
  }

  if (!isVoid) {
    fctx.body.push({ op: "unreachable" });
  }

  ctx.mod.functions.push({
    name: wasmMethodName,
    typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: false,
  });

  ctx.currentFunc = null;
}

/** Compile a class getter. Receives `this` as first parameter. */
function compileClassGetter(
  ctx: LinearContext,
  _className: string,
  layout: ClassLayout,
  getterDecl: ts.GetAccessorDeclaration,
): void {
  const getterName = (getterDecl.name as ts.Identifier).text;
  const wasmGetterName = layout.getters.get(getterName)!;

  const params: { name: string; type: ValType }[] = [{ name: "this", type: { kind: "i32" } }];

  const returnType = resolveType(ctx, getterDecl.type);
  const isVoid = returnType === null;

  const paramTypes = params.map((p) => p.type);
  const resultTypes: ValType[] = isVoid ? [] : [returnType];
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "func",
    name: `$type_${wasmGetterName}`,
    params: paramTypes,
    results: resultTypes,
  });

  const fctx: LinearFuncContext = {
    name: wasmGetterName,
    params,
    locals: [],
    localMap: new Map(),
    returnType: isVoid ? null : returnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    finallyStack: [],
    collectionTypes: new Map(),
    callbackParams: new Map(),
  };

  for (let i = 0; i < params.length; i++) {
    fctx.localMap.set(params[i].name, i);
  }

  ctx.currentFunc = fctx;

  if (getterDecl.body) {
    for (const stmt of getterDecl.body.statements) {
      compileStatement(ctx, fctx, stmt);
    }
  }

  if (!isVoid) {
    fctx.body.push({ op: "unreachable" });
  }

  ctx.mod.functions.push({
    name: wasmGetterName,
    typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: false,
  });

  ctx.currentFunc = null;
}

/** Compile `new ClassName(args)` — allocate, set tag, call constructor */
function compileClassNewExpression(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.NewExpression,
  className: string,
  layout: ClassLayout,
): void {
  const mallocIdx = ctx.funcMap.get("__malloc")!;
  const ctorIdx = ctx.funcMap.get(layout.ctorFuncName)!;

  const ptrLocal = addLocal(fctx, `$new_${className}`, { kind: "i32" });

  // __malloc(totalSize)
  fctx.body.push({ op: "i32.const", value: layout.totalSize });
  fctx.body.push({ op: "call", funcIdx: mallocIdx });
  fctx.body.push({ op: "local.set", index: ptrLocal });

  // Store type tag at +0
  fctx.body.push({ op: "local.get", index: ptrLocal });
  fctx.body.push({ op: "i32.const", value: CLASS_TYPE_TAG });
  fctx.body.push({ op: "i32.store8", align: 0, offset: 0 });

  // Store payload size at +4
  fctx.body.push({ op: "local.get", index: ptrLocal });
  fctx.body.push({ op: "i32.const", value: layout.totalSize - 8 });
  fctx.body.push({ op: "i32.store", align: 2, offset: 4 });

  // Call constructor: ctor(this, arg0, arg1, ...)
  fctx.body.push({ op: "local.get", index: ptrLocal });
  const providedArgCount = expr.arguments ? expr.arguments.length : 0;
  if (expr.arguments) {
    for (const arg of expr.arguments) {
      compileExpression(ctx, fctx, arg);
    }
  }
  // Fill in default values for missing parameters
  const ctorTypeIdx = ctx.mod.functions.find((f) => f.name === layout.ctorFuncName)?.typeIdx;
  if (ctorTypeIdx !== undefined) {
    const ctorType = ctx.mod.types[ctorTypeIdx];
    if (ctorType && ctorType.kind === "func") {
      const expectedArgCount = ctorType.params.length - 1; // subtract `this`
      for (let i = providedArgCount; i < expectedArgCount; i++) {
        const paramType = ctorType.params[i + 1]; // +1 to skip `this`
        if (paramType.kind === "i32") {
          fctx.body.push({ op: "i32.const", value: 0 });
        } else {
          fctx.body.push({ op: "f64.const", value: 0 });
        }
      }
    }
  }
  fctx.body.push({ op: "call", funcIdx: ctorIdx });

  // Result: the pointer
  fctx.body.push({ op: "local.get", index: ptrLocal });
}

/** Compile property assignment: obj.field = value */
function compilePropertyAssignment(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  propExpr: ts.PropertyAccessExpression,
  value: ts.Expression,
): void {
  const propName = propExpr.name.text;
  const className = inferClassName(ctx, fctx, propExpr.expression);

  if (className) {
    const layout = ctx.classLayouts.get(className);
    if (layout) {
      const field = layout.fields.get(propName);
      if (field) {
        // Compile: obj
        compileExpression(ctx, fctx, propExpr.expression);
        // Compile: value
        compileExpression(ctx, fctx, value);

        // Use a temp local so we can return the value (assignment is an expression)
        const tempLocal = addLocal(fctx, `$prop_tmp`, field.type === "f64" ? { kind: "f64" } : { kind: "i32" });
        fctx.body.push({ op: "local.set", index: tempLocal });

        // Store: stack has [ptr], push value, store
        fctx.body.push({ op: "local.get", index: tempLocal });
        if (field.type === "f64") {
          fctx.body.push({ op: "f64.store", align: 3, offset: field.offset });
        } else {
          fctx.body.push({ op: "i32.store", align: 2, offset: field.offset });
        }

        // Push the value back as the expression result
        fctx.body.push({ op: "local.get", index: tempLocal });
        return;
      }
    }
  }

  ctx.errors.push({
    message: `Unknown property assignment: .${propName}`,
    line: 0,
    column: 0,
  });
}

/** Infer the class name of an expression */
function inferClassName(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.Expression): string | undefined {
  // `this` — infer from function name (ClassName_ctor or ClassName_methodName)
  if (expr.kind === ts.SyntaxKind.ThisKeyword) {
    const funcName = fctx.name;
    for (const [className] of ctx.classLayouts) {
      if (funcName === `${className}_ctor` || funcName.startsWith(`${className}_`)) {
        return className;
      }
    }
    return undefined;
  }

  // Identifier — use TS type checker
  if (ts.isIdentifier(expr)) {
    try {
      const type = ctx.checker.getTypeAtLocation(expr);
      const symbol = type.getSymbol();
      if (symbol) {
        const typeName = symbol.getName();
        if (ctx.classLayouts.has(typeName)) {
          return typeName;
        }
      }
    } catch {
      // Ignore checker errors
    }
    return undefined;
  }

  // NewExpression — the class name from the constructor
  if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression)) {
    const className = expr.expression.text;
    if (ctx.classLayouts.has(className)) {
      return className;
    }
  }

  return undefined;
}

// ── String literal support ───────────────────────────────────────────

/** Compile a string literal into a __str_from_data call */
function compileStringLiteral(ctx: LinearContext, fctx: LinearFuncContext, value: string): void {
  fctx.body.push(...linearStringLiteralInstrs(ctx, value));
}

/** Look up a function's result types by its wasm function name */
function findMethodResultType(ctx: LinearContext, wasmFuncName: string): ValType[] {
  for (const f of ctx.mod.functions) {
    if (f.name === wasmFuncName) {
      const typeDef = ctx.mod.types[f.typeIdx];
      if (typeDef && typeDef.kind === "func") {
        return typeDef.results;
      }
    }
  }
  // If not yet compiled (forward reference), look at the funcMap
  // and check types. Return empty array (void) as default.
  return [];
}

/** Compile a template expression: `hello ${name}` → __str_concat chain */
function compileTemplateExpression(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.TemplateExpression): void {
  const strConcatIdx = ctx.funcMap.get("__str_concat")!;

  // Start with the head text
  compileStringLiteral(ctx, fctx, expr.head.text);

  for (const span of expr.templateSpans) {
    // Compile the expression in this span
    const spanExprType = inferExprType(ctx, fctx, span.expression);
    if (spanExprType.kind === "i32") {
      // Already a string pointer (i32), just compile
      compileExpression(ctx, fctx, span.expression);
    } else {
      // It's an f64 number — use the exact host-free Ryū formatter.
      if (linearCoercion.hasNumberToString(ctx)) {
        compileExpression(ctx, fctx, span.expression);
        linearCoercion.emitNumberToStringCall(ctx, fctx);
      } else {
        // Fallback: compile as empty string (shouldn't normally happen)
        compileStringLiteral(ctx, fctx, "");
      }
    }
    fctx.body.push({ op: "call", funcIdx: strConcatIdx });

    // If this span has trailing text, concat it too
    if (span.literal.text.length > 0) {
      compileStringLiteral(ctx, fctx, span.literal.text);
      fctx.body.push({ op: "call", funcIdx: strConcatIdx });
    }
  }
}

/** Check if an expression is a string type */
function isStringExpr(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.Expression): boolean {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr) || ts.isTemplateExpression(expr)) {
    return true;
  }
  // Use TypeChecker for any expression
  try {
    const type = ctx.checker.getTypeAtLocation(expr);
    if (type.flags & ts.TypeFlags.StringLike) {
      return true;
    }
    // Also check non-nullable type for expressions like map.get() that return string | undefined
    const nonNull = ctx.checker.getNonNullableType(type);
    if (nonNull.flags & ts.TypeFlags.StringLike) {
      return true;
    }
  } catch {
    // Ignore
  }
  return false;
}

// ── Closure / callback support ──────────────────────────────────────────

/** Emit funcref table and element segment if any lambdas were compiled */
/** Collect module-level variable declarations as wasm globals */
function collectModuleGlobals(ctx: LinearContext, sf: ts.SourceFile): void {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    // Skip declare statements
    if (stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) continue;
    const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const name = decl.name.text;
      if (ctx.funcMap.has(name)) continue;
      if (ctx.moduleGlobals.has(name)) continue;
      if (ctx.classLayouts.has(name)) continue;

      // Determine the wasm type
      const wasmType = inferDeclType(ctx, decl);

      // Try to extract a constant initializer for immutable globals
      let initInstr: Instr[];
      if (isConst && decl.initializer && ts.isNumericLiteral(decl.initializer)) {
        const val = Number(decl.initializer.text);
        initInstr =
          wasmType.kind === "i32"
            ? [{ op: "i32.const" as const, value: val | 0 }]
            : [{ op: "f64.const" as const, value: val }];
      } else {
        initInstr =
          wasmType.kind === "i32" ? [{ op: "i32.const" as const, value: 0 }] : [{ op: "f64.const" as const, value: 0 }];
      }

      const globalIdx = ctx.mod.globals.length;
      ctx.mod.globals.push({
        name: `__mod_${name}`,
        type: wasmType,
        mutable: !isConst || !decl.initializer || !ts.isNumericLiteral(decl.initializer),
        init: initInstr,
      });
      ctx.moduleGlobals.set(name, globalIdx);

      // Detect collection kind for module-level variables
      if (decl.initializer) {
        if (ts.isNewExpression(decl.initializer) && ts.isIdentifier(decl.initializer.expression)) {
          const ctorName = decl.initializer.expression.text;
          if (ctorName === "Set") ctx.moduleCollectionTypes.set(name, "Set");
          else if (ctorName === "Map") ctx.moduleCollectionTypes.set(name, "Map");
          else if (ctorName === "Uint8Array") ctx.moduleCollectionTypes.set(name, "Uint8Array");
        } else if (ts.isArrayLiteralExpression(decl.initializer)) {
          ctx.moduleCollectionTypes.set(name, "Array");
        }
      }
      if (decl.type) {
        const text = decl.type.getText();
        if (text.startsWith("Set<") || text === "Set") ctx.moduleCollectionTypes.set(name, "Set");
        else if (text.startsWith("Map<") || text === "Map") ctx.moduleCollectionTypes.set(name, "Map");
        else if (isUint8ArrayTypeText(text)) ctx.moduleCollectionTypes.set(name, "Uint8Array");
        else if (text.endsWith("[]") || text.startsWith("Array<")) ctx.moduleCollectionTypes.set(name, "Array");
      }
    }
  }
}

/** Infer the wasm type for a variable declaration */
function inferDeclType(ctx: LinearContext, decl: ts.VariableDeclaration): ValType {
  if (decl.initializer) {
    // For new expressions of known object types, use i32
    if (ts.isNewExpression(decl.initializer) && ts.isIdentifier(decl.initializer.expression)) {
      return { kind: "i32" };
    }
  }
  // Use TypeChecker
  try {
    const type = ctx.checker.getTypeAtLocation(decl);
    const baseType = ctx.checker.getNonNullableType(type);
    // Check type flags for number-like types (includes literal types like `1`, `2`, etc.)
    if (baseType.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) return { kind: "f64" };
    // Everything else (strings, objects, arrays, classes, etc.) is i32 pointers
    return { kind: "i32" };
  } catch {
    /* fall through */
  }
  return { kind: "f64" };
}

/** Rebuild funcMap from actual function positions and patch all call/ref.func indices */
function fixupFuncIndices(ctx: LinearContext): void {
  // Build old→new index mapping
  const oldToNew = new Map<number, number>();
  const newFuncMap = new Map<string, number>();

  for (let i = 0; i < ctx.mod.functions.length; i++) {
    const fn = ctx.mod.functions[i];
    const newIdx = ctx.numImportFuncs + i;
    const oldIdx = ctx.funcMap.get(fn.name);
    if (oldIdx !== undefined && oldIdx !== newIdx) {
      oldToNew.set(oldIdx, newIdx);
    }
    newFuncMap.set(fn.name, newIdx);
  }

  if (oldToNew.size === 0) return; // No fixups needed

  // Update funcMap
  ctx.funcMap = newFuncMap;

  // Note: tableEntries are NOT remapped here because they store the correct
  // final position in mod.functions (set right before push in compileArrowFunctionArg).
  // The oldToNew map may contain colliding indices from non-lambda functions
  // that were registered in funcMap before lambdas shifted their positions.

  // Patch all call and ref.func instructions in all function bodies
  function patchInstrs(instrs: Instr[]): void {
    for (const instr of instrs) {
      if (instr.op === "call") {
        const mapped = oldToNew.get(instr.funcIdx);
        if (mapped !== undefined) instr.funcIdx = mapped;
      } else if (instr.op === "ref.func") {
        const mapped = oldToNew.get(instr.funcIdx);
        if (mapped !== undefined) instr.funcIdx = mapped;
      } else if (instr.op === "block" || instr.op === "loop") {
        patchInstrs(instr.body);
      } else if (instr.op === "if") {
        patchInstrs(instr.then);
        if (instr.else) patchInstrs(instr.else);
      } else if (instr.op === "try") {
        patchInstrs(instr.body);
        for (const c of instr.catches) patchInstrs(c.body);
        if (instr.catchAll) patchInstrs(instr.catchAll);
      }
    }
  }

  for (const fn of ctx.mod.functions) {
    patchInstrs(fn.body);
  }

  // Fix up export indices
  for (const exp of ctx.mod.exports) {
    if (exp.desc.kind === "func") {
      const mapped = oldToNew.get(exp.desc.index);
      if (mapped !== undefined) exp.desc.index = mapped;
    }
  }
}

function emitClosureTable(ctx: LinearContext): void {
  if (ctx.tableEntries.length === 0) return;
  // Add a funcref table large enough for all lambdas
  ctx.mod.tables.push({
    elementType: "funcref",
    min: ctx.tableEntries.length,
    max: ctx.tableEntries.length,
  });
  // Add element segment to populate the table at offset 0
  ctx.mod.elements.push({
    tableIdx: 0,
    offset: [{ op: "i32.const", value: 0 }],
    funcIndices: ctx.tableEntries,
  });
}

/**
 * Detect collection-typed parameters (arrays, Uint8Array, Map, Set)
 * and register them in fctx.collectionTypes.
 */
function detectParamCollectionTypes(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  params: ts.NodeArray<ts.ParameterDeclaration>,
): void {
  for (const param of params) {
    if (!ts.isIdentifier(param.name)) continue;
    const paramName = param.name.text;
    // Check explicit type annotation
    if (param.type) {
      const text = param.type.getText();
      if (isNumberArrayOrUint8ArrayUnionText(text)) {
        fctx.collectionTypes.set(paramName, "ArrayOrUint8Array");
        continue;
      }
      if (text === "number[]" || text.endsWith("[]") || text.startsWith("Array<")) {
        fctx.collectionTypes.set(paramName, "Array");
        continue;
      }
      if (isUint8ArrayTypeText(text)) {
        fctx.collectionTypes.set(paramName, "Uint8Array");
        continue;
      }
      if (text.startsWith("Map<") || text === "Map") {
        fctx.collectionTypes.set(paramName, "Map");
        continue;
      }
      if (text.startsWith("Set<") || text === "Set") {
        fctx.collectionTypes.set(paramName, "Set");
        continue;
      }
    }
    // TypeChecker fallback
    try {
      const type = ctx.checker.getTypeAtLocation(param);
      const typeStr = ctx.checker.typeToString(type);
      if (isNumberArrayOrUint8ArrayUnionText(typeStr)) {
        fctx.collectionTypes.set(paramName, "ArrayOrUint8Array");
        continue;
      }
      if (isUint8ArrayTypeText(typeStr)) {
        fctx.collectionTypes.set(paramName, "Uint8Array");
        continue;
      }
      if (typeStr.startsWith("Map<")) {
        fctx.collectionTypes.set(paramName, "Map");
        continue;
      }
      if (typeStr.startsWith("Set<")) {
        fctx.collectionTypes.set(paramName, "Set");
        continue;
      }
      if (typeStr.endsWith("[]") || typeStr.startsWith("Array<")) {
        fctx.collectionTypes.set(paramName, "Array");
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * Detect function-typed parameters and register them as callback params.
 * Called during function compilation setup.
 */
function detectCallbackParams(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  params: ts.NodeArray<ts.ParameterDeclaration>,
): void {
  for (const param of params) {
    if (!param.type || !ts.isIdentifier(param.name)) continue;
    // Check if the type is a function type: (x: T) => R
    if (ts.isFunctionTypeNode(param.type)) {
      const paramName = param.name.text;
      // Build the call_indirect type signature from the function type
      const cbParams: ValType[] = [];
      for (const p of param.type.parameters) {
        cbParams.push(resolveParamTypeFromChecker(ctx, p));
      }
      const cbReturn = resolveType(ctx, param.type.type);
      const cbResults: ValType[] = cbReturn ? [cbReturn] : [];

      // Find or create a type index for this callback signature
      let typeIdx = -1;
      for (let ti = 0; ti < ctx.mod.types.length; ti++) {
        const t = ctx.mod.types[ti]!;
        if (t.kind !== "func") continue;
        if (
          t.params.length === cbParams.length &&
          t.results.length === cbResults.length &&
          t.params.every((p: ValType, j: number) => p.kind === cbParams[j]!.kind) &&
          t.results.every((r: ValType, j: number) => r.kind === cbResults[j]!.kind)
        ) {
          typeIdx = ti;
          break;
        }
      }
      if (typeIdx < 0) {
        typeIdx = ctx.mod.types.length;
        ctx.mod.types.push({
          kind: "func",
          name: `$cb_type_${paramName}`,
          params: cbParams,
          results: cbResults,
        });
      }
      fctx.callbackParams.set(paramName, typeIdx);
    }
  }
}

/**
 * Compile an arrow function expression as a separate Wasm function.
 * Returns the table index for the compiled function.
 *
 * Captures from the enclosing scope are passed via the __closure_env global.
 * The lambda reads them at function entry and stores in locals.
 */
function compileArrowFunctionArg(
  ctx: LinearContext,
  outerFctx: LinearFuncContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
): number {
  const lambdaName = `$lambda_${ctx.lambdaCounter++}`;

  // Detect captured variables by scanning the arrow body for identifiers
  // that reference the outer scope (locals, params, or 'this')
  const captures: { name: string; outerIdx: number; type: ValType }[] = [];
  const capturedNames = new Set<string>();

  function scanCaptures(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      const name = node.text;
      if (capturedNames.has(name)) return;
      // Check if this identifier is from the outer scope (not an arrow param)
      const isArrowParam = arrow.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name);
      if (!isArrowParam) {
        const outerIdx = outerFctx.localMap.get(name);
        if (outerIdx !== undefined) {
          capturedNames.add(name);
          const outerType =
            outerIdx < outerFctx.params.length
              ? outerFctx.params[outerIdx].type
              : (outerFctx.locals[outerIdx - outerFctx.params.length]?.type ?? { kind: "f64" as const });
          captures.push({ name, outerIdx, type: outerType });
        }
      }
    } else if (node.kind === ts.SyntaxKind.ThisKeyword) {
      if (!capturedNames.has("this")) {
        const outerIdx = outerFctx.localMap.get("this");
        if (outerIdx !== undefined) {
          capturedNames.add("this");
          captures.push({ name: "this", outerIdx, type: { kind: "i32" } });
        }
      }
    }
    forEachChild(node, scanCaptures);
  }
  if (arrow.body) scanCaptures(arrow.body);

  // Build parameter list for the lambda function
  const params: { name: string; type: ValType }[] = [];
  for (const p of arrow.parameters) {
    const paramName = ts.isIdentifier(p.name) ? p.name.text : "_";
    const type = resolveParamTypeFromChecker(ctx, p);
    params.push({ name: paramName, type });
  }

  // Determine return type
  const returnType = arrow.type ? resolveType(ctx, arrow.type) : null;
  const isVoid = returnType === null;
  const paramTypes = params.map((p) => p.type);
  const resultTypes: ValType[] = isVoid ? [] : [returnType];

  // Create type and function context — reuse existing type if structurally identical
  // (required for call_indirect type checking in WebAssembly)
  let typeIdx = -1;
  for (let ti = 0; ti < ctx.mod.types.length; ti++) {
    const t = ctx.mod.types[ti]!;
    if (t.kind !== "func") continue;
    if (
      t.params.length === paramTypes.length &&
      t.results.length === resultTypes.length &&
      t.params.every((p: ValType, j: number) => p.kind === paramTypes[j]!.kind) &&
      t.results.every((r: ValType, j: number) => r.kind === resultTypes[j]!.kind)
    ) {
      typeIdx = ti;
      break;
    }
  }
  if (typeIdx < 0) {
    typeIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "func",
      name: `$type_${lambdaName}`,
      params: paramTypes,
      results: resultTypes,
    });
  }

  const fctx: LinearFuncContext = {
    name: lambdaName,
    params,
    locals: [],
    localMap: new Map(),
    returnType: isVoid ? null : returnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    finallyStack: [],
    collectionTypes: new Map(),
    callbackParams: new Map(),
  };

  for (let i = 0; i < params.length; i++) {
    fctx.localMap.set(params[i].name, i);
  }

  // Add locals for captured variables and load them from __closure_env
  if (captures.length > 0) {
    // Read env pointer from global at function entry
    const envLocal = addLocal(fctx, "$env", { kind: "i32" });
    fctx.body.push({ op: "global.get", index: ctx.closureEnvGlobalIdx });
    fctx.body.push({ op: "local.set", index: envLocal });

    // Load each captured variable from the env struct
    for (let i = 0; i < captures.length; i++) {
      const cap = captures[i];
      const capLocal = addLocal(fctx, cap.name, cap.type);
      fctx.body.push({ op: "local.get", index: envLocal });
      if (cap.type.kind === "f64") {
        fctx.body.push({ op: "f64.load", align: 3, offset: i * 8 });
      } else {
        fctx.body.push({ op: "i32.load", align: 2, offset: i * 8 });
      }
      fctx.body.push({ op: "local.set", index: capLocal });
      // Copy collection types from outer scope
      const outerCollKind = outerFctx.collectionTypes.get(cap.name);
      if (outerCollKind) {
        fctx.collectionTypes.set(cap.name, outerCollKind);
      }
    }
  }

  // Compile the arrow body
  ctx.currentFunc = fctx;
  if (ts.isBlock(arrow.body)) {
    for (const stmt of arrow.body.statements) {
      compileStatement(ctx, fctx, stmt);
    }
  } else {
    // Expression body: () => expr
    compileExpression(ctx, fctx, arrow.body);
  }

  if (!isVoid) {
    fctx.body.push({ op: "unreachable" });
  }

  // Register the function
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set(lambdaName, funcIdx);
  ctx.mod.functions.push({
    name: lambdaName,
    typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: false,
  });

  // Add to table and return table index
  const tableIdx = ctx.tableEntries.length;
  ctx.tableEntries.push(funcIdx);

  // Restore outer context
  ctx.currentFunc = outerFctx;

  return tableIdx;
}

/**
 * Emit code to set up __closure_env and push the table index for an arrow
 * function argument. Used at call sites where an arrow function is passed.
 */
function emitClosureSetup(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
): void {
  const tableIdx = compileArrowFunctionArg(ctx, fctx, arrow);

  // Detect captures to set up env
  const captures: { name: string; outerIdx: number; type: ValType }[] = [];
  const capturedNames = new Set<string>();

  function scanCaptures(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      const name = node.text;
      if (capturedNames.has(name)) return;
      const isArrowParam = arrow.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name);
      if (!isArrowParam) {
        const outerIdx = fctx.localMap.get(name);
        if (outerIdx !== undefined) {
          capturedNames.add(name);
          const outerType =
            outerIdx < fctx.params.length
              ? fctx.params[outerIdx].type
              : (fctx.locals[outerIdx - fctx.params.length]?.type ?? { kind: "f64" as const });
          captures.push({ name, outerIdx, type: outerType });
        }
      }
    } else if (node.kind === ts.SyntaxKind.ThisKeyword) {
      if (!capturedNames.has("this")) {
        const outerIdx = fctx.localMap.get("this");
        if (outerIdx !== undefined) {
          capturedNames.add("this");
          captures.push({ name: "this", outerIdx, type: { kind: "i32" } });
        }
      }
    }
    forEachChild(node, scanCaptures);
  }
  if (arrow.body) scanCaptures(arrow.body);

  if (captures.length > 0) {
    // Allocate env struct and store captured values
    // Use uniform 8-byte slots for simplicity (f64 needs 8, i32 needs 4 but we align to 8)
    const envSize = captures.length * 8;
    const envLocal = addLocal(fctx, `$env_${ctx.lambdaCounter}`, { kind: "i32" });
    fctx.body.push({ op: "i32.const", value: envSize });
    const mallocIdx = ctx.funcMap.get("__malloc")!;
    fctx.body.push({ op: "call", funcIdx: mallocIdx });
    fctx.body.push({ op: "local.set", index: envLocal });

    // Store each captured variable
    for (let i = 0; i < captures.length; i++) {
      const cap = captures[i];
      fctx.body.push({ op: "local.get", index: envLocal });
      fctx.body.push({ op: "local.get", index: cap.outerIdx });
      if (cap.type.kind === "f64") {
        fctx.body.push({ op: "f64.store", align: 3, offset: i * 8 });
      } else {
        fctx.body.push({ op: "i32.store", align: 2, offset: i * 8 });
      }
    }

    // Set __closure_env global
    fctx.body.push({ op: "local.get", index: envLocal });
    fctx.body.push({ op: "global.set", index: ctx.closureEnvGlobalIdx });
  }

  // Push the table index as the i32 argument value
  fctx.body.push({ op: "i32.const", value: tableIdx });
}

/**
 * Emit a call to an extern-C import, marshalling at the boundary (#4539).
 *
 * Arity is validated here rather than left to Wasm validation: a C callee is
 * fixed-arity, and a mismatch caught at the call site names the function and
 * the source location, where a validation failure would surface as an opaque
 * "type mismatch" against a whole module.
 */
function emitExternCCall(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.CallExpression,
  funcName: string,
  funcIdx: number,
  sig: { params: ValType[]; results: ValType[] },
): void {
  if (expr.arguments.length !== sig.params.length) {
    ctx.errors.push({
      message:
        `extern-C import '${funcName}' takes ${sig.params.length} argument(s), ` +
        `called with ${expr.arguments.length}. C imports are fixed-arity — ` +
        "there are no defaults to fill in.",
      ...nodeLoc(expr),
    });
    fctx.body.push({ op: "f64.const", value: 0 });
    return;
  }
  try {
    for (let i = 0; i < expr.arguments.length; i++) {
      compileCallArg(ctx, fctx, expr.arguments[i]);
      emitExternCBoundaryArg(fctx.body, sig.params[i]);
    }
    fctx.body.push({ op: "call", funcIdx });
    // A void C function leaves nothing on the stack; the linear backend's
    // expression positions always expect a value, so push the same `f64.const
    // 0` the rest of the backend uses for a void result.
    if (sig.results.length === 0) {
      fctx.body.push({ op: "f64.const", value: 0 });
    } else {
      emitExternCBoundaryResult(fctx.body, sig.results[0]);
    }
  } catch (error) {
    ctx.errors.push({ message: (error as Error).message, ...nodeLoc(expr) });
    fctx.body.push({ op: "f64.const", value: 0 });
  }
}
