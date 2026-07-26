// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// ---------------------------------------------------------------------------
// The five-part backend contract — v1 FREEZE (#3029-S1 / #3029-S4).
//
// Normative companion: docs/architecture/target-architecture.md ("The backend
// contract") and src/ir/backend/README.md (ownership + operand-order rules).
//
// A backend — WasmGC, linear, bytecode, or a future MLIR/Cranelift lowering —
// is exactly FIVE declared parts, all consulted through the interfaces in
// this file, none through imports of another backend's internals:
//
//   1. TypeConverter        IR type        → backend value slots
//   2. BackendLegality      IR function    → "is this legal for me?"
//   3. BackendEmitter<Sink> IR instruction → terminal backend ops on a sink
//   4. LayoutResolver       IR shape       → memoized layout handles
//   5. ModuleAssembler      module records → index identity + final layout
//
// WHAT "FREEZE" MEANS (and does not mean)
// ---------------------------------------
// This file freezes the SHAPE of the seam, not its completeness:
//   - Methods may be ADDED to any of the five interfaces (additive change,
//     as #2953/#2956 discover needs). Removing or re-typing a frozen member
//     is a breaking change and needs an issue + migration wave.
//   - What the freeze forbids is new BYPASSES around the seam: new backend
//     work must be expressible as an implementation of (a subset of) these
//     five interfaces, never as a fourth hand-rolled path.
//   - The freeze is call-site-neutral: nothing in this file changes any
//     existing behavior. Where a live interface already realizes a contract
//     part (`BackendEmitter`, `IrLowerResolver`), the contract re-exports it
//     as the canonical name rather than duplicating it (duplication would
//     drift; see the per-part notes below).
//
// Conformance: src/ir/backend/contract-conformance.ts compiles a stub
// backend against every interface here (tsc-enforced via the `quality`
// gate's `pnpm run typecheck`; tsconfig covers src/**). Runtime smoke lives
// in tests/backend-contract.test.ts.
// ---------------------------------------------------------------------------

import type { IrFunction, IrType } from "../nodes.js";
import type { FuncHandle, GlobalDef, GlobalHandle, TypeDef, TypeHandle, ValType, WasmFunction } from "../types.js";
import type { ModuleLayout } from "../../emit/resolve-layout.js";
import type { BackendEmitter } from "./emitter.js";
import type { IrLowerResolver } from "../lower.js";
import { type IrBackendKind, type IrBackendLegalityError, verifyIrBackendLegality } from "./legality.js";

// ---------------------------------------------------------------------------
// Part 3 — BackendEmitter<Sink> (already live; re-exported as contract surface)
// ---------------------------------------------------------------------------
// The instruction-level half of a backend: typed emission *intents*
// (`emitVecGet`, `emitBox`, `emitClosureNew`, …) pushing terminal ops onto an
// opaque `Sink`. The sink is the ONE representation-specific seam (#1715):
// WasmGC/linear use `Instr[]`, bytecode uses `BytecodeSink`, an MLIR backend
// would use a builder. Operand evaluation order is the CALLER's job (lower.ts
// emits operand subtrees before calling a primitive); the emitter never calls
// back into value emission. `pushRaw` is the audited escape hatch, ratcheted
// down by #2953 (R-ESCAPE).
export type { BackendEmitter } from "./emitter.js";

// The backend identity enum shared by legality, emitters, and assemblers.
export type { IrBackendKind, IrBackendLegalityError } from "./legality.js";

// ---------------------------------------------------------------------------
// Part 4 — LayoutResolver (live as `IrLowerResolver`; canonical contract name)
// ---------------------------------------------------------------------------
// The layout-handle factory: resolves IR shapes (vec / object / closure /
// refcell / union / boxed / class / string / dynamic) to memoized layout
// handles (`IrVecLowering`, `IrObjectStructLowering`, … — see handles.ts) and
// owns the string/boxing emission helpers. MEMOIZATION LIVES HERE and only
// here: one WasmGC struct per shape per module, shared with the legacy path
// via the registries in integration.ts.
//
// The interface is frozen under its contract name here; `IrLowerResolver` is
// the same type (the today-name). #3029-S3 extracts the *implementation* out
// of integration.ts so `src/ir/` stops importing `src/codegen/`; the shape a
// backend implements is already exactly this. Layout handles are per-backend
// data and are NEVER serialized (#3030 D4).
export type { IrLowerResolver, IrLowerResolver as LayoutResolver } from "../lower.js";
export type {
  IrBoxedLowering,
  IrClassLowering,
  IrClosureLowering,
  IrObjectStructLowering,
  IrRefCellLowering,
  IrUnionLowering,
  IrVecLowering,
  LinearMemoryFieldLowering,
  LinearObjectLowering,
  LinearRefCellLowering,
  LinearVecLowering,
} from "./handles.js";

// ---------------------------------------------------------------------------
// Part 1 — TypeConverter (declared here; #1851 L3 promotes the free function)
// ---------------------------------------------------------------------------

/**
 * Backend value-slot conversion: how one IR type is carried as backend
 * value(s).
 *
 * - WasmGC: `Slot = ValType`, and every IR type converts to EXACTLY ONE slot
 *   (the current realization is the free function `lowerIrTypeToValType` in
 *   lower.ts, which delegates the symbolic kinds — string/object/closure/
 *   class/union/boxed/dynamic — to the LayoutResolver and wraps the result).
 * - Linear: scalar IR types are one slot; the DYNAMIC residue is a
 *   value+tag slot PAIR (`[f64 value, i32 tag]` — the ratified #1852 §1
 *   representation), which is why the contract returns `readonly Slot[]`
 *   and not a single slot.
 * - Bytecode: everything is one f64-shaped VM slot.
 *
 * The converter is TOTAL over the IR types its `BackendLegality` admits: if
 * legality accepts a function, `convertType` must not throw on any type in
 * it. Conversely it MAY throw (loudly, with the type kind in the message) on
 * types legality rejects — callers are expected to have gated already.
 *
 * Purity: `convertType` may register backend types as a side effect (the GC
 * realization lazily registers structs via the LayoutResolver), but must be
 * idempotent — converting the same IrType twice yields identical slots and
 * at most one registration (memoization is the LayoutResolver's job).
 */
export interface TypeConverter<Slot = ValType> {
  readonly backend: IrBackendKind;
  /** IR type → the backend value slot(s) that carry one value of it. */
  convertType(t: IrType): readonly Slot[];
}

// ---------------------------------------------------------------------------
// Part 2 — BackendLegality (promotes legality.ts onto the contract)
// ---------------------------------------------------------------------------

/**
 * The per-backend legality declaration: which IR functions this backend can
 * lower at its function-lowering boundary. "Lowering finished" for a backend
 * means *only ops it declares legal remain* — checked before lowering so an
 * unsupported surface is a localized diagnostic, not a late raw-emitter
 * throw or malformed output (#1850/#1851 L4).
 *
 * The frozen surface is the whole-function check. Per-instruction /
 * per-type predicates stay implementation details of legality.ts today; if
 * a consumer needs them they are ADDED here (additive), not reached around.
 */
export interface BackendLegality {
  readonly backend: IrBackendKind;
  /** Empty array = the function is fully legal for this backend. */
  checkFunction(func: IrFunction): readonly IrBackendLegalityError[];
}

/**
 * The canonical `BackendLegality` for one of the four registered backends,
 * realized over the existing `verifyIrBackendLegality` free function
 * (call-site-neutral: lower.ts keeps calling the free function directly;
 * new consumers and out-of-tree backends use this interface form).
 */
export function legalityFor(backend: IrBackendKind): BackendLegality {
  return {
    backend,
    checkFunction: (func: IrFunction): readonly IrBackendLegalityError[] => verifyIrBackendLegality(func, backend),
  };
}

// ---------------------------------------------------------------------------
// Part 5 — ModuleAssembler (#3029-S4: the index-identity design)
// ---------------------------------------------------------------------------
//
// The module-level half of a backend: ownership of function slots,
// import/export registration, type registration, globals, and the start
// record — with NAME/HANDLE-BASED identity. This is the compiler's #1
// historical regression surface (≥7 numbered regressions from
// absolute-index baking: #618, #1109, #1384, #1525b, #1666, #1677, #2191,
// #2193, #2918, #2078; freshly re-confirmed 2026-07 by a stale cached
// `__gen_eager_mode` global index). The assembler contract makes the bug
// class unrepresentable: A CONSUMER OF THIS INTERFACE NEVER SEES A MODULE
// INDEX. Indices exist only inside the `ModuleLayout` returned by
// `finalize()`, and only the serializer dereferences them.
//
// INVARIANTS (normative — the ratified S4 spec lives in
// plan/issues/3029-clean-compiler-architecture-umbrella.md §"S4 —
// ModuleAssembler design (ratified)"):
//
//   A1  Handles are minted once, never renumbered, never reused. A handle is
//       the identity of the entity for the whole compile.
//   A2  Two-phase declare/define: `declareFunc` mints the handle BEFORE the
//       body exists; `defineFunc` binds the definition exactly once, possibly
//       after arbitrary nested emission (other declares/defines in between).
//       This is the proven mint/push protocol of src/codegen/func-space.ts
//       (#1916 S3). Declared-but-never-defined handles fail loudly at
//       finalize, never silently mis-emit.
//   A3  Imports may be registered AT ANY TIME before finalize — a late
//       import is FREE. No shift pass exists in this contract; late-import
//       index shifting is a transitional implementation detail of the
//       WasmGC adapter that #2710 slice 4 deletes.
//   A4  Index assignment happens EXACTLY ONCE, inside `finalize()`, after
//       all registration + DCE churn (today's `indexSpaceFrozen = true`
//       point in generateModule). `finalize` is single-shot; any mutation
//       after it throws.
//   A5  Caching a handle is always safe. Caching a resolved index anywhere
//       outside the emit phase is a contract violation (the #2078 /
//       `__gen_eager_mode` class). The branded handle types (#2710 slice 1)
//       make positional arithmetic on a handle a compile error once flipped
//       to real brands.
//   A6  Structural binding → handle lookup is the assembler's. IR refs
//       (`IrFuncRef`/`IrGlobalRef`/`IrTypeRef`, #3030 D3.2) resolve by their
//       closed binding payloads; compatibility names are diagnostics/public
//       labels only. Today's `ctx.funcMap` / `moduleGlobals` / `typeNames`
//       become explicit legacy views over that one authority.
//   A7  Dead-code elimination marks handles dead; `finalize` skips dead
//       handles when assigning indices. Nothing ever renumbers instructions
//       (DCE's remove-and-renumber remap is subsumed — #2710 slice 4d).
//
// Definition payloads are generic (`FuncDefT`/`GlobalDefT`/`TypeDefT`)
// because they are backend-shaped: the in-tree Wasm backends use the
// `src/ir/types.ts` records (the defaults); an MLIR assembler's payloads
// would be dialect ops and its `finalize` would produce an `mlir::ModuleOp`
// layout. The handle model is identical either way.
export interface ModuleAssembler<FuncDefT = WasmFunction, GlobalDefT = GlobalDef, TypeDefT = TypeDef> {
  readonly backend: IrBackendKind;

  // ---- function index space ---------------------------------------------
  /**
   * Mint the stable handle for a defined function under `name` (A1/A2/A6).
   * MUST be paired with exactly one later `defineFunc` for the handle.
   * Convergence: `mintDefinedFunc` (src/codegen/func-space.ts).
   */
  declareFunc(name: string): FuncHandle;
  /**
   * Bind the definition for a previously declared handle (A2). Throws on a
   * double-define or an undeclared handle. Convergence: `pushDefinedFunc`.
   */
  defineFunc(handle: FuncHandle, def: FuncDefT): void;
  /**
   * Register a function import and mint its handle. Legal at ANY point
   * before `finalize` (A3) — this is the member that retires
   * `addUnionImports`/`addStringImports`/`ensureLateImport`'s shift regime.
   * `name` is the in-module symbolic name (one namespace with defined
   * functions, A6).
   */
  importFunc(module: string, field: string, typeHandle: TypeHandle, name: string): FuncHandle;
  /** Explicit legacy-name adapter; structural IrFuncRef resolution must not call this. */
  lookupFunc(name: string): FuncHandle | undefined;

  // ---- global index space -------------------------------------------------
  /** Mint the stable handle for a defined global (A1/A2/A6). */
  declareGlobal(name: string): GlobalHandle;
  /** Bind the definition for a previously declared global handle (A2). */
  defineGlobal(handle: GlobalHandle, def: GlobalDefT): void;
  /**
   * Register a global import (e.g. host string constants) and mint its
   * handle. Legal at any time before finalize (A3) — retires
   * `fixupModuleGlobalIndices` + its ~25 cached-field chases (#2710 4a).
   */
  importGlobal(module: string, field: string, type: ValType, mutable: boolean, name: string): GlobalHandle;
  /** Explicit legacy-name adapter; structural IrGlobalRef resolution must not call this. */
  lookupGlobal(name: string): GlobalHandle | undefined;

  // ---- type index space ---------------------------------------------------
  /**
   * Intern a type definition, returning the handle of the structurally
   * canonical entry (dedup is the assembler's — one entry per distinct
   * definition; layout-handle memoization stays with the LayoutResolver).
   * `name` (optional) additionally registers a compatibility handle label.
   */
  internType(def: TypeDefT, name?: string): TypeHandle;
  /** Explicit legacy-name adapter; structural IrTypeRef resolution must not call this. */
  lookupType(name: string): TypeHandle | undefined;

  // ---- module records -------------------------------------------------------
  /** Record a function export by handle (never by index). */
  exportFunc(exportName: string, handle: FuncHandle): void;
  /** Record a global export by handle. */
  exportGlobal(exportName: string, handle: GlobalHandle): void;
  /** Record the start function by handle. */
  setStart(handle: FuncHandle): void;

  // ---- the single index authority (A4) --------------------------------------
  /**
   * Freeze the module: verify every declared handle is defined (A2), skip
   * dead handles (A7), compute the canonical layout (imports in
   * registration order first, then live defined entries in define order —
   * reproducing today's final layout exactly, per the #2710 flip
   * preconditions), and return the ONE `handle → final index` authority.
   * Single-shot: a second call, or any mutation afterwards, throws.
   * Convergence: `resolveLayout` (src/emit/resolve-layout.ts) is the live
   * seam this contract's finalize is built on.
   */
  finalize(): ModuleLayout;
}

// ---------------------------------------------------------------------------
// The bundle — what "a backend" is, as one value
// ---------------------------------------------------------------------------

/**
 * A complete backend: the five parts under one roof. In-tree backends may
 * keep implementing the parts separately (the contract is the seam, not a
 * class hierarchy); the bundle type exists so a NEW backend has a single
 * concrete answer to "what do I implement", and so conformance tests can
 * range over the whole contract at once.
 *
 * `Sink` is the emitter's output representation (part 3); `Slot` the value
 * representation (part 1); the three `*DefT` payloads the module-record
 * shapes (part 5).
 */
export interface BackendContract<
  Sink = unknown,
  Slot = ValType,
  FuncDefT = WasmFunction,
  GlobalDefT = GlobalDef,
  TypeDefT = TypeDef,
> {
  readonly backend: IrBackendKind;
  readonly types: TypeConverter<Slot>;
  readonly legality: BackendLegality;
  readonly emitter: BackendEmitter<Sink>;
  readonly layouts: IrLowerResolver;
  readonly assembler: ModuleAssembler<FuncDefT, GlobalDefT, TypeDefT>;
}
