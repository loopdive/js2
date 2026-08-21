// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// IR → Wasm emission pass.
//
// This is where symbolic refs (IrFuncRef / IrGlobalRef / IrTypeRef) are
// resolved to concrete indices. Because lowering runs AFTER all imports are
// finalized by the caller, the legacy `shiftLateImportIndices` pass is a
// no-op for any function emitted via this path — that is the central payoff
// of the symbolic-ref design (spec #1131 §1.2).
//
// Emission strategy
// =================
//
// The emitter reconstructs structured Wasm control flow from the IR's basic
// blocks. Phase 1's control-flow shape is narrow: the entry block either
// ends in `return` (straight-line function) or in `br_if` to two
// tail-shaped arms that each terminate with `return` (or, recursively, with
// another nested if/else). No joins, no back-edges, no fall-through from
// structured blocks. This maps 1:1 onto Wasm's structured `if/else/end`
// without building a dominator tree.
//
// Per-block emission strategy:
//   - Walk `block.instrs` in order. For each instruction whose result is
//     used in a *different* block, emit the defining subtree followed by
//     `local.set` — this materializes the value so successor blocks can
//     read it via `local.get`. (Params are already in locals, so they
//     never need this.)
//   - Skip emission for intra-block single-use and multi-use values — those
//     are handled at the use site: single-use via inline tree emission,
//     multi-use via `tree + local.tee` on first use and `local.get` after.
//   - Lower the terminator:
//       * `return` → emit each value, then a Wasm `return` op.
//       * `br_if`  → emit the condition, then a Wasm structured `if/else`
//                    containing the recursively-emitted then/else blocks.
//
// After the entry block emission, we append a `return` op (for a
// return-terminated function) or `unreachable` (for a br_if-terminated
// function). The latter satisfies Wasm's stack-type validator at function
// end — both arms of the structured if always `return`, so fallthrough is
// unreachable at runtime, but structurally we still need an op whose type
// is polymorphic.

// #1713: BackendEmitter trait seam. The layout-handle types this file
// historically declared now live in `backend/handles.js` and are re-exported
// below for backwards compatibility.
import type { BackendEmitter, BackendI32BitwiseOp } from "./backend/emitter.js";
import type { TypeConverter } from "./backend/contract.js";
import { type IrBackendKind, verifyIrBackendLegality } from "./backend/legality.js";
import type {
  IrBoxedLowering,
  IrClassLowering,
  IrClosureLowering,
  IrDynamicLowering,
  IrObjectStructLowering,
  IrRefCellLowering,
  IrUnionLowering,
  IrVecLowering,
} from "./backend/handles.js";
import { WasmGcEmitter } from "./backend/wasmgc-emitter.js";
import {
  type AllocSiteId,
  type IrBlock,
  type IrClassShape,
  type IrClosureSignature,
  type IrDomCallbackAuthority,
  type IrFuncRef,
  type IrFunction,
  type IrGlobalRef,
  type IrInstr,
  type IrInstrIntrinsic,
  type IrLabelId,
  type IrObjectShape,
  type IrStringLengthProvider,
  type IrType,
  type IrTypeRef,
  type IrValueId,
  asVal,
  forEachInstrDeep,
  forEachNestedBuffer,
} from "./nodes.js";
// #2134 — the unified IR effect model (formerly the private `SchedFx` table
// here plus `isSideEffecting` in passes/dead-code.ts; moved verbatim), plus
// the slice-2 independent schedule verifier.
import {
  effectsOf,
  effectsArePure,
  effectsConflict,
  isSideEffecting,
  verifyEmissionSchedule,
  type IrEffects,
} from "./effects.js";
import { jsTagOf } from "./js-tag-domain.js"; // #3954 — the TagId → JsTag crossings at the frozen IrDynamicLowering contract
import { IrInvariantError } from "./outcomes.js";
import { irImportFuncRef, irIntrinsicFuncRef, irRuntimeFuncRef } from "./callable-bindings.js";
import { parseIrDateSnapshotGetter } from "./date-runtime.js";
import { stackifyMovableNestedValues } from "./nested-stackification.js";
import { createIrDynamicScratchLocals } from "./lowering-dynamic-scratch.js";
import { IR_STRING_ITERATOR_CHAR_AT_FN, type IrStringConcatMode, type IrStringEncoding } from "./string-runtime.js";
import type { BlockType, FuncTypeDef, Instr, LocalDef, ValType, WasmFunction } from "./types.js";
export type {
  IrBoxedLowering,
  IrClassLowering,
  IrClosureLowering,
  IrDynamicLowering,
  IrObjectStructLowering,
  IrRefCellLowering,
  IrUnionLowering,
  IrVecLowering,
};

export interface IrLowerResolver {
  resolveFunc(ref: IrFuncRef): number;
  /** Exact post-call carrier adaptation for a provider with a legacy ABI. */
  callResultAdapter?(ref: IrFuncRef): "native-string-from-externref" | undefined;
  resolveGlobal(ref: IrGlobalRef): number;
  resolveType(ref: IrTypeRef): number;
  internFuncType(type: FuncTypeDef): number;
  /**
   * Resolve (and memoise) the WasmGC struct type for a `union` IrType. V1
   * scope: homogeneous-width unions only — see
   * `passes/tagged-union-types.ts`. Returns `null` when the union is not
   * representable (heterogeneous, or contains reference members); callers
   * must treat that as `dynamic` upstream.
   *
   * Optional so Phase-1 resolvers without tagged-union support can omit it;
   * a Phase-3 function that actually emits `box`/`unbox`/`tag.test` will
   * fail at lowering time when it's missing, which is the correct behavior
   * (caller should have rejected the IR earlier).
   */
  resolveUnion?(members: readonly ValType[]): IrUnionLowering | null;
  /**
   * Resolve (and memoise) the WasmGC struct type for a `boxed` IrType.
   * Optional for the same reason as `resolveUnion`.
   */
  resolveBoxed?(inner: ValType): IrBoxedLowering | null;
  /**
   * Resolve (and memoise) the WasmGC struct type for an `IrType.object`
   * shape. Returns `null` if the shape contains a field type the backend
   * can't lower (e.g. a nested boxed-IrType the V1 boxed registry doesn't
   * support).
   *
   * The slice-2 implementation in `integration.ts` delegates to a shared
   * `ObjectStructRegistry` that hashes shapes against
   * `ctx.anonStructHash`, so legacy `ensureStructForType` and the IR path
   * converge on a single WasmGC struct for any given shape.
   */
  resolveObject?(shape: IrObjectShape, alloc?: AllocSiteId): IrObjectStructLowering | null;
  /**
   * Slice 3 / #3214 B0: resolve the per-signature allocation wrapper and its
   * exact lifted funcref type. The wrapper is used by `closure.new` (and as the
   * parent of captured environments), but is not the cross-module carrier or
   * lifted `self` type; those use `resolveClosureRoot`. Returns `null` if the
   * signature contains an IrType the backend can't lower.
   */
  resolveClosure?(signature: IrClosureSignature): IrClosureLowering | null;
  /**
   * #3214 B0: resolve the canonical root shared by every legacy/IR
   * funcref-wrapper struct. This is the stable closure carrier, field-0 read
   * type, and lifted `self` type. Only allocation and capture recovery use a
   * narrower per-signature wrapper/subtype.
   */
  resolveClosureRoot?(): number | null;
  /**
   * Slice 3 (#1169c): resolve the captured SUBTYPE WasmGC struct for a specific
   * closure-construction site. Different non-empty
   * `(signature, captureFieldTypes)` pairs produce different subtypes of the
   * signature's exact canonical wrapper, so the
   * lifted body's `ref.cast` recovers capture-field positions.
   */
  resolveClosureSubtype?(
    signature: IrClosureSignature,
    captureFieldTypes: readonly IrType[],
    hostOneShot?: boolean,
    domCallbackAuthority?: IrDomCallbackAuthority,
    liftedFuncIdx?: number,
  ): IrClosureLowering | null;
  /**
   * Slice 3 (#1169c): resolve the WasmGC struct type for a ref cell
   * over a primitive ValType. Delegates to the legacy
   * `getOrRegisterRefCellType` so legacy and IR ref cells share one
   * type per inner ValType.
   */
  resolveRefCell?(inner: ValType, alloc?: AllocSiteId): IrRefCellLowering | null;
  /**
   * Slice 4 (#1169d): resolve the WasmGC struct + constructor + method
   * funcs for a class declared in the compilation unit. Returns `null`
   * if `shape.className` was not registered by the legacy class
   * collection pass — that's a selector bug.
   */
  resolveClass?(shape: IrClassShape): IrClassLowering | null;
  /**
   * Slice 6 (#1169e): resolve a vec struct given its top-level Wasm
   * ValType. The IR carries the vec's value as a `ref`/`ref_null` to a
   * registered vec struct; the resolver inspects the struct's fields to
   * verify the layout is `{ length: i32, data: (ref $arr) }` and returns
   * the typeIdx + field indices + element ValType. Returns `null` when
   * the type isn't a recognisable vec — caller treats that as a bug
   * (selector should have rejected the for-of).
   */
  resolveVec?(valType: ValType): IrVecLowering | null;
  /**
   * #1804 — resolve (registering if needed) the vec struct for an *element*
   * ValType, used by `vec.new_fixed` construction where a fresh literal has no
   * vec typeIdx yet. Unlike `resolveVec` (read-only — recognizes an existing
   * `(ref $vec)`), this get-or-creates the `$arr`/`$vec` types for the element
   * via the legacy registry so the constructed vec shares identity with the
   * legacy `compileArrayLiteral` output (===, instanceof Array, the for-of fast
   * path). Returns the same `IrVecLowering` shape as `resolveVec`.
   */
  resolveVecForElement?(elementValType: ValType, alloc?: AllocSiteId): IrVecLowering | null;
  /**
   * Resolve the Wasm value type used for `IrType.string` in the active
   * backend.
   *   - `wasm:js-string` mode → `{ kind: "externref" }`.
   *   - `nativeStrings` mode  → `{ kind: "ref", typeIdx: ctx.anyStrTypeIdx }`.
   * Optional so Phase-1 resolvers without string support can omit it; a
   * function that actually emits a `string.*` instr will fail at lowering
   * time when it's missing.
   */
  resolveString?(): ValType;
  /**
   * #2949 slice 1 — resolve the Wasm value type used for `IrType.dynamic`
   * (the boxed-any carrier) in the active backend/mode. The contract is the
   * ratified #1852 representation table, and the returned ValType MUST match
   * legacy `resolveWasmType`'s any/unknown arm exactly so IR-claimed and
   * legacy-compiled functions agree on the `any` ABI:
   *   - WasmGC fast/standalone mode → `ref_null $AnyValue` (registered via
   *     `ensureAnyValueType`; the `__any_box_*` helper family's carrier).
   *   - WasmGC host (non-fast) mode → `externref` (host-boxed values).
   *   - Linear backend → DEFERRED (#1852-G4 / #2956): omit the method;
   *     lowering a dynamic-typed function there fails loudly.
   * Optional so Phase-1 resolvers without dynamic support can omit it; a
   * function that actually carries a dynamic-typed value fails at lowering
   * time when it's missing.
   */
  resolveDynamic?(): ValType;
  /**
   * #2949 slice 3 — resolve the op-emission handle for dynamic
   * box/unbox/tag.test lowering (see `IrDynamicLowering` in
   * `backend/handles.ts` for the full contract, incl. the V2 numeric-class
   * tag.test rule). MUST agree with `resolveDynamic()` on the carrier — one
   * mode split, two views of it. Optional like `resolveDynamic`; a function
   * that actually emits a dynamic box/unbox/tag.test fails at lowering time
   * when it's missing. Returns `null` when the active backend/mode has no
   * dynamic op lowering (linear — #1852-G4/#2956).
   *
   * Registration discipline: the integration layer pre-registers every
   * helper/import the handle can emit (`preregisterDynamicSupport`) BEFORE
   * Phase-3 lowering starts, so no `emit*` call can trigger a mid-emission
   * late-import funcIdx shift (the #329/#2078 bug class).
   */
  resolveDynamicLowering?(): IrDynamicLowering | null;
  /**
   * Slice 6 part 4 (#1183) refactored in #1185: returns whether the
   * compiler is in native-strings mode. Drives the for-of strategy
   * switch for `string`-typed iterables in `lowerForOfStatement`.
   * Optional for the same reason as `resolveString` — Phase-1
   * resolvers without string support can omit it.
   */
  nativeStrings?(): boolean;
  /**
   * Emit the Wasm op sequence that materializes a string literal.
   *   - host strings → register a `string_constants.<value>` global import
   *                    and emit `[global.get]`.
   *   - native       → read prepared immutable storage or call an exact
   *                    prepared oversized-literal materializer.
   */
  // #1588: `alloc` lets the resolver read the string.const encoding decision.
  // Optional — resolvers/callers that omit it get the i16 path (byte-identical).
  emitStringConst?(
    value: string,
    alloc?: AllocSiteId,
    storage?: IrGlobalRef,
    materializer?: IrFuncRef,
  ): readonly Instr[];
  /** `[call concat]` (host) or `[call __str_concat]` (native). */
  emitStringConcat?(alloc?: AllocSiteId, mode?: IrStringConcatMode, provider?: IrFuncRef): readonly Instr[];
  /** `[call equals]` (host) or `[call __str_equals]` (native). */
  emitStringEquals?(provider?: IrFuncRef): readonly Instr[];
  /**
   * `[call length]` (host) or `[struct.get $AnyString $len]` (native).
   * Result is i32 — the `string.len` IR instr appends an
   * `f64.convert_i32_s` after this.
   */
  emitStringLen?(inputEncoding?: IrStringEncoding, provider?: IrStringLengthProvider): readonly Instr[];
  /** Typed character operations consume an already-normalized i32 index. */
  emitStringCharAt?(alloc?: AllocSiteId, inputEncoding?: IrStringEncoding, provider?: IrFuncRef): readonly Instr[];
  emitStringCharCodeAt?(inputEncoding?: IrStringEncoding, provider?: IrFuncRef): readonly Instr[];
  /**
   * Slice 9 (#1169h): resolve (and lazily register) the shared `__exn`
   * exception tag. The tag carries an `externref` payload — every
   * thrown value is coerced to externref upstream. Returning the
   * `tagIdx` lets the lowerer emit `throw $exnTagIdx` and `try ...
   * catch $exnTagIdx`. IR-compiled throws are catchable by
   * legacy-compiled handlers (and vice versa) because both paths go
   * through the same single tag.
   */
  ensureExnTag?(): number;
  /**
   * True for no-JavaScript-host targets that use the standardized
   * `try_table` exception proposal. Host `gc` output keeps the legacy
   * `try`/`catch` encoding for compatibility with JavaScript engines.
   */
  standardizedExceptions?(): boolean;
  /**
   * #1373b Phase C scaffolding — resolve (and lazily register) the
   * standalone `$Promise` WasmGC struct type. The struct's layout is
   * `{ state: i32, value: externref, callbacks: externref }` (see
   * `src/codegen/async-scheduler.ts` for the canonical registration).
   *
   * Returns the struct's typeIdx. Used by IR's `async.return`,
   * `async.throw`, and `await` lowering to construct or inspect
   * Promise values without going through the JS-host `Promise.resolve`
   * / `Promise.reject` imports.
   *
   * Optional — Phase-1 resolvers (pre-#1373b) can omit it; lowering
   * falls back to a throw stub when missing.
   */
  resolvePromiseType?(): number;
  /**
   * (#1373b C-1) True iff the compile's awaited values are the Wasm-native
   * `$Promise` carrier (`isStandalonePromiseActive(ctx)` — currently the
   * wasi lane). Decides the `await` lowering:
   *   - `true`  → one-level guarded `$Promise` unwrap (mirrors the legacy
   *     `emitStandaloneAwaitUnwrap` in expressions.ts — keep in lockstep);
   *   - `false`/absent → identity passthrough (JS-host sync model — host
   *     promises are host objects; the #1796 call-site contract owns
   *     wrapping/unwrapping).
   */
  nativePromiseCarrierActive?(): boolean;
}

/**
 * #1373b — Sentinel values for `$Promise.state`. Mirrors the constants
 * exported from `src/codegen/async-scheduler.ts`. Duplicated here as
 * locals to avoid a cross-package import from `ir/` into `codegen/`.
 */
const PROMISE_STATE_FULFILLED = 1;
const PROMISE_STATE_REJECTED = 2;

export interface IrLowerResult {
  readonly func: WasmFunction;
}

/**
 * One named logical value in backend slot form. A backend may represent one
 * IR value with more than one slot; the grouping is retained here so the
 * generic result never has to manufacture a Wasm local index or `ValType`.
 */
export interface IrLoweredValue<Slot> {
  readonly name: string;
  readonly slots: readonly Slot[];
}

/**
 * #1584/#3296: backend-neutral function-lowering result. The sink and value
 * slot types are independent generic parameters. Function type interning and
 * concrete local numbering belong to the backend wrapper/assembler, not this
 * result; consequently there is no mandatory Wasm `typeIdx`, `LocalDef`, or
 * `Instr[]` anywhere in the shape.
 */
export interface IrLoweredBody<S, Slot> {
  readonly name: string;
  readonly body: S;
  readonly params: readonly IrLoweredValue<Slot>[];
  readonly locals: readonly IrLoweredValue<Slot>[];
  readonly results: readonly (readonly Slot[])[];
  readonly exported: boolean;
}

function emitPreparedIntrinsic<S>(
  instr: IrInstrIntrinsic,
  out: S,
  emitter: BackendEmitter<S>,
  resolver: IrLowerResolver,
  emitValue: (value: IrValueId, out: S) => void,
  funcName: string,
): void {
  for (const arg of instr.args) emitValue(arg, out);
  if (!instr.provider) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "lower",
      `ir/lower: semantic intrinsic ${instr.id} has no frozen provider (${funcName})`,
    );
  }
  if (instr.provider.kind === "backend-op") emitter.emitUnary(instr.provider.opcode, out);
  else emitter.emitCall(resolver.resolveFunc(instr.provider.target), out);
}

/**
 * Wasm-shaped type conversion lives at the Wasm adapter edge. Linear-Wasm
 * also uses this converter today because its scalar slots are Wasm ValTypes;
 * non-Wasm consumers pass their own `TypeConverter` to the generic lowerer.
 */
export function wasmValueTypeConverter(
  backend: IrBackendKind,
  resolver: IrLowerResolver,
  funcName: string,
): TypeConverter<ValType> {
  return {
    backend,
    convertType: (type: IrType): readonly ValType[] => [lowerIrTypeToValType(type, resolver, funcName)],
  };
}

function flattenWasmValues(values: readonly IrLoweredValue<ValType>[]): LocalDef[] {
  return values.flatMap((value) =>
    value.slots.map((type, slot) => ({
      name: slot === 0 ? value.name : `${value.name}$${slot}`,
      type,
    })),
  );
}

function flattenSlots<Slot>(values: readonly (readonly Slot[])[]): Slot[] {
  return values.flatMap((slots) => [...slots]);
}

/**
 * #1584 (a0-tail): thin WasmGC wrapper. Every pre-#1584 caller is unchanged —
 * it still returns `IrLowerResult` (`{ func: WasmFunction }`) with `S = Instr[]`
 * lowering, byte-identical to the previous monolithic body. The generic body
 * does all the work; this only assembles the `WasmFunction` shape from the
 * `Instr[]` sink.
 */
export function lowerIrFunctionToWasm(
  func: IrFunction,
  resolver: IrLowerResolver,
  // #1713: the active backend. Defaults to WasmGcEmitter so every existing
  // caller (integration.ts) is unchanged and Phase 1 stays zero-delta.
  // #1714/#1715 pass an explicit emitter selected by compile target.
  emitter: BackendEmitter = new WasmGcEmitter(resolver),
): IrLowerResult {
  const lowered = lowerIrFunctionBody(
    func,
    resolver,
    emitter,
    wasmValueTypeConverter(emitter.backend, resolver, func.name),
  );
  const params = flattenWasmValues(lowered.params).map((param) => param.type);
  const results = flattenSlots(lowered.results);
  return {
    func: {
      name: lowered.name,
      typeIdx: resolver.internFuncType({ kind: "func", params, results }),
      locals: flattenWasmValues(lowered.locals),
      body: lowered.body,
      exported: lowered.exported,
    },
  };
}

/**
 * #1584 (a0-tail): the real lowering, generic over the emitter sink `S`. With
 * `S = Instr[]` (WasmGC, the default) the emitted stream is byte-identical to
 * the pre-#1584 monolith. With `S = BytecodeSink` the SAME drive shape produces
 * a flat opcode stream — the bytecode arm is then produced by the REAL
 * `lower.ts`, not a hand-lowerer (the (a0) acceptance criterion).
 *
 * Op families that structurally embed nested `Instr[]` sub-buffers into a raw
 * WasmGC `Instr` (loop / try / await — see `requireInstrSink` below) are still
 * WasmGC-only: on a non-`Instr[]` sink they throw the not-yet-migrated boundary
 * loudly. Each migrates behind a typed trait primitive in §2a (a1..a6).
 */
export function lowerIrFunctionBody<S, Slot>(
  func: IrFunction,
  resolver: IrLowerResolver,
  // #1713: the active backend emitter and #3296 TypeConverter are separate
  // contract parts. Keeping both explicit prevents a non-Wasm caller from
  // inheriting the old WasmGC metadata default accidentally.
  emitter: BackendEmitter<S>,
  typeConverter: TypeConverter<Slot>,
): IrLoweredBody<S, Slot> {
  if (typeConverter.backend !== emitter.backend) {
    throw new Error(
      `ir/lower: backend contract mismatch for ${func.name}: emitter=${emitter.backend}, type-converter=${typeConverter.backend}`,
    );
  }
  const legalityErrors = verifyIrBackendLegality(func, emitter.backend);
  if (legalityErrors.length > 0) {
    const shown = legalityErrors.slice(0, 3).map((err) => err.message);
    throw new IrInvariantError(
      "backend-legality-failure",
      "backend-legality",
      `ir/lower: ${emitter.backend} backend legality failed for ${func.name}: ${shown.join("; ")}` +
        (legalityErrors.length > shown.length ? ` (+${legalityErrors.length - shown.length} more)` : ""),
    );
  }

  // #1584 (a0-tail): guard for op families that build nested `Instr[]`
  // sub-buffers and EMBED them into a raw WasmGC `Instr` (`{op:"loop", body:
  // loopBody}`, `{op:"try", body: tryBody}`, the `await` `if` arms). That
  // structural embed is WasmGC-specific and cannot flow through a non-`Instr[]`
  // sink. `Array.isArray(out)` is true exactly when `S = Instr[]` (WasmGC); a
  // BytecodeSink is an object → throws (the not-yet-migrated boundary, surfaced
  // loudly). Inside such an arm, `const wasmOut = requireInstrSink(out)` asserts
  // `S = Instr[]` and all the arm's nested-buffer work + terminal embed use
  // `wasmOut`. See plan/issues/1584 §2a.
  const requireInstrSink = (out: S): Instr[] => {
    if (!Array.isArray(out)) {
      throw new Error(
        `ir/lower: '${func.name}' uses an op family (loop/try/await) not yet migrated behind the trait — out of the bytecode subset. See plan/issues/1584 §2a.`,
      );
    }
    return out;
  };
  if (func.blocks.length === 0) {
    throw new Error(`ir/lower: function ${func.name} has no blocks`);
  }
  if (func.blocks[0].blockArgs.length !== 0) {
    throw new Error(`ir/lower: Phase 1 entry block must not declare block args (${func.name})`);
  }

  // --- index maps ---------------------------------------------------------

  const paramIdx = new Map<IrValueId, number>();
  func.params.forEach((p, idx) => paramIdx.set(p.value, idx));

  const defBy = new Map<IrValueId, IrInstr>();
  const defBlockOf = new Map<IrValueId, number>();
  const paramTypeOf = new Map<IrValueId, IrType>();
  for (const p of func.params) paramTypeOf.set(p.value, p.type);
  // Slice 6 (#1169e): also walk inside `forof.vec` body buffers so SSA
  // definitions made in a loop body register in the def maps. The body
  // is treated as a continuation of its containing block for SSA-scope
  // purposes (a value defined inside the body is reachable only from
  // there, but multi-use of an OUTER value across the boundary is what
  // we care about for cross-block local materialisation).
  const registerInstrDefs = (instr: IrInstr, blockId: number): void => {
    if (instr.result !== null) {
      if (defBy.has(instr.result)) {
        throw new Error(`ir/lower: duplicate SSA def for ${instr.result} in ${func.name}`);
      }
      defBy.set(instr.result, instr);
      defBlockOf.set(instr.result, blockId);
    }
    // Descend into every nested buffer (if arms, loop cond/body/update, for-of
    // bodies, try/catch/finally) so SSA defs inside register in the def maps.
    // (#1922) The buffer list is now the single authority in nodes.ts.
    forEachNestedBuffer(instr, (buffer) => {
      for (const sub of buffer) registerInstrDefs(sub, blockId);
    });
  };
  for (const block of func.blocks) {
    for (const instr of block.instrs) {
      registerInstrDefs(instr, block.id as number);
    }
  }

  /**
   * IrType of an SSA value — looks up params first, then the defining instr's
   * resultType. Used by `box` / `unbox` / `tag.test` lowering to find the
   * union / boxed struct type for the operand.
   */
  const typeOf = (v: IrValueId): IrType => {
    const paramT = paramTypeOf.get(v);
    if (paramT) return paramT;
    const d = defBy.get(v);
    if (!d || !d.resultType) {
      throw new Error(`ir/lower: value ${v} has no known IrType in ${func.name}`);
    }
    return d.resultType;
  };

  // --- use counting -------------------------------------------------------
  //
  // For each SSA value, count how many times it is referenced from each
  // block (instructions + terminator). A value is:
  //   - "cross-block" if any block other than its def block references it.
  //   - "multi-use"   if its total reference count exceeds 1.
  // Both classes need a dedicated Wasm local. Cross-block values are
  // materialized eagerly at def time (local.set); intra-block-only
  // multi-use values are materialized lazily at first use (local.tee).

  const usesPerBlock = new Map<IrValueId, Map<number, number>>();
  const totalUses = new Map<IrValueId, number>();
  const recordUse = (v: IrValueId, blockId: number): void => {
    totalUses.set(v, (totalUses.get(v) ?? 0) + 1);
    let m = usesPerBlock.get(v);
    if (!m) {
      m = new Map();
      usesPerBlock.set(v, m);
    }
    m.set(blockId, (m.get(blockId) ?? 0) + 1);
  };
  for (const block of func.blocks) {
    const blockId = block.id as number;
    for (const instr of block.instrs) {
      for (const u of collectIrUses(instr)) recordUse(u, blockId);
      // Slice 6 (#1169e): record uses inside `forof.vec` body buffers as
      // belonging to the SAME block as the for-of itself. A use inside
      // the body is "in" the surrounding block from the perspective of
      // structured Wasm emission — except that the loop's repeated
      // execution makes ANY outer-defined value's use a candidate for
      // cross-block materialisation. Mark uses with a synthetic block
      // ID (-1 for "inside-body") so the cross-block test always fires.
      if (instr.kind === "forof.vec" || instr.kind === "forof.iter" || instr.kind === "forof.string") {
        for (const u of collectForOfBodyUses(instr.body)) recordUse(u, -1);
      }
      // Slice 9 (#1169h): try / catch / finally bodies. Uses inside
      // these buffers are recorded against the surrounding block, but
      // we mark them with the synthetic -1 block id (same convention
      // forof bodies use) so cross-boundary outer-defined values get
      // their cross-block flag and are pre-materialised in Wasm
      // locals before the try op runs.
      if (instr.kind === "try") {
        for (const u of collectForOfBodyUses(instr.body)) recordUse(u, -1);
        if (instr.catchClause) {
          for (const u of collectForOfBodyUses(instr.catchClause.body)) recordUse(u, -1);
        }
        if (instr.finallyBody) {
          for (const u of collectForOfBodyUses(instr.finallyBody)) recordUse(u, -1);
        }
      }
      // Slice 12 (#1280): while / for loop cond + body + update buffers.
      // Same -1 block id convention as forof bodies — uses inside the
      // loop are treated as cross-block w.r.t. outer-defined values.
      if (instr.kind === "while.loop") {
        for (const u of collectForOfBodyUses(instr.cond)) recordUse(u, -1);
        for (const u of collectForOfBodyUses(instr.body)) recordUse(u, -1);
        // The cond's SSA result is consumed by the synthesized
        // i32.eqz / br_if at the loop top. Record the use so the
        // value is allocated a Wasm local if the cond isn't
        // re-emitted in place (multi-use across iterations).
        recordUse(instr.condValue, -1);
      }
      if (instr.kind === "for.loop") {
        for (const u of collectForOfBodyUses(instr.cond)) recordUse(u, -1);
        for (const u of collectForOfBodyUses(instr.body)) recordUse(u, -1);
        for (const u of collectForOfBodyUses(instr.update)) recordUse(u, -1);
        recordUse(instr.condValue, -1);
      }
      // (#1392) `if` arms — same `-1` block id convention as for-of
      // bodies. Outer SSA values referenced inside an arm need to be
      // pre-materialised into Wasm locals so the arm's inline code can
      // `local.get` them (since the arm's structured Wasm if-block runs
      // INSIDE the surrounding block but reads from outer locals).
      // The thenValue / elseValue are the carrier values left on the
      // stack at end-of-arm — recording them ensures their defs survive
      // DCE and that they're accessible at the carrier-emission site.
      if (instr.kind === "if") {
        for (const u of collectForOfBodyUses(instr.then)) recordUse(u, -1);
        for (const u of collectForOfBodyUses(instr.else)) recordUse(u, -1);
        recordUse(instr.thenValue, -1);
        recordUse(instr.elseValue, -1);
      }
      // #2952 slice 2 — statement-level if arms: same -1 convention (an
      // outer value used inside an arm pre-materialises into a Wasm local).
      if (instr.kind === "if.stmt") {
        for (const u of collectForOfBodyUses(instr.then)) recordUse(u, -1);
        for (const u of collectForOfBodyUses(instr.else)) recordUse(u, -1);
      }
      // #2952 slice 4 — labeled block / switch clause buffers: same -1
      // convention as if.stmt arms.
      if (instr.kind === "labeled.block") {
        for (const u of collectForOfBodyUses(instr.body)) recordUse(u, -1);
      }
      if (instr.kind === "switch") {
        for (const body of instr.bodies) {
          for (const u of collectForOfBodyUses(body)) recordUse(u, -1);
        }
      }
    }
    for (const u of collectTerminatorUses(block)) recordUse(u, blockId);
  }

  const crossBlock = new Set<IrValueId>();
  const needsLocal = new Set<IrValueId>();
  for (const [v, m] of usesPerBlock) {
    if (paramIdx.has(v)) continue;
    const total = totalUses.get(v) ?? 0;
    if (total > 1) needsLocal.add(v);
    const defBlk = defBlockOf.get(v);
    if (defBlk === undefined) continue; // should not happen after duplicate-def check
    for (const b of m.keys()) {
      if (b !== defBlk) {
        crossBlock.add(v);
        needsLocal.add(v);
        break;
      }
    }
  }

  // Nested instruction buffers are structured regions, not basic-block
  // boundaries for values that are both defined and consumed exactly once
  // inside the same region. The historical synthetic `-1` accounting above
  // deliberately materializes outer values before entering a loop/arm, but it
  // also conservatively caught every buffer-internal temporary. A pure,
  // single-use internal expression can stay as an ordinary Wasm stack tree:
  // it cannot be observed across iterations/arms and moving a pure node to its
  // sole consumer cannot reorder effects. Recover only that narrow subset;
  // multi-use, effectful, cross-region, and carrier values retain their local.
  const lexicalDefRegion = new Map<IrValueId, number>();
  const lexicalUseRegions = new Map<IrValueId, Set<number>>();
  const lexicalUseCounts = new Map<IrValueId, number>();
  const lexicalDefPoints = new Map<IrValueId, { readonly region: number; readonly index: number }>();
  const lexicalUsePoints = new Map<
    IrValueId,
    Array<{ readonly region: number; readonly index: number; readonly consumer?: IrInstr }>
  >();
  const lexicalInstrsByRegion = new Map<number, readonly IrInstr[]>();
  let nextNestedRegion = -1;
  const recordLexicalUse = (value: IrValueId, region: number, index: number, consumer?: IrInstr): void => {
    lexicalUseCounts.set(value, (lexicalUseCounts.get(value) ?? 0) + 1);
    const regions = lexicalUseRegions.get(value) ?? new Set<number>();
    regions.add(region);
    lexicalUseRegions.set(value, regions);
    const points = lexicalUsePoints.get(value) ?? [];
    points.push({ region, index, ...(consumer ? { consumer } : {}) });
    lexicalUsePoints.set(value, points);
  };
  const visitLexicalBuffer = (instrs: readonly IrInstr[], region: number): void => {
    lexicalInstrsByRegion.set(region, instrs);
    for (let index = 0; index < instrs.length; index++) {
      const instr = instrs[index]!;
      if (instr.result !== null) {
        lexicalDefRegion.set(instr.result, region);
        lexicalDefPoints.set(instr.result, { region, index });
      }
      for (const value of collectIrUses(instr)) recordLexicalUse(value, region, index, instr);
      const childRegions: number[] = [];
      forEachNestedBuffer(instr, (buffer) => {
        const childRegion = nextNestedRegion--;
        childRegions.push(childRegion);
        visitLexicalBuffer(buffer, childRegion);
      });
      if (instr.kind === "if") {
        const thenRegion = childRegions[0];
        const elseRegion = childRegions[1];
        if (thenRegion !== undefined) recordLexicalUse(instr.thenValue, thenRegion, instr.then.length);
        if (elseRegion !== undefined) recordLexicalUse(instr.elseValue, elseRegion, instr.else.length);
      }
    }
  };
  for (const block of func.blocks) {
    const region = block.id as number;
    visitLexicalBuffer(block.instrs, region);
    for (const value of collectTerminatorUses(block)) recordLexicalUse(value, region, block.instrs.length);
  }
  const nestedPureEffects = new Map<IrInstr, IrEffects>();
  for (const value of [...crossBlock]) {
    const defRegion = lexicalDefRegion.get(value);
    const useRegions = lexicalUseRegions.get(value);
    const def = defBy.get(value);
    if (
      defRegion === undefined ||
      defRegion >= 0 ||
      !def ||
      !useRegions ||
      useRegions.size !== 1 ||
      !useRegions.has(defRegion) ||
      lexicalUseCounts.get(value) !== 1 ||
      !effectsArePure(effectsOf(def, nestedPureEffects))
    ) {
      continue;
    }
    crossBlock.delete(value);
    needsLocal.delete(value);
  }
  // Numeric/null constants are cheaper and safer to rematerialize at each use
  // than to reserve a function local and emit local.tee/local.get traffic.
  // Unlike computed pure values, this remains a win across loop boundaries:
  // the Wasm const itself is the complete value and has no producer subtree to
  // repeat. This mirrors the direct backend's literal emission strategy.
  for (const value of [...needsLocal]) {
    if (defBy.get(value)?.kind !== "const") continue;
    needsLocal.delete(value);
    crossBlock.delete(value);
  }
  // --- #1982: effects-aware emission scheduling ---------------------------
  //
  // Lazy use-site emission re-emits a value's defining tree at its consumer,
  // which silently moves order-sensitive READS (slot.read, class.get, …) and
  // EFFECTS (calls) past instructions that execute in between. Repro:
  // `const t = b.v + 0; b.v = b.v * 10; return t + b.v` — the `b.v` read
  // inside `t` was emitted after both `class.set`s.
  //
  // Resolve, bottom-up per block, where each instr's tree will actually be
  // EMITTED ("emission point"): in-place instrs (void result, crossBlock,
  // eager side-effect drop) emit at their own index; lazy values at their
  // first consumer's emission point (multi-use tees at first use, later uses
  // are local.gets and re-execute nothing); dead pure values never. A
  // non-pure lazy candidate is then ANCHORED at its def position (emit +
  // local.set, exactly like the crossBlock path) when some instr between its
  // def and its emission point executes before the candidate's tree AND
  // conflicts with it (read-vs-write / write-vs-anything / same slot).
  //
  // Two values collapsing into the SAME emission point execute in tree
  // order. That matches def order only when one transitively consumes the
  // other (operands emit before their consumer, and SSA guarantees the
  // operand's def comes first). Unrelated siblings are conservatively
  // conflict-checked: consumer operand order need not match def order
  // (`select` emits its condition last; values defined by earlier
  // statements are referenced in arbitrary operand positions).
  //
  // Buffer-internal values (loop bodies, if arms, try) are exempt: their
  // uses are recorded against the synthetic -1 block, so any used value is
  // already crossBlock-materialized at its def position. The IR itself is in
  // program order — this is purely an emission-scheduling fix.
  const anchorEager = new Set<IrValueId>();
  {
    const fxCache = new Map<IrInstr, IrEffects>();
    const NEVER = Number.POSITIVE_INFINITY;
    for (const block of func.blocks) {
      const instrs = block.instrs;
      const n = instrs.length;
      if (n === 0) continue;

      // Block-level consumers of each SSA value (terminator = index n).
      // Buffer-internal uses are intentionally absent (crossBlock covers them).
      const consumersOf = new Map<IrValueId, number[]>();
      const addConsumer = (v: IrValueId, i: number): void => {
        const list = consumersOf.get(v);
        if (list) list.push(i);
        else consumersOf.set(v, [i]);
      };
      instrs.forEach((instr, i) => {
        for (const u of collectIrUses(instr)) addConsumer(u, i);
      });
      for (const u of collectTerminatorUses(block)) addConsumer(u, n);

      const defIdxOf = new Map<IrValueId, number>();
      instrs.forEach((instr, i) => {
        if (instr.result !== null) defIdxOf.set(instr.result, i);
      });

      const emissionIdx: number[] = new Array(n).fill(NEVER);
      const isLazyAt: boolean[] = new Array(n).fill(false);

      // Does `instrs[k]`'s lazily-emitted tree transitively consume `target`?
      // Walks only same-block lazy defs — anchored / in-place operands are
      // local.gets at the use site and execute nothing. Defs at indices below
      // `target`'s def cannot reach it (SSA def-before-use), so the default
      // false for not-yet-processed entries only prunes irrelevant paths.
      const treeConsumes = (k: number, target: IrValueId): boolean => {
        const seen = new Set<number>();
        const stack = [k];
        while (stack.length > 0) {
          const cur = stack.pop()!;
          if (seen.has(cur)) continue;
          seen.add(cur);
          for (const u of collectIrUses(instrs[cur])) {
            if (u === target) return true;
            const d = defIdxOf.get(u);
            if (d !== undefined && isLazyAt[d]) stack.push(d);
          }
        }
        return false;
      };

      for (let i = n - 1; i >= 0; i--) {
        const instr = instrs[i];
        const r = instr.result;
        const uses = r === null ? 0 : (totalUses.get(r) ?? 0);
        if (r === null || crossBlock.has(r) || (uses === 0 && isSideEffecting(instr))) {
          emissionIdx[i] = i; // emitted in place by emitBlockBody
          continue;
        }
        if (uses === 0) continue; // dead pure value — never emitted
        const consumers = consumersOf.get(r);
        if (!consumers || consumers.length === 0) continue; // defensive: buffer-only uses are crossBlock
        let e = NEVER;
        for (const c of consumers) e = Math.min(e, c === n ? n : emissionIdx[c]);
        if (e === NEVER) continue; // consumed only by dead chains — never emitted
        const fx = effectsOf(instr, fxCache);
        let anchored = false;
        if (!effectsArePure(fx)) {
          for (let k = i + 1; k < e && k < n; k++) {
            const ek = emissionIdx[k];
            if (ek === NEVER || ek > e) continue; // executes after our tree (or never) — def order preserved
            if (ek === e && treeConsumes(k, r)) continue; // same tree, operands emit before consumers
            if (effectsConflict(fx, effectsOf(instrs[k], fxCache))) {
              anchored = true;
              break;
            }
          }
        }
        if (anchored) {
          anchorEager.add(r);
          needsLocal.add(r);
          emissionIdx[i] = i;
        } else {
          emissionIdx[i] = e;
          isLazyAt[i] = true;
        }
      }

      // #2134 slice 2 — independent post-hoc verification of the computed
      // schedule: pairwise over emitted effectful instrs, program order must
      // be preserved for conflicting effects (an algorithmically separate
      // re-derivation, so an anchor-pass bug cannot hide itself). The throw
      // is caught by the integration loop and typed as a verifier Invariant.
      // Invariants are hard failures in hybrid and IR-only policy alike, so
      // this tripwire can never miscompile silently or demote by environment.
      const scheduleViolations = verifyEmissionSchedule(instrs, emissionIdx, isLazyAt, collectIrUses, fxCache);
      if (scheduleViolations.length > 0) {
        throw new IrInvariantError(
          "verifier-failure",
          "verify",
          `emission-schedule verify: ${scheduleViolations[0]!.reason}` +
            (scheduleViolations.length > 1 ? ` (+${scheduleViolations.length - 1} more)` : "") +
            ` in ${func.name} [#2134]`,
        );
      }
    }
  }

  // Effect-aware nested stackification is isolated so this backend driver
  // only supplies the lexical schedule it already computed above.
  stackifyMovableNestedValues({
    crossBlock,
    needsLocal,
    anchorEager,
    totalUses,
    definitions: defBy,
    definitionPoints: lexicalDefPoints,
    usePoints: lexicalUsePoints,
    instructionsByRegion: lexicalInstrsByRegion,
  });
  // --- local allocation ---------------------------------------------------
  // Stable order: scan blocks then instrs. Every `needsLocal` value gets one
  // internal emission slot, placed after the function's parameter slots.
  // Keep both its current Wasm-facing ValType and its logical IrType: the
  // former still drives the existing index-based emitters, while the latter
  // is what TypeConverter must see when assembling backend-neutral metadata.
  // Reconstructing an IrType from a ValType would erase facts such as unsigned
  // i32/i64, making a materialized Porffor local disagree with the same value
  // when carried as a parameter or result.
  type InternalLocalDef = LocalDef & { readonly logicalType: IrType };
  const locals: InternalLocalDef[] = [];
  const localIdx = new Map<IrValueId, number>();
  // Slice 6 (#1169e): walk into `forof.vec` body buffers so SSA values
  // defined inside a body get Wasm locals allocated alongside the
  // outer-block SSA values. The body's def order is preserved (locals
  // appear in the order their defining instr is encountered).
  const allocLocalForInstr = (instr: IrInstr): void => {
    if (instr.result !== null && needsLocal.has(instr.result)) {
      if (!instr.resultType) {
        throw new Error(`ir/lower: local-bound SSA value ${instr.result} has no resultType in ${func.name}`);
      }
      const idx = func.params.length + locals.length;
      locals.push({
        name: `$ir${instr.result}`,
        type: lowerIrTypeToValType(instr.resultType, resolver, func.name),
        logicalType: instr.resultType,
      });
      localIdx.set(instr.result, idx);
    }
    if (instr.kind === "forof.vec" || instr.kind === "forof.iter" || instr.kind === "forof.string") {
      for (const sub of instr.body) allocLocalForInstr(sub);
    }
    // Slice 9 (#1169h): walk into try / catch / finally buffers.
    if (instr.kind === "try") {
      for (const sub of instr.body) allocLocalForInstr(sub);
      if (instr.catchClause) {
        for (const sub of instr.catchClause.body) allocLocalForInstr(sub);
      }
      if (instr.finallyBody) {
        for (const sub of instr.finallyBody) allocLocalForInstr(sub);
      }
    }
    // Slice 12 (#1280): walk into while / for loop buffers.
    if (instr.kind === "while.loop") {
      for (const sub of instr.cond) allocLocalForInstr(sub);
      for (const sub of instr.body) allocLocalForInstr(sub);
    }
    if (instr.kind === "for.loop") {
      for (const sub of instr.cond) allocLocalForInstr(sub);
      for (const sub of instr.body) allocLocalForInstr(sub);
      for (const sub of instr.update) allocLocalForInstr(sub);
    }
    // #1820: walk into value-producing `if` then/else arm buffers. SSA values
    // defined inside an arm that are referenced cross-block (e.g. the arm's
    // carrier value, or a nested-ternary sub-result) need a Wasm local slot;
    // without this recursion `localIdx.get(...)` is undefined and the carrier
    // emission mis-targets an unrelated local. (Same recursion the for-of /
    // try / loop buffers already get.)
    if (instr.kind === "if") {
      for (const sub of instr.then) allocLocalForInstr(sub);
      for (const sub of instr.else) allocLocalForInstr(sub);
    }
    // #2952 slice 2 — statement-level if arms (same recursion as `if`).
    if (instr.kind === "if.stmt") {
      for (const sub of instr.then) allocLocalForInstr(sub);
      for (const sub of instr.else) allocLocalForInstr(sub);
    }
    // #2952 slice 4 — labeled block / switch clause buffers.
    if (instr.kind === "labeled.block") {
      for (const sub of instr.body) allocLocalForInstr(sub);
    }
    if (instr.kind === "switch") {
      for (const body of instr.bodies) {
        for (const sub of body) allocLocalForInstr(sub);
      }
    }
  };
  for (const block of func.blocks) {
    for (const instr of block.instrs) {
      allocLocalForInstr(instr);
    }
  }

  // Slice 6 (#1169e): append slot locals AFTER all SSA-driven locals.
  // `slotWasmIdx(slotIndex)` returns the absolute Wasm local index for
  // a given slot.
  const slotBase = func.params.length + locals.length;
  const slotDefs = func.slots ?? [];
  for (const slot of slotDefs) {
    locals.push({ name: `$slot_${slot.name}`, type: slot.type, logicalType: { kind: "val", val: slot.type } });
  }
  const slotWasmIdx = (slotIndex: number): number => slotBase + slotIndex;

  // Slice 11 (#1169n) — JS bitwise ops need TWO scratch f64 locals:
  //   - $js_bitwise_rhs: stash the right operand while we apply
  //     ToInt32 to the left.
  //   - $js_bitwise_tmp: scratch slot used INSIDE `emitJsToInt32` to
  //     duplicate the truncated value for modulo reduction.
  // Both are allocated lazily; one pair per function, reused across
  // every bitwise op in the body.
  //
  // #1126 Stage 3 — when one operand of a bitwise op is already
  // i32-typed in the IR, we need a SECOND rhs slot of i32 type for
  // those calls. This keeps the f64-rhs slot reusable for legacy paths
  // and avoids type-mismatched local stores. Both slots are allocated
  // lazily on first use of their type.
  let jsBitwiseRhsIdxF64: number | null = null;
  let jsBitwiseRhsIdxI32: number | null = null;
  let jsBitwiseTmpIdx: number | null = null;
  let dateSnapshotScratch: { timestamp: number; packed: number; year: number } | null = null;
  const ensureDateSnapshotScratch = (): { timestamp: number; packed: number; year: number } => {
    if (dateSnapshotScratch === null) {
      const alloc = (name: string): number => {
        const idx = func.params.length + locals.length;
        const type: ValType = { kind: "i64" };
        locals.push({ name, type, logicalType: { kind: "val", val: type } });
        return idx;
      };
      dateSnapshotScratch = {
        timestamp: alloc("$date_snapshot_timestamp"),
        packed: alloc("$date_snapshot_packed"),
        year: alloc("$date_snapshot_year"),
      };
    }
    return dateSnapshotScratch;
  };
  // #1373b C-1 — scratch externref local for the native-carrier `await`
  // unwrap (holds the operand across the ref.test/if discrimination, exactly
  // like `emitStandaloneAwaitUnwrap`'s temp local). Allocated lazily on the
  // first await in the function; reused across subsequent awaits.
  let awaitScratchPromiseIdx: number | null = null;
  // #1804 — scratch locals for `vec.new_fixed`: one per (array typeIdx) to stash
  // the `array.new_fixed` data ref while the length is pushed below it for the
  // (length, data) struct.new field order. Keyed by arrayTypeIdx so distinct
  // element types get distinctly-typed data locals; reused across literals.
  const vecNewFixedDataScratch = new Map<number, number>();
  const ensureVecDataScratch = (arrayTypeIdx: number): number => {
    const existing = vecNewFixedDataScratch.get(arrayTypeIdx);
    if (existing !== undefined) return existing;
    const idx = func.params.length + locals.length;
    const type: ValType = { kind: "ref_null", typeIdx: arrayTypeIdx };
    locals.push({ name: `$vec_data_${arrayTypeIdx}`, type, logicalType: { kind: "val", val: type } });
    vecNewFixedDataScratch.set(arrayTypeIdx, idx);
    return idx;
  };
  const vecElementScratch = new Map<string, number>();
  const ensureVecElementScratch = (type: ValType): number => {
    const key = `${type.kind}:${"typeIdx" in type ? type.typeIdx : ""}`;
    const existing = vecElementScratch.get(key);
    if (existing !== undefined) return existing;
    const idx = func.params.length + locals.length;
    locals.push({ name: `$vec_element_${key}`, type, logicalType: { kind: "val", val: type } });
    vecElementScratch.set(key, idx);
    return idx;
  };
  // #3733 — tmp-only accessor, split out of `ensureJsBitwiseScratch` so the
  // `x | 0` / `x ^ 0` zero-operand fast path below (which needs only the
  // ToInt32 scratch, not an rhs-holding slot) doesn't allocate an unused
  // rhs local on every call.
  const ensureJsBitwiseTmp = (): number => {
    if (jsBitwiseTmpIdx === null) {
      jsBitwiseTmpIdx = func.params.length + locals.length;
      const type: ValType = { kind: "f64" };
      locals.push({ name: "$js_bitwise_tmp", type, logicalType: { kind: "val", val: type } });
    }
    return jsBitwiseTmpIdx;
  };
  // (#3739) Lazily-allocated i64 scratch pool for `emitJsToInt32`'s fast
  // bit-manipulation path (WasmGC/linear only — see that function). Kept
  // separate from `jsBitwiseTmpIdx` (f64) since the fast path doesn't use it.
  let jsBitwiseI64Scratch: { bits: number; e: number; significand: number; magnitude: number } | null = null;
  const ensureJsBitwiseI64Scratch = (): { bits: number; e: number; significand: number; magnitude: number } => {
    if (jsBitwiseI64Scratch === null) {
      const alloc = (name: string): number => {
        const idx = func.params.length + locals.length;
        const type: ValType = { kind: "i64" };
        locals.push({ name, type, logicalType: { kind: "val", val: type } });
        return idx;
      };
      jsBitwiseI64Scratch = {
        bits: alloc("$js_bitwise_i64_bits"),
        e: alloc("$js_bitwise_i64_e"),
        significand: alloc("$js_bitwise_i64_significand"),
        magnitude: alloc("$js_bitwise_i64_magnitude"),
      };
    }
    return jsBitwiseI64Scratch;
  };
  const ensureJsBitwiseScratch = (rhsIsI32: boolean): { rhs: number; tmp: number } => {
    const tmp = ensureJsBitwiseTmp();
    if (rhsIsI32) {
      if (jsBitwiseRhsIdxI32 === null) {
        jsBitwiseRhsIdxI32 = func.params.length + locals.length;
        const type: ValType = { kind: "i32" };
        locals.push({ name: "$js_bitwise_rhs_i32", type, logicalType: { kind: "val", val: type } });
      }
      return { rhs: jsBitwiseRhsIdxI32, tmp };
    }
    if (jsBitwiseRhsIdxF64 === null) {
      jsBitwiseRhsIdxF64 = func.params.length + locals.length;
      const type: ValType = { kind: "f64" };
      locals.push({ name: "$js_bitwise_rhs", type, logicalType: { kind: "val", val: type } });
    }
    return { rhs: jsBitwiseRhsIdxF64, tmp };
  };
  const dynamicScratch = createIrDynamicScratchLocals(func.params.length, locals);

  // #1126 Stage 3 — best-effort `typeOf` that returns null instead of
  // throwing. Used by the fast-path operand inspection in `case "binary"`
  // to peek at IrTypes without breaking emit if some defensive contract
  // (no resultType, etc.) isn't met. The slow path still emits correct
  // code in that case.
  const tryTypeOf = (v: IrValueId): IrType | null => {
    try {
      return typeOf(v);
    } catch {
      return null;
    }
  };

  const resolveVecType = (type: IrType, alloc?: AllocSiteId): IrVecLowering | null => {
    if (type.kind === "vec") {
      const elementValType = lowerIrTypeToValType(type.elementType, resolver, func.name);
      if (type.layout) {
        return {
          valueType: {
            kind: type.nullable ? "ref_null" : "ref",
            typeIdx: resolver.resolveType(type.layout.carrierType),
          },
          vecStructTypeIdx: resolver.resolveType(type.layout.carrierType),
          lengthFieldIdx: type.layout.lengthFieldIndex,
          dataFieldIdx: type.layout.dataFieldIndex,
          arrayTypeIdx: resolver.resolveType(type.layout.dataType),
          elementValType,
        };
      }
      // Transitional IR fixtures may predate final Program-ABI preparation.
      // Production prepared components fail closed on the missing layout.
      return resolver.resolveVecForElement?.(elementValType, alloc) ?? null;
    }
    const valType = asVal(type);
    return valType ? (resolver.resolveVec?.(valType) ?? null) : null;
  };

  // #3733 — best-effort constant-value peek, same defensive shape as
  // `tryTypeOf`. Used by the `js.bitor`/`js.bitxor` zero-operand fast path
  // below to recognise the `x | 0` / `x ^ 0` ToInt32-coercion idiom without
  // requiring the operand to already be i32-typed in IR (an untyped `number`
  // literal like the `0` in `s = (s + i) | 0` lowers as f64, so the existing
  // "both already i32" fast path above doesn't catch it).
  const tryConstOf = (v: IrValueId): number | null => {
    const d = defBy.get(v);
    if (!d || d.kind !== "const") return null;
    const c = d.value;
    return c.kind === "i32" || c.kind === "f64" ? c.value : null;
  };

  // --- emission -----------------------------------------------------------

  const materialized = new Set<IrValueId>();

  // --- #2952 slice 2 — lowering-time label→depth resolver (Design A3) ------
  //
  // `br.label{label, mode}` stores NO depth: the Wasm `br` immediate is
  // derived HERE by counting structured frames between the branch site and
  // the frame that binds `label`. Every structured Wasm frame the emitter
  // opens (block / loop / if / try — each exactly ONE Wasm label) pushes one
  // `CtrlFrame` for the duration of its interior emission and pops on close,
  // so the stack mirrors the physical nesting at every emission point. This
  // is what makes the depth robust under buffer re-nesting: the IR carries
  // only the semantic label, and each emission point re-derives its own
  // relative depth.
  //
  // Frame kinds:
  //   - "break"    — the frame a `br.label{mode:"break"}` for this label
  //                  exits to (the loop's outer `block`).
  //   - "continue" — the frame whose br re-runs the loop's advance/cond
  //                  (the Wasm `loop` for pre-test while / forof.iter, or a
  //                  dedicated body-wrapping `block` for for / do-while /
  //                  counter-advancing for-of — emitted only when the body
  //                  actually contains a continue for this label, keeping
  //                  continue-free loops byte-identical).
  //   - "plain"    — any other frame (if / try / labeled-block later).
  //                  A try frame carries its ACTIVE `finallyBody` while its
  //                  try-body buffer is being emitted: a br.label that
  //                  crosses it inlines the finally immediately before the
  //                  br (the same inlining IrInstrTry lowering already does
  //                  for normal completion). The field is masked (undefined)
  //                  while the finally itself / the catch path is emitted so
  //                  a break inside a finally never re-runs its own finally.
  //
  // #2952 slice 3 — `iterCloseSlot`: set on a `forof.iter` loop's OUTER
  // (break-target) frame. A `br.label` that CROSSES the frame (labeled
  // break/continue targeting an outer loop) must run that iterator's
  // `__iterator_return` before branching — IteratorClose on abrupt exit
  // (§14.7.5.7); the close call that physically follows the loop's block
  // is skipped by a crossing br. A br that TARGETS the frame (unlabeled /
  // labeled break of this very loop) lands AT that close call, so the
  // resolver emits nothing extra on a match — only on a cross.
  type CtrlFrame =
    | { kind: "break"; label: IrLabelId; iterCloseSlot?: number }
    | { kind: "continue"; label: IrLabelId }
    | { kind: "plain"; finallyBody?: readonly IrInstr[] | undefined; iterCloseSlot?: number };
  const ctrlStack: CtrlFrame[] = [];

  /**
   * Emit a nested buffer as a statement sequence with the standard SSA
   * materialisation rules (void instrs emit in place; cross-block results
   * emit + local.set; intra-buffer multi-use values tee at their use site).
   * S-generic twin of the per-arm `emitBodyBuffer` helpers; used by the new
   * if.stmt arm and by the br.label finally-inlining path.
   */
  const emitBufferAsStatements = (bodyInstrs: readonly IrInstr[], target: S): void => {
    for (const bodyInstr of bodyInstrs) {
      if (bodyInstr.result === null) {
        emitInstrTree(bodyInstr, target);
      } else if (crossBlock.has(bodyInstr.result)) {
        emitInstrTree(bodyInstr, target);
        emitter.emitLocalSet(localIdx.get(bodyInstr.result)!, target);
        materialized.add(bodyInstr.result);
      } else if ((totalUses.get(bodyInstr.result) ?? 0) === 0 && isSideEffecting(bodyInstr)) {
        // (#2856) Zero-use side-effecting instr inside a nested buffer —
        // same eager emit + drop contract as `emitBlockBody`. Without this
        // arm, a statement-position call whose unused NON-VOID result never
        // gets consumed (e.g. `map.set(k, v);` in a loop body — Map_set
        // returns the map) was silently SKIPPED, dropping its side effect.
        emitInstrTree(bodyInstr, target);
        emitter.emitDrop(target);
      }
      // Intra-buffer multi-use: handled at use site via the tee pattern.
    }
  };

  /**
   * Resolve a `br.label` at the current emission point: scan the ctrlStack
   * from the innermost frame (depth 0), counting every frame; inline each
   * crossed try-finally (innermost first — JS runs inner finallys before
   * outer ones on an abrupt exit); emit `br <depth>` at the matching frame.
   *
   * A br.label inside an inlined finally resolves against the SAME stack
   * (the code physically sits at the branch site), with the finally's own
   * frame masked — so `try { break } finally { continue }` correctly lets
   * the continue win (its br is emitted before the break's br, which
   * becomes unreachable), matching ECMA-262 completion-value overriding.
   */
  const resolveBrLabel = (label: IrLabelId, mode: "break" | "continue", out: S): void => {
    for (let i = ctrlStack.length - 1, depth = 0; i >= 0; i--, depth++) {
      const frame = ctrlStack[i]!;
      if (frame.kind === mode && frame.label === label) {
        emitter.emitBr(depth, out);
        return;
      }
      if (frame.kind === "plain" && frame.finallyBody) {
        const saved = frame.finallyBody;
        frame.finallyBody = undefined; // mask: a finally never re-runs itself
        emitBufferAsStatements(saved, out);
        frame.finallyBody = saved;
      }
      // #2952 slice 3 — crossing OUT of a forof.iter loop: close its
      // iterator before the br (IteratorClose §14.7.5.7 — the loop's own
      // close call sits past the frame this br skips over). Scan order
      // gives inner-before-outer, matching finally interleaving: a
      // finally INSIDE the for-of body was inlined above (its frame is
      // above this one); one OUTSIDE is inlined after (frame below).
      if (frame.kind !== "continue" && frame.iterCloseSlot !== undefined) {
        emitter.emitLocalGet(frame.iterCloseSlot, out);
        // Frames with iterCloseSlot exist only under backends whose
        // legality admits forof.iter (same raw-call emission iter.return uses).
        // pushraw-ok(#2952): plain call op, mirrors the iter.return arm
        emitter.pushRaw(out, {
          op: "call",
          funcIdx: resolver.resolveFunc(irRuntimeFuncRef("__iterator_return")),
        });
      }
    }
    throw new Error(`ir/lower: br.label(${label as number}, ${mode}) has no enclosing frame in ${func.name}`);
  };

  /**
   * #1303 — Defensive coercion for bitwise op operands.
   *
   * Bitwise ops (`&`, `|`, `^`, `<<`, `>>`, `>>>`) require f64 on the
   * stack — their lowering chain `emitJsToInt32` starts with `f64.trunc`
   * which traps validation if the operand is not f64. The IR generator's
   * `requireF64` guard in `from-ast.ts` is supposed to prevent any
   * non-f64-val IR `binary` instruction from reaching the lowerer, but
   * on lodash `partial.js`'s `mergeData` the lowered operand still
   * arrives as externref. Suspected root cause (filed as #1305):
   * module-level `var WRAP_BIND_FLAG = 1` in JS mode is treated as
   * `any`; the IR generator types the use as f64-val based on the
   * literal initializer, but the lowered `global.get` returns externref.
   *
   * Defense: after `emitValue(v)` for a bitwise operand, check the IR
   * type. If it is NOT f64-val (the contract), emit `__unbox_number`
   * to coerce externref → f64. For correctly-typed values the branch
   * is never taken and codegen is byte-identical.
   *
   * Once #1305 lands the IR contract holds across the board and this
   * helper can be removed.
   */
  const coerceToF64ForBitwise = (v: IrValueId, out: S): void => {
    let t: IrType;
    try {
      t = typeOf(v);
    } catch {
      return; // value type unknown — leave as-is
    }
    if (t.kind === "val" && t.val.kind === "f64") return; // already f64
    // Try to resolve __unbox_number; if absent, leave the value alone
    // (the legacy validator will then surface the type mismatch and we
    // haven't masked any other contract violation).
    try {
      const idx = resolver.resolveFunc(irRuntimeFuncRef("__unbox_number"));
      emitter.pushRaw(out, { op: "call", funcIdx: idx });
    } catch {
      // resolver doesn't know __unbox_number — fall through unchanged
    }
  };

  const emitValue = (v: IrValueId, out: S): void => {
    // #1584 (a0-tail): local.get/tee ARE trait primitives (Phase-1, realized by
    // both WasmGcEmitter — byte-identical {op:"local.*"} — and BytecodeEmitter —
    // OP.LOAD/TEE). Route them through the typed methods, NOT pushRaw, so the
    // bytecode arm works and the WasmGC arm stays byte-identical.
    const pi = paramIdx.get(v);
    if (pi !== undefined) {
      emitter.emitLocalGet(pi, out);
      return;
    }
    if (materialized.has(v)) {
      emitter.emitLocalGet(localIdx.get(v)!, out);
      return;
    }
    const d = defBy.get(v);
    if (!d) throw new Error(`ir/lower: undefined SSA value ${v} in ${func.name}`);
    if (needsLocal.has(v)) {
      // Intra-block multi-use only reaches here (cross-block values are
      // pre-materialized by `emitBlockBody` before the terminator). Use the
      // tee pattern: first use emits the tree and leaves the value on the
      // stack while also storing it; later uses become `local.get`.
      emitInstrTree(d, out);
      emitter.emitLocalTee(localIdx.get(v)!, out);
      materialized.add(v);
      return;
    }
    emitInstrTree(d, out);
  };

  const emitInstrTree = (instr: IrInstr, out: S): void => {
    switch (instr.kind) {
      case "const":
        emitter.emitConst(instr, func.name, out);
        return;
      case "call": {
        const dateGetter =
          instr.target.binding.kind === "intrinsic"
            ? parseIrDateSnapshotGetter(instr.target.binding.symbol)
            : undefined;
        if (dateGetter !== undefined) {
          if (instr.args.length !== 1) {
            throw new Error(`ir/lower: ${dateGetter} snapshot getter expects one timestamp (${func.name})`);
          }
          emitValue(instr.args[0]!, out);
          const wasmOut = requireInstrSink(out);
          const scratch = ensureDateSnapshotScratch();
          const civilIdx = resolver.resolveFunc(instr.target);
          wasmOut.push(
            { op: "i64.trunc_sat_f64_s" },
            { op: "local.set", index: scratch.timestamp },
            { op: "local.get", index: scratch.timestamp },
            { op: "i64.const", value: 0n },
            { op: "i64.ge_s" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "i64" } },
              then: [
                { op: "local.get", index: scratch.timestamp },
                { op: "i64.const", value: 86400000n },
                { op: "i64.div_s" },
              ],
              else: [
                { op: "local.get", index: scratch.timestamp },
                { op: "i64.const", value: 86399999n },
                { op: "i64.sub" },
                { op: "i64.const", value: 86400000n },
                { op: "i64.div_s" },
              ],
            },
            { op: "call", funcIdx: civilIdx },
            { op: "local.tee", index: scratch.packed },
            { op: "i64.const", value: 10000n },
            { op: "i64.div_s" },
            { op: "local.get", index: scratch.packed },
            { op: "i64.const", value: 10000n },
            { op: "i64.rem_s" },
            { op: "i64.const", value: 0n },
            { op: "i64.ne" },
            { op: "local.get", index: scratch.packed },
            { op: "i64.const", value: 0n },
            { op: "i64.lt_s" },
            { op: "i32.and" },
            { op: "i64.extend_i32_s" },
            { op: "i64.sub" },
          );
          if (dateGetter === "getFullYear") {
            wasmOut.push({ op: "f64.convert_i64_s" });
            return;
          }
          wasmOut.push(
            { op: "local.set", index: scratch.year },
            { op: "local.get", index: scratch.packed },
            { op: "local.get", index: scratch.year },
            { op: "i64.const", value: 10000n },
            { op: "i64.mul" },
            { op: "i64.sub" },
            { op: "i64.const", value: 100n },
            { op: dateGetter === "getDate" ? "i64.rem_s" : "i64.div_s" },
          );
          if (dateGetter === "getMonth") {
            wasmOut.push({ op: "i64.const", value: 1n }, { op: "i64.sub" });
          }
          wasmOut.push({ op: "f64.convert_i64_s" });
          return;
        }
        // (a1) call family (#1584 §2a): route through the typed emitCall
        // primitive — byte-identical {op:"call"} on WasmGC, OP.CALL on bytecode.
        for (const a of instr.args) emitValue(a, out);
        emitter.emitCall(resolver.resolveFunc(instr.target), out);
        if (resolver.callResultAdapter?.(instr.target) === "native-string-from-externref") {
          const stringCarrier = resolver.resolveString?.();
          if (!stringCarrier || (stringCarrier.kind !== "ref" && stringCarrier.kind !== "ref_null")) {
            throw new Error(`ir/lower: native string call adapter has no reference carrier (${func.name})`);
          }
          emitter.emitFromExternref({ typeIdx: stringCarrier.typeIdx }, out);
        }
        return;
      }
      case "intrinsic": {
        emitPreparedIntrinsic(instr, out, emitter, resolver, emitValue, func.name);
        return;
      }
      case "global.get":
        emitter.emitGlobalGet(resolver.resolveGlobal(instr.target), out);
        return;
      case "global.set":
        emitValue(instr.value, out);
        emitter.emitGlobalSet(resolver.resolveGlobal(instr.target), out);
        return;
      case "binary": {
        const isJsBitwise =
          instr.op === "js.bitand" ||
          instr.op === "js.bitor" ||
          instr.op === "js.bitxor" ||
          instr.op === "js.shl" ||
          instr.op === "js.shr_s" ||
          instr.op === "js.shr_u";

        // #1126 Stage 3 — peek at operand IrTypes BEFORE emitting them so
        // we can pick the cheapest lowering shape. The four cases:
        //   • both i32           → native i32.* op, skip the scratch dance
        //   • lhs i32 / rhs f64  → ToInt32 only on rhs
        //   • lhs f64 / rhs i32  → ToInt32 only on lhs
        //   • both f64           → existing scratch dance (legacy path)
        // Result type of `js.bit*` is f64 by IR contract; we tail with
        // `f64.convert_i32_*` to honour it. When the IR result type was
        // narrowed to i32 by Stage 3 from-ast (chained bitwise ops), we
        // also skip the convert-back so the chain stays in i32.
        //
        // Any value already typed as i32 in IR has gone through one of:
        //   - a JS bitwise op (which produces a ToInt32-equivalent result),
        //   - a comparison / bool source (0 or 1, trivially in [-2^31,2^31)),
        //   - or a const i32. All inhabit the JS-ToInt32 image already, so
        //   skipping the redundant ToInt32 is semantically a no-op.
        const lhsIrTy = isJsBitwise ? tryTypeOf(instr.lhs) : null;
        const rhsIrTy = isJsBitwise ? tryTypeOf(instr.rhs) : null;
        const lhsIsI32 = lhsIrTy ? asVal(lhsIrTy)?.kind === "i32" : false;
        const rhsIsI32 = rhsIrTy ? asVal(rhsIrTy)?.kind === "i32" : false;
        const resultIsI32 = isJsBitwise && instr.resultType ? asVal(instr.resultType)?.kind === "i32" : false;

        if (isJsBitwise && lhsIsI32 && rhsIsI32) {
          // FAST PATH — both operands already in JS-ToInt32-equivalent i32
          // domain. No ToInt32 needed; emit native i32.* directly.
          emitValue(instr.lhs, out);
          emitValue(instr.rhs, out);
          emitter.emitI32Bitwise(jsBitwiseToI32(instr.op), out);
          if (!resultIsI32) {
            // Convert i32 → f64 to honour the legacy js.bit* result-type
            // contract. `>>>` is unsigned, others signed.
            if (instr.op === "js.shr_u") {
              emitter.emitNumericConversion("f64.convert_i32_u", out);
            } else {
              emitter.emitNumericConversion("f64.convert_i32_s", out);
            }
          }
          return;
        }

        if (isJsBitwise && (instr.op === "js.bitor" || instr.op === "js.bitxor") && tryConstOf(instr.rhs) === 0) {
          // #3733 — `x | 0` / `x ^ 0`: OR/XOR with 0 is the identity on the
          // ToInt32 bit pattern, so the whole rhs sub-expression — including
          // its `emitJsToInt32` float round-trip, since an untyped `number`
          // literal like this `0` lowers as f64, not i32 — is dead work.
          // `x | 0` is the single most common "coerce to int32" idiom in JS
          // (e.g. `s = (s + i) | 0`); the legacy AST-direct codegen in
          // binary-ops.ts already special-cases it, but the IR lowerer
          // never did, so any function compiled through IR paid the full
          // double-ToInt32 cost for it (landing-page `loop.ts` benchmark).
          emitValue(instr.lhs, out);
          if (!lhsIsI32) {
            coerceToF64ForBitwise(instr.lhs, out);
            emitJsToInt32(emitter, out, ensureJsBitwiseTmp(), ensureJsBitwiseI64Scratch);
          }
          if (!resultIsI32) {
            emitter.emitNumericConversion("f64.convert_i32_s", out);
          }
          return;
        }

        emitValue(instr.lhs, out);
        // #1303 — defensive coercion only for JS bitwise ops, where the
        // lowering's first instruction (`f64.trunc` inside `emitJsToInt32`)
        // requires f64 on stack. Other binary ops (`f64.add`, `i32.eq`)
        // are not affected and must NOT be coerced (would break i32
        // boolean ops). See `coerceToF64ForBitwise` doc + #1305.
        // #1126 Stage 3 — skip the coercion when the operand is already
        // i32-typed (we'll skip its emitJsToInt32 step below too).
        if (isJsBitwise && !lhsIsI32) coerceToF64ForBitwise(instr.lhs, out);
        emitValue(instr.rhs, out);
        if (isJsBitwise && !rhsIsI32) coerceToF64ForBitwise(instr.rhs, out);
        // Slice 11 (#1169n) — JS bitwise composite ops. Each pops two
        // f64 from the stack, applies JS ToInt32 to each, runs the i32
        // op, and converts back to f64. We use a per-function scratch
        // f64 local to stash the right operand while we ToInt32 the
        // left (Wasm has no general "swap" op).
        //
        // #1126 Stage 3 — when one operand is already i32-typed, the
        // scratch-rhs slot is widened to an i32 local; ToInt32 is also
        // skipped on that operand. This keeps mixed i32/f64 lowering
        // correct (the f64 side still gets its ToInt32; the i32 side
        // passes through directly).
        if (isJsBitwise) {
          const { rhs: rhsSlot, tmp: tmpSlot } = ensureJsBitwiseScratch(rhsIsI32);
          // Stack: [lhs, rhs]
          emitter.emitLocalSet(rhsSlot, out);
          // Stack: [lhs]; rhsSlot holds rhs.
          if (!lhsIsI32) emitJsToInt32(emitter, out, tmpSlot, ensureJsBitwiseI64Scratch);
          // Stack: [lhs_i32]
          emitter.emitLocalGet(rhsSlot, out);
          // Stack: [lhs_i32, rhs]
          if (!rhsIsI32) emitJsToInt32(emitter, out, tmpSlot, ensureJsBitwiseI64Scratch);
          // Stack: [lhs_i32, rhs_i32]
          emitter.emitI32Bitwise(jsBitwiseToI32(instr.op), out);
          // `>>>` returns a Uint32; everything else is Int32. Convert
          // back to f64 with the matching signedness — UNLESS the IR
          // result type was already narrowed to i32 by Stage 3.
          if (!resultIsI32) {
            if (instr.op === "js.shr_u") {
              emitter.emitNumericConversion("f64.convert_i32_u", out);
            } else {
              emitter.emitNumericConversion("f64.convert_i32_s", out);
            }
          }
          return;
        }
        emitter.emitBinary(instr.op, out);
        return;
      }
      case "unary":
        emitValue(instr.rand, out);
        emitter.emitUnary(instr.op, out);
        return;
      case "select":
        // Wasm `select` pops [val1, val2, cond] and pushes val1 if cond != 0
        // else val2 — so `cond ? whenTrue : whenFalse` pushes whenTrue,
        // whenFalse, cond, then `select`.
        emitValue(instr.whenTrue, out);
        emitValue(instr.whenFalse, out);
        emitValue(instr.condition, out);
        emitter.emitSelect(out);
        return;
      case "if": {
        // (#1392) Value-producing short-circuiting if/else. Lowers to:
        //   <cond>
        //   if (result T)
        //     <then arm instrs (SSA materialisation rules)>
        //     <emit thenValue tree-style — leaves value on stack>
        //   else
        //     <else arm instrs>
        //     <emit elseValue tree-style>
        //   end
        // Each arm's last stack-top becomes the if-block's result; the
        // outer SSA `result` is bound by the caller's `local.set`
        // (handled by `emitBlockBody` since this instr has a result).
        if (instr.resultType === null) {
          throw new Error(`ir/lower: IrInstrIf without resultType (${func.name})`);
        }
        const armResultType = lowerIrTypeToValType(instr.resultType, resolver, func.name);
        const blockType: BlockType = { kind: "val", type: armResultType };

        // Helper: emit a body buffer using the same SSA-materialisation
        // rules as `try` / `forof.*`. Cross-block uses get pre-emitted
        // and `local.set`; void-result instrs emit in place; intra-arm
        // multi-use values emit at their use site via the tee pattern.
        //
        // #1584 (a0-tail): the value-producing `if` IS in the bytecode subset
        // (`emitter.emitIf` realizes it on every backend). So each arm is built
        // into its OWN sink via `emitter.newSink()` (type S) and handed to
        // `emitIf` — exactly how the proof drives it. `target` is therefore S,
        // and the cross-block `local.set` is a trait primitive (emitLocalSet).
        const emitArmBody = (bodyInstrs: readonly IrInstr[], target: S): void => {
          for (const bodyInstr of bodyInstrs) {
            if (bodyInstr.result === null) {
              emitInstrTree(bodyInstr, target);
            } else if (crossBlock.has(bodyInstr.result)) {
              emitInstrTree(bodyInstr, target);
              emitter.emitLocalSet(localIdx.get(bodyInstr.result)!, target);
              materialized.add(bodyInstr.result);
            } else if ((totalUses.get(bodyInstr.result) ?? 0) === 0 && isSideEffecting(bodyInstr)) {
              // (#2856) Zero-use side-effecting instr inside a nested buffer —
              // same eager emit + drop contract as `emitBlockBody` (a
              // statement-position extern/host call whose unused result would
              // otherwise be silently SKIPPED, dropping its side effect).
              emitInstrTree(bodyInstr, target);
              emitter.emitDrop(target);
            }
            // Intra-arm multi-use: handled at use site via tee pattern.
          }
        };

        // 1. Emit cond.
        emitValue(instr.cond, out);

        // 2. THEN arm. (#2952 slice 2 — each arm is one structured Wasm
        // frame; push a plain CtrlFrame so any br.label nested in the arm
        // derives the correct depth. Byte-inert for arms without one.)
        const thenBody: S = emitter.newSink();
        ctrlStack.push({ kind: "plain" });
        emitArmBody(instr.then, thenBody);
        emitValue(instr.thenValue, thenBody);
        ctrlStack.pop();

        // 3. ELSE arm.
        const elseBody: S = emitter.newSink();
        ctrlStack.push({ kind: "plain" });
        emitArmBody(instr.else, elseBody);
        emitValue(instr.elseValue, elseBody);
        ctrlStack.pop();

        // 4. Wrap in `if (result T) ... else ... end`.
        emitter.emitIf(blockType, thenBody, elseBody, out);
        return;
      }
      // (NB: `case "if.stmt"` is handled below with the #2952 slice-2 arm —
      // it pushes plain CtrlFrames so br.label depth-derivation counts the
      // arm's structured frame.)
      // (#2856) Early return from inside a nested buffer — the Wasm `return`
      // op unwinds every enclosing block/loop and returns from the function.
      // The value (when present) was coerced to the function's result type by
      // from-ast (same `coerceReturnValue` the tail path uses).
      case "early.return": {
        if (instr.value !== null) emitValue(instr.value, out);
        emitter.emitReturn(out);
        return;
      }
      case "raw.wasm":
        for (const op of instr.ops) emitter.pushRaw(out, op);
        return;
      case "box": {
        // #2949 slice 3 — box-to-dynamic: erase a concrete value into the
        // module's canonical boxed-any carrier. The op sequence comes from
        // the `IrDynamicLowering` handle (integration.ts), which routes
        // through the CANONICAL boxing entry points — `boxToAny` /
        // `__any_box_*` on the gc strategy, the `__box_number` import family
        // on host — never a second boxing engine (June-audit D4). The
        // operand's mode-resolved ValType picks the arm, exactly as legacy's
        // `coerceType(from, <any-carrier>)` dispatches on the same kind.
        if (instr.toType.kind === "dynamic") {
          const dyn = resolver.resolveDynamicLowering?.();
          if (!dyn) {
            throw new Error(
              `ir/lower: resolver cannot lower box-to-dynamic (resolveDynamicLowering missing/null) (${func.name})`,
            );
          }
          const operandIr = typeOf(instr.value);
          if (operandIr.kind === "dynamic") {
            // Verifier R1 backstop — a re-box is provably redundant.
            throw new Error(`ir/lower: box operand is already dynamic (${func.name})`);
          }
          const fromVal = lowerIrTypeToValType(operandIr, resolver, func.name);
          emitValue(instr.value, out);
          // The target's tag refinement (if the producer proved a partition)
          // becomes the boxing hint — e.g. a Boolean-refined i32 boxes as a
          // tag-4 boolean instead of the unbranded NUMBER default.
          // #3954 — the refinement is an opaque `TagId`; the `IrDynamicLowering`
          // contract (backend/handles.ts, frozen #3029-S1) still speaks `JsTag`.
          // `jsTagOf` is the ONE explicit crossing and throws on a foreign id
          // rather than emitting a bogus `$AnyValue.tag` constant.
          const boxHint = instr.toType.tag === undefined ? undefined : jsTagOf(instr.toType.tag);
          // pushraw-ok(#2949): pre-existing hatch — emitBox returns an opaque Instr[] by contract
          for (const op of dyn.emitBox(fromVal, boxHint)) emitter.pushRaw(out, op);
          return;
        }
        // `toType` must be a union (V1 only boxes into tagged unions). The
        // tag + value are pushed onto the stack in declaration order, then
        // struct.new builds the union instance.
        if (instr.toType.kind !== "union") {
          throw new Error(`ir/lower: box target must be a union IrType, got ${instr.toType.kind} (${func.name})`);
        }
        const valueType = asVal(typeOf(instr.value));
        if (!valueType) {
          throw new Error(`ir/lower: box value must be a val-kind IrType (${func.name})`);
        }
        // #1926 — unwrap each member IrType to its backend ValType.
        const members = instr.toType.members.map((m) => memberValType(m, func.name));
        const union = resolver.resolveUnion?.(members);
        if (!union) {
          throw new Error(
            `ir/lower: resolver cannot lower union<${members.map((m) => m.kind).join(",")}> (${func.name})`,
          );
        }
        if (!emitter.emitBox) {
          throw new Error(`ir/lower: ${emitter.backend} backend cannot lower union boxing (${func.name})`);
        }
        const boxedValue = emitter.newSink();
        emitValue(instr.value, boxedValue);
        emitter.emitBox(union, valueType, boxedValue, out);
        return;
      }
      case "unbox": {
        // Caller must have proved the tag already; lowering is a plain
        // `struct.get $val`. A future debug mode may prepend a tag check.
        const valueIrType = typeOf(instr.value);
        // #2949 slice 3 — unbox-from-dynamic: read the proven partition's
        // payload off the carrier. `tagId` is verifier-REQUIRED here (R2,
        // payload-bearing partitions only); the handle picks the payload
        // read (gc: canonical `__any_unbox_f64`/`__any_unbox_i32` readers /
        // struct.get; host: `__unbox_number` family / identity).
        if (valueIrType.kind === "dynamic") {
          const dyn = resolver.resolveDynamicLowering?.();
          if (!dyn) {
            throw new Error(
              `ir/lower: resolver cannot lower unbox-from-dynamic (resolveDynamicLowering missing/null) (${func.name})`,
            );
          }
          if (instr.tagId === undefined) {
            // Verifier R2 backstop.
            throw new Error(`ir/lower: unbox on a dynamic operand requires tagId (${func.name})`);
          }
          emitValue(instr.value, out);
          // #3954 phase 3 (W4) — the instruction field is now a neutral
          // `TagId`; the `IrDynamicLowering` contract (backend/handles.ts,
          // frozen #3029-S1) still speaks `JsTag`. `jsTagOf` is the same
          // explicit crossing the box arm above uses, and throws on a foreign
          // id rather than reading a bogus partition. Moving this crossing into
          // `integration.ts` is W2/W6 and is deliberately NOT done here.
          // pushraw-ok(#2949): pre-existing hatch — emitUnbox returns an opaque Instr[] by contract
          for (const op of dyn.emitUnbox(jsTagOf(instr.tagId))) emitter.pushRaw(out, op);
          return;
        }
        if (valueIrType.kind !== "union") {
          throw new Error(`ir/lower: unbox value must be a union IrType, got ${valueIrType.kind} (${func.name})`);
        }
        // #1926 — unwrap each member IrType to its backend ValType.
        const unboxMembers = valueIrType.members.map((m) => memberValType(m, func.name));
        const union = resolver.resolveUnion?.(unboxMembers);
        if (!union) {
          throw new Error(
            `ir/lower: resolver cannot lower union<${unboxMembers.map((m) => m.kind).join(",")}> (${func.name})`,
          );
        }
        emitValue(instr.value, out);
        if (!emitter.emitUnbox) {
          throw new Error(`ir/lower: ${emitter.backend} backend cannot lower union unboxing (${func.name})`);
        }
        emitter.emitUnbox(union, out);
        return;
      }
      case "tag.test": {
        // Emit struct.get $tag; i32.const <tagFor(tag)>; i32.eq.
        const valueIrType = typeOf(instr.value);
        // #2949 slice 3 — tag.test-on-dynamic: does the carrier's runtime
        // tag match the partition? `tagId` is verifier-REQUIRED here (R3,
        // ANY partition incl. Null/Undefined). Number partitions test the
        // numeric CLASS in both strategies (the V2 contract — see
        // `IrDynamicLowering` in backend/handles.ts for the WHY). The
        // scratch callback lazily allocates a carrier-typed local for arms
        // that read the operand twice (host Object test).
        if (valueIrType.kind === "dynamic") {
          const dyn = resolver.resolveDynamicLowering?.();
          if (!dyn) {
            throw new Error(
              `ir/lower: resolver cannot lower tag.test-on-dynamic (resolveDynamicLowering missing/null) (${func.name})`,
            );
          }
          if (instr.tagId === undefined) {
            // Verifier R3 backstop.
            throw new Error(`ir/lower: tag.test on a dynamic operand requires tagId (${func.name})`);
          }
          emitValue(instr.value, out);
          // #3954 phase 3 (W4) — see the `unbox` arm: `jsTagOf` is the one
          // explicit TagId→JsTag crossing at the frozen handle contract.
          for (const op of dyn.emitTagTest(jsTagOf(instr.tagId), () => dynamicScratch.tag(dyn.carrier))) {
            emitter.pushRaw(out, op);
          }
          return;
        }
        if (valueIrType.kind !== "union") {
          throw new Error(`ir/lower: tag.test value must be a union IrType, got ${valueIrType.kind} (${func.name})`);
        }
        // #2949 — `tag` became optional (dynamic operands use `tagId`); the
        // union path still REQUIRES it (verifier enforces; this is the
        // structural backstop).
        if (!instr.tag) {
          throw new Error(`ir/lower: tag.test on a union operand requires a ValType tag (${func.name})`);
        }
        // #1926 — unwrap each member IrType to its backend ValType.
        const tagTestMembers = valueIrType.members.map((m) => memberValType(m, func.name));
        const union = resolver.resolveUnion?.(tagTestMembers);
        if (!union) {
          throw new Error(
            `ir/lower: resolver cannot lower union<${tagTestMembers.map((m) => m.kind).join(",")}> (${func.name})`,
          );
        }
        const tag = union.tagFor(instr.tag);
        emitValue(instr.value, out);
        if (!emitter.emitTagLoad) {
          throw new Error(`ir/lower: ${emitter.backend} backend cannot lower union tag loads (${func.name})`);
        }
        emitter.emitTagLoad(union, out);
        emitter.emitConst(
          {
            kind: "const",
            result: null,
            resultType: null,
            value: { kind: "i32", value: tag },
          },
          func.name,
          out,
        );
        emitter.emitBinary("i32.eq", out);
        return;
      }
      case "dyn.truthy": {
        // #2949 S5.1 — ToBoolean on a boxed-any carrier. The operand MUST be
        // dynamic (verifier enforces); the op sequence comes from the
        // `IrDynamicLowering` handle, which routes to the CANONICAL
        // `coercion-engine.emitToBoolean` (`__any_unbox_bool` gc /
        // `__is_truthy` host) — one ToBoolean engine, byte-parity with the
        // legacy condition path (June-audit D4). Result is i32, directly
        // usable as an if / loop / ternary condValue.
        const valueIrType = typeOf(instr.value);
        if (valueIrType.kind !== "dynamic") {
          throw new Error(`ir/lower: dyn.truthy operand must be dynamic, got ${valueIrType.kind} (${func.name})`);
        }
        const dyn = resolver.resolveDynamicLowering?.();
        if (!dyn) {
          throw new Error(
            `ir/lower: resolver cannot lower dyn.truthy (resolveDynamicLowering missing/null) (${func.name})`,
          );
        }
        emitValue(instr.value, out);
        for (const op of dyn.emitToBoolean()) emitter.pushRaw(out, op);
        return;
      }
      case "dyn.to_number": {
        // #2949 S5.3 — ToNumber on a boxed-any carrier → f64 (the numeric-
        // abstract relational operand conversion). The operand MUST be dynamic
        // (verifier enforces); the op sequence comes from the
        // `IrDynamicLowering` handle, which routes to the CANONICAL per-backend
        // ToNumber (`__any_to_f64` gc / `__unbox_number` host) — one ToNumber
        // engine (June-audit D4). String×string lexicographic relational is
        // DEFERRED (see the `dyn.to_number` node doc); this arm implements only
        // the numeric path.
        const valueIrType = typeOf(instr.value);
        if (valueIrType.kind !== "dynamic") {
          throw new Error(`ir/lower: dyn.to_number operand must be dynamic, got ${valueIrType.kind} (${func.name})`);
        }
        const dyn = resolver.resolveDynamicLowering?.();
        if (!dyn) {
          throw new Error(
            `ir/lower: resolver cannot lower dyn.to_number (resolveDynamicLowering missing/null) (${func.name})`,
          );
        }
        emitValue(instr.value, out); // pushraw-ok(#4588): canonical backend ToNumber sequence follows
        for (const op of dyn.emitToNumber(dynamicScratch.toNumber)) emitter.pushRaw(out, op);
        return;
      }
      case "dyn.eq": {
        // #2949 S5.2 — strict/loose equality over two boxed-any carriers,
        // routed through the CANONICAL `__any_strict_eq` / `__any_eq` helpers
        // (June-audit D4). Both operands MUST be dynamic (verifier enforces);
        // each is marshalled to the `(ref null $AnyValue)` eq-helper ABI by
        // `emitEqOperand` (gc: identity; host: `__any_from_extern`) IMMEDIATELY
        // after it is pushed, so no scratch local is needed. The tag-5
        // classifier — incl. `NaN === NaN → false` — stays in the helper body.
        const lt = typeOf(instr.lhs);
        const rt = typeOf(instr.rhs);
        if (lt.kind !== "dynamic" || rt.kind !== "dynamic") {
          throw new Error(`ir/lower: dyn.eq operands must be dynamic, got ${lt.kind}/${rt.kind} (${func.name})`);
        }
        const dyn = resolver.resolveDynamicLowering?.();
        if (!dyn) {
          throw new Error(
            `ir/lower: resolver cannot lower dyn.eq (resolveDynamicLowering missing/null) (${func.name})`,
          );
        }
        emitValue(instr.lhs, out);
        for (const op of dyn.emitEqOperand()) emitter.pushRaw(out, op);
        emitValue(instr.rhs, out);
        for (const op of dyn.emitEqOperand()) emitter.pushRaw(out, op);
        const call = instr.loose ? dyn.emitLooseEq(instr.negate) : dyn.emitStrictEq(instr.negate);
        for (const op of call) emitter.pushRaw(out, op);
        return;
      }
      case "dyn.member_get": {
        // #3053 U1 / #2949 S5.4 — dynamic member read `recv[key]` / `recv.name`
        // through the unified reader primitive `__dyn_member_get(recv, key)`
        // (#3053 U0). Both operands MUST be dynamic carriers (verifier +
        // builder enforce); the handle emits a bare `[call __dyn_member_get]`
        // and flips `ctx.usesDynMemberGet` so the finalize `ensureDynMemberGet`
        // pass builds the helper. The result is the identity-preserving,
        // tag-honest carrier — no externref↔$AnyValue impedance at the boundary
        // (the helper closes the round-trip in its own frame).
        const recvT = typeOf(instr.recv);
        const keyT = typeOf(instr.key);
        if (recvT.kind !== "dynamic" || keyT.kind !== "dynamic") {
          throw new Error(
            `ir/lower: dyn.member_get operands must be dynamic, got ${recvT.kind}/${keyT.kind} (${func.name})`,
          );
        }
        const dyn = resolver.resolveDynamicLowering?.();
        if (!dyn) {
          throw new Error(
            `ir/lower: resolver cannot lower dyn.member_get (resolveDynamicLowering missing/null) (${func.name})`,
          );
        }
        emitValue(instr.recv, out);
        emitValue(instr.key, out);
        for (const op of dyn.emitMemberGet()) emitter.pushRaw(out, op);
        return;
      }
      case "dyn.member_set": {
        const recvT = typeOf(instr.recv);
        const keyT = typeOf(instr.key);
        const valueT = typeOf(instr.value);
        if (recvT.kind !== "dynamic" || keyT.kind !== "dynamic" || valueT.kind !== "dynamic") {
          throw new Error(
            `ir/lower: dyn.member_set operands must be dynamic, got ${recvT.kind}/${keyT.kind}/${valueT.kind} (${func.name})`,
          );
        }
        const dyn = resolver.resolveDynamicLowering?.();
        if (!dyn) {
          throw new Error(
            `ir/lower: resolver cannot lower dyn.member_set (resolveDynamicLowering missing/null) (${func.name})`,
          );
        }
        // JS assignment evaluation order: receiver, key, RHS. The SSA
        // scheduler anchors this side-effecting instruction; operands are
        // emitted in the same order immediately before the strict helper call.
        emitValue(instr.recv, out);
        emitValue(instr.key, out);
        emitValue(instr.value, out);
        // pushraw-ok(#3795): backend-provided dynamic store sequence is rejected by non-Wasm backend legality
        for (const op of dyn.emitMemberSet()) emitter.pushRaw(out, op);
        return;
      }
      case "string.const": {
        emitter.emitStringConst(instr.value, instr.alloc, out, instr.storage, instr.materializer);
        return;
      }
      case "string.concat": {
        emitValue(instr.lhs, out);
        emitValue(instr.rhs, out);
        emitter.emitStringConcat(instr.alloc, instr.concatMode ?? "immutable", out, instr.provider);
        return;
      }
      case "string.eq": {
        emitValue(instr.lhs, out);
        emitValue(instr.rhs, out);
        emitter.emitStringEquals(instr.negate, out, instr.provider);
        return;
      }
      case "string.len": {
        emitValue(instr.value, out);
        emitter.emitStringLength(instr.inputEncoding, out, instr.provider);
        return;
      }
      case "string.char_at": {
        emitValue(instr.value, out);
        emitValue(instr.index, out);
        emitter.emitStringCharAt(instr.alloc, instr.inputEncoding, out, instr.provider);
        return;
      }
      case "string.char_code_at": {
        emitValue(instr.value, out);
        emitValue(instr.index, out);
        emitter.emitStringCharCodeAt(instr.inputEncoding, out, instr.provider);
        return;
      }
      case "object.new": {
        const obj = resolver.resolveObject?.(instr.shape, instr.alloc);
        if (!obj) {
          throw new Error(`ir/lower: resolver cannot lower object<${describeShape(instr.shape)}> (${func.name})`);
        }
        // Push values in canonical (sorted) field order — same order as
        // shape.fields, which is also the WasmGC struct's declared field
        // order. The builder enforces value-count parity with shape arity,
        // so this loop always produces the right stack shape.
        // (a2) struct/object family (#1584 §2a): route through emitAggregateNew
        // — byte-identical {op:"struct.new"} on WasmGC, OP.STRUCT_NEW on bytecode.
        for (const v of instr.values) emitValue(v, out);
        emitter.emitAggregateNew(obj, instr.values.length, out);
        return;
      }
      case "object.get": {
        const valueIrType = typeOf(instr.value);
        if (valueIrType.kind !== "object") {
          throw new Error(
            `ir/lower: object.get value must be an object IrType, got ${valueIrType.kind} (${func.name})`,
          );
        }
        const obj = resolver.resolveObject?.(valueIrType.shape);
        if (!obj) {
          throw new Error(`ir/lower: resolver cannot lower object<${describeShape(valueIrType.shape)}> (${func.name})`);
        }
        // (a2): route through emitFieldGet — byte-identical {op:"struct.get"}
        // on WasmGC, OP.STRUCT_GET <fieldIdx> on bytecode.
        emitValue(instr.value, out);
        emitter.emitFieldGet(obj, instr.name, out);
        return;
      }
      case "object.set": {
        const valueIrType = typeOf(instr.value);
        if (valueIrType.kind !== "object") {
          throw new Error(
            `ir/lower: object.set value must be an object IrType, got ${valueIrType.kind} (${func.name})`,
          );
        }
        const obj = resolver.resolveObject?.(valueIrType.shape);
        if (!obj) {
          throw new Error(`ir/lower: resolver cannot lower object<${describeShape(valueIrType.shape)}> (${func.name})`);
        }
        // (a2): route through emitFieldSet — byte-identical {op:"struct.set"}
        // on WasmGC, OP.STRUCT_SET <fieldIdx> on bytecode.
        emitValue(instr.value, out);
        emitValue(instr.newValue, out);
        emitter.emitFieldSet(obj, instr.name, out);
        return;
      }
      // Slice 3 (#1169c): closure / ref-cell ops.
      case "closure.new": {
        const liftedIdx = resolver.resolveFunc(instr.liftedFunc);
        const sub = resolver.resolveClosureSubtype?.(
          instr.signature,
          instr.captureFieldTypes,
          instr.hostOneShot === true,
          instr.domCallbackAuthority,
          liftedIdx,
        );
        if (!sub) {
          throw new Error(`ir/lower: resolver cannot lower closure subtype (${func.name})`);
        }
        // ref.func $lifted, (#3673) $arity, push captures, struct.new <subtype>.
        emitter.emitFuncRef(liftedIdx, out);
        emitter.emitClosureArityOperand?.(instr.signature.defaultParamStart ?? instr.signature.params.length, out);
        for (const cap of instr.captures) emitValue(cap, out);
        emitter.emitClosureNew(sub, instr.captures.length, out);
        return;
      }
      case "closure.cap": {
        // The lifted body knows its own subtype via the IrFunction's
        // closureSubtype metadata (set at lift time). Read that to find
        // the cast target and field index.
        const subMeta = func.closureSubtype;
        if (!subMeta) {
          throw new Error(`ir/lower: closure.cap requires func.closureSubtype metadata (${func.name})`);
        }
        const sub = resolver.resolveClosureSubtype?.(
          subMeta.signature,
          subMeta.captureFieldTypes,
          subMeta.hostOneShot === true,
          subMeta.domCallbackAuthority,
        );
        if (!sub) {
          throw new Error(`ir/lower: resolver cannot resolve closure subtype for ${func.name}`);
        }
        emitValue(instr.self, out);
        emitter.emitDowncast({ typeIdx: sub.structTypeIdx }, out);
        emitter.emitCaptureGet(sub, instr.index, out);
        return;
      }
      case "closure.call": {
        const calleeT = typeOf(instr.callee);
        if (calleeT.kind !== "closure" && calleeT.kind !== "callable") {
          throw new Error(
            `ir/lower: closure.call callee must be closure/callable IrType, got ${calleeT.kind} (${func.name})`,
          );
        }
        const cl = resolver.resolveClosure?.(calleeT.signature);
        if (!cl) {
          throw new Error(`ir/lower: resolver cannot lower closure for call (${func.name})`);
        }
        // The wrapper ROOT is the only cross-module-stable struct identity:
        // per-signature wrappers depend on which signature a module happened
        // to register first. It is therefore both the lifted `self` carrier and
        // the type used for field-0 extraction. The funcref cast below performs
        // the exact signature check without narrowing the struct itself.
        // Resolving `cl` first creates the root when necessary.
        const rootTypeIdx = resolver.resolveClosureRoot?.() ?? null;
        if (rootTypeIdx === null) {
          throw new Error(`ir/lower: resolver cannot lower closure wrapper root (${func.name})`);
        }
        const emitRootSelf = (): void => {
          emitValue(instr.callee, out);
          if (calleeT.kind === "callable") {
            emitter.emitFromExternref({ typeIdx: rootTypeIdx }, out);
          }
        };

        // Push root __self, then user args, then the callee value AGAIN to
        // extract field 0. The double-emit is the reason
        // `collectIrUses` returns `callee` twice — it forces the SSA value
        // into a Wasm local instead of re-emitting its producing tree.
        emitRootSelf();
        for (const a of instr.args) emitValue(a, out);
        emitRootSelf();
        emitter.emitClosureFuncGet({ ...cl, structTypeIdx: rootTypeIdx }, out);
        // The struct's `func` field is typed as the abstract `funcref`
        // (matches the legacy `getOrCreateFuncRefWrapperTypes` pattern,
        // which avoids a circular type reference between the struct and
        // its lifted func type). `call_ref` requires a typed funcref, so
        // we emit `ref.cast` to convert.
        // The function-field read routes through the closure-family hook and
        // the narrowing cast through the ref-coercion hook. The terminal
        // call_ref is the (a1) call family → typed emitCallRef
        // (byte-identical {op:"call_ref"} on WasmGC, OP.CALL_REF on bytecode).
        emitter.emitDowncast({ typeIdx: cl.funcTypeIdx }, out);
        emitter.emitCallRef(cl.funcTypeIdx, out);
        return;
      }
      case "refcell.new": {
        const valueIrType = typeOf(instr.value);
        const inner = asVal(valueIrType);
        if (!inner) {
          throw new Error(`ir/lower: refcell.new value must be a val-kind IrType (${func.name})`);
        }
        const cell = resolver.resolveRefCell?.(inner, instr.alloc);
        if (!cell) {
          throw new Error(`ir/lower: resolver cannot lower refcell<${inner.kind}> (${func.name})`);
        }
        emitValue(instr.value, out);
        // (a5) ref-cell family (#2953): route through emitRefCellNew —
        // byte-identical {op:"struct.new"} on WasmGC.
        emitter.emitRefCellNew(cell, out);
        return;
      }
      case "refcell.get": {
        const cellT = typeOf(instr.cell);
        if (cellT.kind !== "boxed") {
          throw new Error(`ir/lower: refcell.get cell must be boxed, got ${cellT.kind} (${func.name})`);
        }
        // #1926 — unwrap the inner IrType to its backend ValType.
        const getInner = memberValType(cellT.inner, func.name);
        const cell = resolver.resolveRefCell?.(getInner);
        if (!cell) {
          throw new Error(`ir/lower: resolver cannot lower refcell<${getInner.kind}> (${func.name})`);
        }
        emitValue(instr.cell, out);
        // (a5) ref-cell family (#2953): route through emitRefCellGet —
        // byte-identical {op:"struct.get"} on WasmGC.
        emitter.emitRefCellGet(cell, out);
        return;
      }
      case "refcell.set": {
        const cellT = typeOf(instr.cell);
        if (cellT.kind !== "boxed") {
          throw new Error(`ir/lower: refcell.set cell must be boxed, got ${cellT.kind} (${func.name})`);
        }
        // #1926 — unwrap the inner IrType to its backend ValType.
        const setInner = memberValType(cellT.inner, func.name);
        const cell = resolver.resolveRefCell?.(setInner);
        if (!cell) {
          throw new Error(`ir/lower: resolver cannot lower refcell<${setInner.kind}> (${func.name})`);
        }
        emitValue(instr.cell, out);
        emitValue(instr.value, out);
        // (a5) ref-cell family (#2953): route through emitRefCellSet —
        // byte-identical {op:"struct.set"} on WasmGC.
        emitter.emitRefCellSet(cell, out);
        return;
      }
      // Slice 4 (#1169d): class ops.
      case "class.new": {
        const cl = resolver.resolveClass?.(instr.shape);
        if (!cl) {
          throw new Error(`ir/lower: resolver cannot lower class ${instr.shape.className} (${func.name})`);
        }
        for (const a of instr.args) emitValue(a, out);
        emitter.pushRaw(out, {
          op: "call",
          funcIdx: resolver.resolveFunc(instr.target ?? cl.constructorFunc),
        });
        return;
      }
      case "class.get": {
        const recvT = typeOf(instr.value);
        if (recvT.kind !== "class") {
          throw new Error(`ir/lower: class.get receiver must be class IrType, got ${recvT.kind} (${func.name})`);
        }
        const cl = resolver.resolveClass?.(recvT.shape);
        if (!cl) {
          throw new Error(`ir/lower: resolver cannot lower class ${recvT.shape.className} (${func.name})`);
        }
        emitValue(instr.value, out);
        emitter.pushRaw(out, {
          op: "struct.get",
          typeIdx: cl.structTypeIdx,
          fieldIdx: cl.fieldIdx(instr.fieldName),
        });
        return;
      }
      case "class.set": {
        const recvT = typeOf(instr.value);
        if (recvT.kind !== "class") {
          throw new Error(`ir/lower: class.set receiver must be class IrType, got ${recvT.kind} (${func.name})`);
        }
        const cl = resolver.resolveClass?.(recvT.shape);
        if (!cl) {
          throw new Error(`ir/lower: resolver cannot lower class ${recvT.shape.className} (${func.name})`);
        }
        emitValue(instr.value, out);
        emitValue(instr.newValue, out);
        emitter.pushRaw(out, {
          op: "struct.set",
          typeIdx: cl.structTypeIdx,
          fieldIdx: cl.fieldIdx(instr.fieldName),
        });
        return;
      }
      case "class.call": {
        const recvT = typeOf(instr.receiver);
        if (recvT.kind !== "class") {
          throw new Error(`ir/lower: class.call receiver must be class IrType, got ${recvT.kind} (${func.name})`);
        }
        const cl = resolver.resolveClass?.(recvT.shape);
        if (!cl) {
          throw new Error(`ir/lower: resolver cannot lower class ${recvT.shape.className} (${func.name})`);
        }
        // `this` first, then user args, then call $<className>_<methodName>.
        emitValue(instr.receiver, out);
        for (const a of instr.args) emitValue(a, out);
        emitter.pushRaw(out, {
          op: "call",
          funcIdx: resolver.resolveFunc(cl.memberFunc(instr.memberKind, instr.methodName, instr.target)),
        });
        return;
      }
      case "class.super_init": {
        // #3000-E: `super(args)` — run the PARENT's `<parent>_init` on the
        // already-allocated `self`. Legacy `_init` signature is
        // `(...ctorParams, self) -> (ref $struct)` (self LAST), so emit the user
        // args first, then `self`, then call. The returned instance is discarded
        // (super() is a statement) → drop.
        const cl = resolver.resolveClass?.(instr.parentShape);
        if (!cl) {
          throw new Error(`ir/lower: resolver cannot lower super class ${instr.parentShape.className} (${func.name})`);
        }
        for (const a of instr.args) emitValue(a, out);
        emitValue(instr.self, out);
        emitter.pushRaw(out, {
          op: "call",
          funcIdx: resolver.resolveFunc(instr.target ?? cl.initFunc),
        });
        emitter.pushRaw(out, { op: "drop" });
        return;
      }
      case "class.super_call": {
        // #3000-E: `super.method(args)` — static-dispatch to the PARENT's method
        // slot (`<parent>_<method>`) with the subclass receiver first, then args.
        // Resolving against `parentShape` (not the receiver's shape) bypasses any
        // subclass override.
        const cl = resolver.resolveClass?.(instr.parentShape);
        if (!cl) {
          throw new Error(`ir/lower: resolver cannot lower super class ${instr.parentShape.className} (${func.name})`);
        }
        emitValue(instr.receiver, out);
        for (const a of instr.args) emitValue(a, out);
        emitter.pushRaw(out, {
          op: "call",
          funcIdx: resolver.resolveFunc(cl.memberFunc("method", instr.methodName, instr.target)),
        });
        return;
      }
      case "class.instanceof": {
        // (#3144) `value instanceof <target>` — read the receiver struct's
        // hidden `__tag` (slot 0) and compare against the TARGET class's
        // instanceof-compatible tag set (own + descendants), mirroring the
        // legacy `compileInstanceOf` non-nullable-ref path. The IR class
        // carrier is a non-null `(ref $Struct)`, so no null arm exists.
        const recvT = typeOf(instr.value);
        if (recvT.kind !== "class") {
          throw new Error(`ir/lower: class.instanceof value must be class IrType, got ${recvT.kind} (${func.name})`);
        }
        const recvCl = resolver.resolveClass?.(recvT.shape);
        if (!recvCl) {
          throw new Error(`ir/lower: resolver cannot lower class ${recvT.shape.className} (${func.name})`);
        }
        const targetCl = resolver.resolveClass?.(instr.targetShape);
        if (!targetCl) {
          throw new Error(`ir/lower: resolver cannot lower class ${instr.targetShape.className} (${func.name})`);
        }
        const tags = targetCl.instanceOfTags;
        emitValue(instr.value, out);
        if (tags.length === 0) {
          // Tag-less target class — legacy parity: evaluate LHS, false.
          emitter.pushRaw(out, { op: "drop" });
          emitter.pushRaw(out, { op: "i32.const", value: 0 });
          return;
        }
        emitter.pushRaw(out, {
          op: "struct.get",
          typeIdx: recvCl.structTypeIdx,
          fieldIdx: recvCl.fieldIdx("__tag"),
        });
        if (tags.length === 1) {
          emitter.pushRaw(out, { op: "i32.const", value: tags[0]! });
          emitter.pushRaw(out, { op: "i32.eq" });
          return;
        }
        // Multiple compatible tags: (tag == t0) || (tag == t1) || … via an
        // i32 scratch local (same shape as legacy's multi-tag emission).
        const scratch = dynamicScratch.instanceofTag();
        emitter.pushRaw(out, { op: "local.set", index: scratch });
        emitter.pushRaw(out, { op: "local.get", index: scratch });
        emitter.pushRaw(out, { op: "i32.const", value: tags[0]! });
        emitter.pushRaw(out, { op: "i32.eq" });
        for (let i = 1; i < tags.length; i++) {
          emitter.pushRaw(out, { op: "local.get", index: scratch });
          emitter.pushRaw(out, { op: "i32.const", value: tags[i]! });
          emitter.pushRaw(out, { op: "i32.eq" });
          emitter.pushRaw(out, { op: "i32.or" });
        }
        return;
      }
      case "class.static_call": {
        // (#3144) `C.m(args)` — legacy statics take NO self param
        // (class-bodies.ts: `methodParams = isStatic ? [] : [self]`), so
        // emission is args then a direct call by collision-relocated key.
        const cl = resolver.resolveClass?.(instr.shape);
        if (!cl) {
          throw new Error(`ir/lower: resolver cannot lower class ${instr.shape.className} (${func.name})`);
        }
        for (const a of instr.args) emitValue(a, out);
        emitter.pushRaw(out, {
          op: "call",
          funcIdx: resolver.resolveFunc(cl.memberFunc("static", instr.methodName, instr.target)),
        });
        return;
      }
      // Slice 6 (#1169e): slot / vec / for-of ops.
      case "slot.read": {
        emitter.emitLocalGet(slotWasmIdx(instr.slotIndex), out);
        return;
      }
      case "slot.write": {
        emitValue(instr.value, out);
        emitter.emitLocalSet(slotWasmIdx(instr.slotIndex), out);
        return;
      }
      case "vec.len": {
        const vec = resolveVecType(typeOf(instr.vec));
        if (!vec) throw new Error(`ir/lower: resolver cannot lower vec for vec.len (${func.name})`);
        emitValue(instr.vec, out);
        emitter.emitVecLen(vec, out);
        // JS length is f64; certified internal counted loops retain the physical i32.
        if (instr.integer !== true) emitter.emitUnary("f64.convert_i32_s", out);
        return;
      }
      case "vec.get": {
        const vec = resolveVecType(typeOf(instr.vec));
        if (!vec) throw new Error(`ir/lower: resolver cannot lower vec for vec.get (${func.name})`);
        // Stack: dataArray, index → element
        emitValue(instr.vec, out);
        emitter.emitVecDataPtr(vec, out);
        emitValue(instr.index, out);
        emitter.emitElemGet(vec, out);
        return;
      }
      case "vec.set": {
        const vec = resolveVecType(typeOf(instr.vec));
        if (!vec) throw new Error(`ir/lower: resolver cannot lower vec for vec.set (${func.name})`);
        emitValue(instr.vec, out);
        emitter.emitVecDataPtr(vec, out);
        emitValue(instr.index, out);
        emitValue(instr.newValue, out);
        emitter.emitElemSet(vec, ensureVecElementScratch(vec.elementValType), out);
        return;
      }
      case "vec.set_length": {
        const vec = resolveVecType(typeOf(instr.vec));
        if (!vec) throw new Error(`ir/lower: resolver cannot lower vec for vec.set_length (${func.name})`);
        emitValue(instr.vec, out);
        emitValue(instr.length, out);
        emitter.emitVecSetLength(vec, out);
        return;
      }
      case "vec.new_fixed": {
        // #1804 — build a fixed-length vec from its element SSA values.
        lowerIrTypeToValType(instr.elementType, resolver, func.name);
        const vec = resolveVecType(
          instr.resultType ?? { kind: "vec", elementType: instr.elementType, nullable: false },
          instr.alloc,
        );
        if (!vec) {
          throw new Error(`ir/lower: resolver cannot lower vec for vec.new_fixed (${func.name})`);
        }
        // Push e0…eN in order (deepest first), then build the data array +
        // wrap in the vec struct via a scratch local for the (length, data)
        // field order.
        for (const el of instr.elements) emitValue(el, out);
        const dataScratch = ensureVecDataScratch(vec.arrayTypeIdx);
        emitter.emitVecNewFixed(vec, instr.elements.length, instr.capacity ?? instr.elements.length, dataScratch, out);
        return;
      }
      // Slice 7a/7b (#1169f): generator ops.
      case "gen.push": {
        // Dispatch on the value's IrType to pick the typed
        // `__gen_push_*` host import. Slice 7b widens the dispatch:
        //
        //   { kind: "val", val.kind: "f64" }       → __gen_push_f64
        //   { kind: "val", val.kind: "i32" }       → __gen_push_i32  (booleans)
        //   anything else (externref / ref /
        //     ref_null / string / object / class)  → __gen_push_ref
        //
        // The from-ast lowerer (`lowerYield`) is responsible for
        // ensuring non-primitive yield values are coerced to externref
        // BEFORE reaching `gen.push`. The lowerer here trusts that
        // contract: any non-(f64/i32) value-IrType is presumed to be
        // a reference type that the host can tag via
        // `__gen_push_ref(buf, externref)`. The `extern.convert_any`
        // operation embedded in the upstream `coerce.to_externref`
        // takes any reference-shaped value and yields an externref
        // suitable for the import's signature.
        if (func.generatorBufferSlot === undefined) {
          throw new Error(`ir/lower: gen.push requires func.generatorBufferSlot (${func.name})`);
        }
        const valueT = asVal(typeOf(instr.value));
        let importName: string;
        if (valueT?.kind === "f64") {
          importName = "__gen_push_f64";
        } else if (valueT?.kind === "i32") {
          importName = "__gen_push_i32";
        } else {
          // ref / ref_null / externref / IrType.string / object / class
          // / closure all land here. The from-ast lowerer must have
          // coerced to externref upstream — `coerce.to_externref`
          // emits an `extern.convert_any` so the value flowing in
          // has the right Wasm type for the import signature
          // `(externref, externref) → void`.
          importName = "__gen_push_ref";
        }
        // #2951 — prefer the sealed provider so lowering consumes exactly the
        // callable prepared-component dependency discovery proved.
        const fnIdx = resolver.resolveFunc(instr.provider ?? irRuntimeFuncRef(importName));
        // Stack: buffer, value → (void); call __gen_push_*.
        emitter.pushRaw(out, {
          op: "local.get",
          index: slotWasmIdx(func.generatorBufferSlot),
        });
        emitValue(instr.value, out);
        emitter.pushRaw(out, { op: "call", funcIdx: fnIdx });
        return;
      }
      case "gen.epilogue": {
        // Emit `__create_generator(buffer, ref.null.extern)`. The
        // pendingThrow argument is always `ref.null.extern` in slice 7a
        // (we don't yet wrap the body in a try/catch — see the doc on
        // IrInstrGenEpilogue for the deferred-throw caveat).
        if (func.generatorBufferSlot === undefined) {
          throw new Error(`ir/lower: gen.epilogue requires func.generatorBufferSlot (${func.name})`);
        }
        const fnIdx = resolver.resolveFunc(instr.provider ?? irRuntimeFuncRef("__create_generator"));
        emitter.pushRaw(out, {
          op: "local.get",
          index: slotWasmIdx(func.generatorBufferSlot),
        });
        emitter.emitNull({ kind: "val", val: { kind: "externref" } }, out);
        emitter.pushRaw(out, { op: "call", funcIdx: fnIdx });
        return;
      }
      // Slice 7b (#1169f): yield* delegation.
      case "gen.yieldStar": {
        // Emit `__gen_yield_star(buffer, inner)`. The `inner` SSA
        // value MUST be externref-typed by upstream coercion (the
        // from-ast layer inserts `coerce.to_externref` before this
        // instr). The host helper iterates `inner` via
        // `Symbol.iterator` and pushes each yielded value into the
        // outer buffer (see `runtime.ts:2999`).
        if (func.generatorBufferSlot === undefined) {
          throw new Error(`ir/lower: gen.yieldStar requires func.generatorBufferSlot (${func.name})`);
        }
        const fnIdx = resolver.resolveFunc(instr.provider ?? irRuntimeFuncRef("__gen_yield_star"));
        emitter.pushRaw(out, {
          op: "local.get",
          index: slotWasmIdx(func.generatorBufferSlot),
        });
        emitValue(instr.inner, out);
        emitter.pushRaw(out, { op: "call", funcIdx: fnIdx });
        return;
      }
      // #2951: generator `return <value>` — stash the value on the buffer
      // via `__gen_set_return(buf, value)` (signature `(externref, externref)
      // → void`, registered in `addGeneratorImports`). Mirrors legacy
      // `compileReturnStatement` (`codegen/statements/control-flow.ts:144`).
      // The value MUST be BOXED to externref before the call:
      //   f64        → `__box_number`
      //   i32        → `f64.convert_i32_s` then `__box_number`
      //   ref/ref_null → `extern.convert_any`
      //   externref  → pass through (from-ast already coerced ref-shaped
      //                values to externref, so this is the common arm)
      // If `__box_number` is unresolvable (e.g. a lane with no host boxing),
      // `resolveFunc` THROWS — which demotes the whole function to legacy
      // (integration.ts catch), never emitting a raw f64 arg that would fail
      // Wasm validation against the `(externref, externref)` signature.
      case "gen.setReturn": {
        if (func.generatorBufferSlot === undefined) {
          throw new Error(`ir/lower: gen.setReturn requires func.generatorBufferSlot (${func.name})`);
        }
        const setReturnIdx = resolver.resolveFunc(instr.provider ?? irRuntimeFuncRef("__gen_set_return"));
        const boxRef = instr.boxProvider ?? irRuntimeFuncRef("__box_number");
        const valueT = asVal(typeOf(instr.value));
        // buffer (arg 0)
        emitter.pushRaw(out, {
          op: "local.get",
          index: slotWasmIdx(func.generatorBufferSlot),
        });
        // value (arg 1), boxed to externref
        emitValue(instr.value, out);
        if (valueT?.kind === "f64") {
          // pushraw-ok(#2951): plain call op — boxes the f64 return value to externref, mirrors the gen.setReturn contract above
          emitter.pushRaw(out, { op: "call", funcIdx: resolver.resolveFunc(boxRef) });
        } else if (valueT?.kind === "i32") {
          emitter.pushRaw(out, { op: "f64.convert_i32_s" });
          // pushraw-ok(#2951): plain call op — boxes the widened i32 return value to externref, same contract as the f64 arm
          emitter.pushRaw(out, { op: "call", funcIdx: resolver.resolveFunc(boxRef) });
        } else if (valueT?.kind === "ref" || valueT?.kind === "ref_null") {
          emitter.emitToExternref(out);
        }
        // externref: already the right Wasm type — no coercion.
        emitter.pushRaw(out, { op: "call", funcIdx: setReturnIdx });
        return;
      }
      case "forof.vec": {
        // The forof.vec instr is statement-level (result: null) but we
        // implement it inside emitInstrTree for code-organization parity
        // with the other instrs. The lowerer in `emitBlockBody` calls
        // `emitInstrTree` for void-producing instrs as a unit.
        const vec = resolveVecType(typeOf(instr.vec));
        if (!vec) throw new Error(`ir/lower: resolver cannot lower vec for forof.vec (${func.name})`);

        // #1584 (a0-tail): this arm structurally embeds an `Instr[]` loop body
        // into a raw WasmGC `{op:"block",body:[{op:"loop"...}]}` — WasmGC-only
        // until the control-flow family (§2a a3) migrates. Assert S = Instr[].
        const wasmOut = requireInstrSink(out);

        // Push the vec ref.
        emitValue(instr.vec, out);
        // Save to vec slot.
        wasmOut.push({ op: "local.set", index: slotWasmIdx(instr.vecSlot) });

        // length = vec.length
        wasmOut.push({ op: "local.get", index: slotWasmIdx(instr.vecSlot) });
        emitter.emitVecLen(vec, out);
        wasmOut.push({ op: "local.set", index: slotWasmIdx(instr.lengthSlot) });

        // data = vec.data
        wasmOut.push({ op: "local.get", index: slotWasmIdx(instr.vecSlot) });
        emitter.emitVecDataPtr(vec, out);
        wasmOut.push({ op: "local.set", index: slotWasmIdx(instr.dataSlot) });

        // counter = 0
        wasmOut.push({ op: "i32.const", value: 0 });
        wasmOut.push({
          op: "local.set",
          index: slotWasmIdx(instr.counterSlot),
        });

        // #2952 slice 2 — frames: outer block = break target; loop frame is
        // plain (the counter-advance runs AFTER the body, so a continue
        // targets a dedicated body-wrapping block that falls into it —
        // emitted only when the body contains a continue for this loop).
        const label = instr.loopLabel;
        const needsContinueBlock = label !== undefined && bufferHasBrLabel(instr.body, label, "continue");
        ctrlStack.push(label !== undefined ? { kind: "break", label } : { kind: "plain" });
        ctrlStack.push({ kind: "plain" });

        // Build loop body Wasm ops by recursively emitting body instrs.
        const loopBody: Instr[] = [];
        // if (counter >= length) br 1 (exit)
        loopBody.push({
          op: "local.get",
          index: slotWasmIdx(instr.counterSlot),
        });
        loopBody.push({
          op: "local.get",
          index: slotWasmIdx(instr.lengthSlot),
        });
        loopBody.push({ op: "i32.ge_s" });
        // #1584 (a3): control-flow ops route through the trait.
        emitter.emitBrIf(1, loopBody as unknown as S);

        // element = data[counter]
        loopBody.push({ op: "local.get", index: slotWasmIdx(instr.dataSlot) });
        loopBody.push({
          op: "local.get",
          index: slotWasmIdx(instr.counterSlot),
        });
        // `loopBody` is an Instr[] sub-buffer; the arm has asserted S = Instr[]
        // (via requireInstrSink) so the cast to S is sound (#1584 §2a).
        emitter.emitElemGet(vec, loopBody as unknown as S);
        loopBody.push({
          op: "local.set",
          index: slotWasmIdx(instr.elementSlot),
        });

        // Body instrs (continue block falls through to the counter advance).
        if (needsContinueBlock) {
          const bodyOps: Instr[] = [];
          ctrlStack.push({ kind: "continue", label: label! });
          emitBufferAsStatements(instr.body, bodyOps as unknown as S);
          ctrlStack.pop();
          emitter.emitBlock({ kind: "empty" }, bodyOps as unknown as S, loopBody as unknown as S);
        } else {
          emitBufferAsStatements(instr.body, loopBody as unknown as S);
        }

        // counter = counter + 1
        loopBody.push({
          op: "local.get",
          index: slotWasmIdx(instr.counterSlot),
        });
        loopBody.push({ op: "i32.const", value: 1 });
        loopBody.push({ op: "i32.add" });
        loopBody.push({
          op: "local.set",
          index: slotWasmIdx(instr.counterSlot),
        });

        // br 0 (continue)
        emitter.emitBr(0, loopBody as unknown as S);
        ctrlStack.pop(); // loop frame
        ctrlStack.pop(); // break frame

        // Wrap in block { loop { ... } } via the trait (#1584 a3).
        const loopWrap: Instr[] = [];
        emitter.emitLoop({ kind: "empty" }, loopBody as unknown as S, loopWrap as unknown as S);
        emitter.emitBlock({ kind: "empty" }, loopWrap as unknown as S, wasmOut as unknown as S);
        return;
      }
      // Slice 6 part 3 (#1182) — coercion + iterator protocol ops.
      case "coerce.to_externref": {
        // Push the value, then re-tag an anyref subtype → externref.
        //
        // #2955 — whether the operand is ALREADY externref is a string-mode
        // decision that belongs HERE, at lower time, not in the from-ast
        // front-end. `extern.convert_any` maps an anyref subtype into
        // externref, but it is INVALID over an operand whose Wasm valtype is
        // already externref (externref is not itself an anyref subtype). In
        // host-strings mode `IrType.string` lowers to externref, so the
        // convert must be ELIDED; in native-strings mode it lowers to
        // `(ref $AnyString)` (an anyref subtype) and the convert is REQUIRED.
        // An operand already typed `(val) externref` is likewise a no-op.
        // Emitting the convert over an already-externref operand is dead
        // today (from-ast guards every site), so this elision is byte-inert
        // for existing callers while letting from-ast drop those guards and
        // emit `coerce.to_externref` mode-agnostically (identical IR in both
        // string modes; per-mode lowered bytes unchanged).
        emitValue(instr.value, out);
        const opTy = typeOf(instr.value);
        const alreadyExternref =
          (opTy.kind === "val" && opTy.val.kind === "externref") ||
          opTy.kind === "extern" ||
          opTy.kind === "callable" ||
          (opTy.kind === "string" && resolver.resolveString?.()?.kind === "externref");
        if (!alreadyExternref) {
          emitter.emitToExternref(out);
        }
        return;
      }
      case "iter.new": {
        const fnName = instr.async ? "__async_iterator" : "__iterator";
        const funcIdx = resolver.resolveFunc(irRuntimeFuncRef(fnName));
        emitValue(instr.iterable, out);
        emitter.pushRaw(out, { op: "call", funcIdx });
        return;
      }
      case "iter.next":
      case "iter.done":
      case "iter.value": {
        // #1620 v2: __iterator_next now returns multi-value (i32 done, externref
        // value) and the separate __iterator_done / __iterator_value imports are
        // gone. These standalone single-result instrs assumed a stored result
        // object read by separate done/value calls — that model no longer exists.
        // Only `forof.iter` (which consumes the multi-value directly) is emitted
        // by the frontend; these are unreachable scaffolding. Fail loudly rather
        // than resolve a removed import if a future caller emits them.
        throw new Error(
          `IR lowering: '${instr.kind}' is no longer supported — __iterator_next ` +
            `returns multi-value (done, value); use forof.iter instead (#1620 v2)`,
        );
      }
      case "iter.return": {
        const funcIdx = resolver.resolveFunc(irRuntimeFuncRef("__iterator_return"));
        emitValue(instr.iter, out);
        emitter.pushRaw(out, { op: "call", funcIdx });
        return;
      }
      case "forof.iter": {
        // Mirror of forof.vec but using the iterator protocol. The lowerer
        // emits the `block { loop { ... } }` Wasm pattern documented on
        // `IrInstrForOfIter` in `nodes.ts`.
        const iteratorIdx = resolver.resolveFunc(irRuntimeFuncRef("__iterator"));
        const iteratorNextIdx = resolver.resolveFunc(irRuntimeFuncRef("__iterator_next"));
        const iteratorReturnIdx = resolver.resolveFunc(irRuntimeFuncRef("__iterator_return"));

        // #1584 (a0-tail): out-of-subset (embeds an Instr[] loop body). S = Instr[].
        const wasmOut = requireInstrSink(out);

        // iter = __iterator(iterable)
        emitValue(instr.iterable, out);
        wasmOut.push({ op: "call", funcIdx: iteratorIdx });
        wasmOut.push({ op: "local.set", index: slotWasmIdx(instr.iterSlot) });

        // #2952 slice 2 — frames: outer block = break target (a break lands
        // just past the block, i.e. AT the __iterator_return close call
        // below — spec-correct IteratorClose on abrupt exit, §14.7.5); the
        // loop frame is the continue target (br-to-loop re-runs
        // __iterator_next — the advance happens at the loop top, so no
        // body-wrapping block is needed).
        const label = instr.loopLabel;
        // (slice 3) The break frame carries the iter slot so a br.label
        // CROSSING this loop (labeled break/continue of an outer loop)
        // closes the iterator on its way out.
        const iterCloseSlot = slotWasmIdx(instr.iterSlot);
        ctrlStack.push(
          label !== undefined ? { kind: "break", label, iterCloseSlot } : { kind: "plain", iterCloseSlot },
        );
        ctrlStack.push(label !== undefined ? { kind: "continue", label } : { kind: "plain" });

        // Build loop body Wasm ops.
        const loopBody: Instr[] = [];
        // __iterator_next(iter) → (i32 done, externref value) [multi-value]
        // (#1620 v2). Results push left-to-right ⇒ value (externref) is on top,
        // done (i32) below. Pop value into the element slot first, then done is
        // on top for the br_if exit test — no $IteratorResult struct round-trip.
        loopBody.push({ op: "local.get", index: slotWasmIdx(instr.iterSlot) });
        loopBody.push({ op: "call", funcIdx: iteratorNextIdx });
        loopBody.push({
          op: "local.set",
          index: slotWasmIdx(instr.elementSlot),
        }); // externref value (top)
        // if (done) br 1 (exit) — done (i32) is now on top of the stack
        // #1584 (a3): control-flow ops route through the trait.
        emitter.emitBrIf(1, loopBody as unknown as S);

        // Body instrs (same materialisation pattern as forof.vec).
        emitBufferAsStatements(instr.body, loopBody as unknown as S);

        // br 0 (continue)
        emitter.emitBr(0, loopBody as unknown as S);
        ctrlStack.pop(); // loop frame
        ctrlStack.pop(); // break frame

        // block { loop { ... } } via the trait (#1584 a3).
        const loopWrap: Instr[] = [];
        emitter.emitLoop({ kind: "empty" }, loopBody as unknown as S, loopWrap as unknown as S);
        emitter.emitBlock({ kind: "empty" }, loopWrap as unknown as S, wasmOut as unknown as S);

        // Loop-exit close: iter.return(iter). Runs on normal exit
        // (done=true) AND on `break` (#2952 slice 2 — the break br targets
        // the wrapping block, landing exactly here — IteratorClose §14.7.5).
        wasmOut.push({ op: "local.get", index: slotWasmIdx(instr.iterSlot) });
        wasmOut.push({ op: "call", funcIdx: iteratorReturnIdx });
        return;
      }
      // Slice 9 (#1169h) — exception handling.
      case "throw": {
        // Push the (already-coerced-to-externref) value, then `throw $exn`.
        // The from-ast layer guarantees `instr.value` has externref ValType.
        const tagIdx = resolver.ensureExnTag?.();
        if (tagIdx === undefined) {
          throw new Error(`ir/lower: resolver cannot resolve __exn tag for throw (${func.name})`);
        }
        emitValue(instr.value, out);
        // #1584 (a4): throw routes through the trait.
        emitter.emitThrow(tagIdx, out);
        return;
      }
      // #2952 slice 2 — unlabeled break/continue. Depth derived at emit time
      // by the ctrlStack resolver; crossed try-finallys are inlined before
      // the br. Verifier guarantees an enclosing loop binds the label.
      case "br.label": {
        resolveBrLabel(instr.label, instr.mode, out);
        return;
      }
      // #2952 slice 2 — statement-level if (void arms, else may be empty).
      // Each arm is one structured Wasm frame → one plain CtrlFrame so a
      // br.label inside an arm counts it toward its depth.
      case "if.stmt": {
        emitValue(instr.cond, out);
        const thenBody: S = emitter.newSink();
        ctrlStack.push({ kind: "plain" });
        emitBufferAsStatements(instr.then, thenBody);
        ctrlStack.pop();
        const elseBody: S = emitter.newSink();
        if (instr.else.length > 0) {
          ctrlStack.push({ kind: "plain" });
          emitBufferAsStatements(instr.else, elseBody);
          ctrlStack.pop();
        }
        // Empty-else encodes as a bare `if ... end` (binary.ts omits the
        // else opcode for an empty arm under an empty blocktype).
        emitter.emitIf({ kind: "empty" }, thenBody, elseBody, out);
        return;
      }
      // #2952 slice 4 — break-only labeled frame (`lbl: { ... break lbl; }`).
      // One Wasm block; the frame binds the label for mode "break" only.
      case "labeled.block": {
        const bodySink: S = emitter.newSink();
        ctrlStack.push({ kind: "break", label: instr.label });
        emitBufferAsStatements(instr.body, bodySink);
        ctrlStack.pop();
        emitter.emitBlock({ kind: "empty" }, bodySink, out);
        return;
      }
      // #2952 slice 4 — switch over literal tests: the block-per-case
      // ladder documented on IrInstrSwitch (nodes.ts). Dispatch is an
      // eq-chain (or br_table for a dense-int i32 disc); bodies are laid
      // out in source order so fallthrough is the natural block exit.
      case "switch": {
        // #1584 (a0-tail): out-of-subset — the dispatch chain embeds raw
        // i32/f64 consts + br_table, so S = Instr[] (same idiom as the
        // forof.* arms; the bytecode backend rejects `switch` in legality).
        requireInstrSink(out);
        const n = instr.bodies.length;
        // Evaluate the discriminant exactly once into its slot (§14.12.9).
        emitValue(instr.disc, out);
        emitter.emitLocalSet(slotWasmIdx(instr.discSlot), out);
        if (n === 0) return; // `switch (x) {}` — disc side effects only

        const discT = typeOf(instr.disc);
        const discK = asVal(discT)?.kind;
        if (discK !== "i32" && discK !== "f64") {
          throw new Error(`ir/lower: switch disc must be i32/f64, got ${discT.kind} (${func.name})`);
        }
        const defaultIdx = instr.tests.findIndex((t) => t === null);
        // From inside the dispatch (innermost) block: br k lands at the
        // start of bodies[k]; br n exits the switch entirely.
        const noMatchDepth = defaultIdx >= 0 ? defaultIdx : n;

        const dispatch: Instr[] = [];
        // br_table fast path: i32 disc, every test an int32, dense span.
        const nonNullTests = instr.tests.filter((t): t is number => t !== null);
        const allInt32 = nonNullTests.every((t) => Number.isInteger(t) && t >= -0x80000000 && t <= 0x7fffffff);
        const span = nonNullTests.length > 0 ? Math.max(...nonNullTests) - Math.min(...nonNullTests) + 1 : 0;
        const useBrTable = discK === "i32" && allInt32 && nonNullTests.length >= 2 && span <= 128;
        if (useBrTable) {
          const min = Math.min(...nonNullTests);
          const targets: number[] = new Array(span).fill(noMatchDepth);
          for (let k = 0; k < instr.tests.length; k++) {
            const t = instr.tests[k];
            if (t === null) continue;
            // First matching clause wins on duplicate tests (source order).
            if (targets[t - min] === noMatchDepth) targets[t - min] = k;
          }
          dispatch.push({ op: "local.get", index: slotWasmIdx(instr.discSlot) });
          if (min !== 0) {
            dispatch.push({ op: "i32.const", value: min });
            dispatch.push({ op: "i32.sub" });
          }
          dispatch.push({ op: "br_table", targets, defaultDepth: noMatchDepth });
        } else {
          for (let k = 0; k < instr.tests.length; k++) {
            const t = instr.tests[k]!;
            if (t === null) continue; // default: no comparison
            if (discK === "i32" && !Number.isInteger(t)) continue; // can never match an i32 disc
            dispatch.push({ op: "local.get", index: slotWasmIdx(instr.discSlot) });
            if (discK === "i32") {
              dispatch.push({ op: "i32.const", value: t });
              dispatch.push({ op: "i32.eq" });
            } else {
              dispatch.push({ op: "f64.const", value: t });
              dispatch.push({ op: "f64.eq" });
            }
            emitter.emitBrIf(k, dispatch as unknown as S);
          }
          emitter.emitBr(noMatchDepth, dispatch as unknown as S);
        }

        // Wrap the ladder inside-out; body k sits after block bk's end.
        // ctrl frames while emitting body k: the exit break-frame plus one
        // plain per still-open case block (b(k+1)..b(n-1)) — popped one per
        // step so depths derived by resolveBrLabel stay exact.
        ctrlStack.push({ kind: "break", label: instr.breakLabel });
        for (let i = 0; i < n - 1; i++) ctrlStack.push({ kind: "plain" });
        let cur: Instr[] = dispatch;
        for (let k = 0; k < n; k++) {
          const wrapped: Instr[] = [];
          emitter.emitBlock({ kind: "empty" }, cur as unknown as S, wrapped as unknown as S);
          emitBufferAsStatements(instr.bodies[k]!, wrapped as unknown as S);
          if (k < n - 1) ctrlStack.pop(); // close b(k+1)'s plain frame
          cur = wrapped;
        }
        ctrlStack.pop(); // break frame
        emitter.emitBlock({ kind: "empty" }, cur as unknown as S, out);
        return;
      }
      case "try": {
        // Build:
        //   try
        //     <body instrs>
        //     [<inline finally on normal exit>]
        //   catch $__exn          (when there's a source catch)
        //     local.set $payloadSlot   (or drop, when no binding)
        //     [<wrap catch body in inner try if finally exists>]
        //     <catch body>
        //     [<inline finally on normal exit>]
        //   catch_all              (when there's a finally)
        //     <inline finally>
        //     rethrow 0
        //   end
        const tagIdx = resolver.ensureExnTag?.();
        if (tagIdx === undefined) {
          throw new Error(`ir/lower: resolver cannot resolve __exn tag for try (${func.name})`);
        }

        // #1584 (a0-tail): out-of-subset — embeds Instr[] try/catch/finally
        // sub-buffers into a raw WasmGC `{op:"try"...}`. Assert S = Instr[].
        const wasmOut = requireInstrSink(out);

        // Helper: emit a body buffer (Instr[]) into a target out array,
        // honoring the SSA materialisation rules used by forof.vec. `target`
        // is a local Instr[] sub-buffer; the arm asserted S = Instr[] so the
        // cast to S on the recursive emit is sound (#1584 §2a).
        const emitBodyBuffer = (bodyInstrs: readonly IrInstr[], target: Instr[]): void => {
          for (const bodyInstr of bodyInstrs) {
            if (bodyInstr.result === null) {
              emitInstrTree(bodyInstr, target as unknown as S);
            } else if (crossBlock.has(bodyInstr.result)) {
              emitInstrTree(bodyInstr, target as unknown as S);
              target.push({
                op: "local.set",
                index: localIdx.get(bodyInstr.result)!,
              });
              materialized.add(bodyInstr.result);
            } else if ((totalUses.get(bodyInstr.result) ?? 0) === 0 && isSideEffecting(bodyInstr)) {
              // (#2856) Zero-use side-effecting instr — eager emit + drop,
              // same contract as `emitBlockBody` (see the if-arm variant).
              emitInstrTree(bodyInstr, target as unknown as S);
              emitter.emitDrop(target as unknown as S);
            }
            // Intra-block multi-use: handled via tee at use site.
          }
        };

        // #2952 slice 2 — one CtrlFrame for the try op (it is exactly one
        // Wasm label). The frame carries the ACTIVE finallyBody only while
        // the try-body buffer is emitted: a br.label crossing out of the try
        // body must inline the finally before its br. Everywhere else (the
        // finally's own inline emissions, the catch path) it is masked —
        // the catch path's finally obligations are owned by the dedicated
        // inner-try frame below, and a finally must never re-run itself.
        const tryFrame: { kind: "plain"; finallyBody?: readonly IrInstr[] | undefined } = {
          kind: "plain",
          finallyBody: instr.finallyBody,
        };
        ctrlStack.push(tryFrame);

        // Try body — emits user instrs + inlined finally on normal exit.
        const tryBody: Instr[] = [];
        emitBodyBuffer(instr.body, tryBody);
        tryFrame.finallyBody = undefined; // mask for all remaining emissions
        if (instr.finallyBody) {
          emitBodyBuffer(instr.finallyBody, tryBody);
        }

        // Catch handlers.
        const catches: { tagIdx: number; body: Instr[] }[] = [];
        let catchAll: Instr[] | undefined;

        if (instr.catchClause) {
          const catchBody: Instr[] = [];
          // Bind payload (or drop). Slot index === -1 means no binding.
          if (instr.catchClause.payloadSlot >= 0) {
            catchBody.push({
              op: "local.set",
              index: slotWasmIdx(instr.catchClause.payloadSlot),
            });
          } else {
            catchBody.push({ op: "drop" });
          }
          if (instr.finallyBody) {
            // Wrap user catch body in an inner try/catch_all so a throw
            // inside the catch body still runs finally before propagating.
            // #1584 (a4): the inner try + rethrow route through the trait.
            // #2952 slice 2 — the inner try is one more Wasm label; its
            // frame carries the finally while the catch body emits (a
            // br.label out of the catch must run the finally), masked while
            // the finally itself emits into the inner catch_all.
            const innerFrame: { kind: "plain"; finallyBody?: readonly IrInstr[] | undefined } = {
              kind: "plain",
              finallyBody: instr.finallyBody,
            };
            ctrlStack.push(innerFrame);
            const innerBody: Instr[] = [];
            emitBodyBuffer(instr.catchClause.body, innerBody);
            innerFrame.finallyBody = undefined;
            const innerCatchAll: Instr[] = [];
            emitBodyBuffer(instr.finallyBody, innerCatchAll);
            emitter.emitRethrow(0, innerCatchAll as unknown as S);
            ctrlStack.pop();
            emitter.emitTry(
              { kind: "empty" },
              innerBody as unknown as S,
              [],
              innerCatchAll as unknown as S,
              catchBody as unknown as S,
            );
            // Normal-exit from catch: inline finally.
            emitBodyBuffer(instr.finallyBody, catchBody);
          } else {
            emitBodyBuffer(instr.catchClause.body, catchBody);
          }
          catches.push({ tagIdx, body: catchBody });
        }

        if (instr.finallyBody) {
          // catch_all that runs finally and rethrows. Used both when
          // there's no source catch (try/finally only) AND when there
          // IS a source catch (the catch handles `__exn`; an unmatched
          // exception falls through to catch_all). Wasm's structured
          // try op evaluates catches in order — `catch __exn` matches
          // any of our throws (we only have one tag), so catch_all is
          // strictly the "leak" path for non-`__exn` exceptions
          // (out-of-memory, host runtime aborts, etc.). Slice 9 still
          // emits it because finally MUST run on EVERY exit path.
          const ca: Instr[] = [];
          emitBodyBuffer(instr.finallyBody, ca);
          emitter.emitRethrow(0, ca as unknown as S);
          catchAll = ca;
        }

        ctrlStack.pop(); // tryFrame

        // #1584 (a4): the structured try routes through the trait.
        emitter.emitTry(
          { kind: "empty" },
          tryBody as unknown as S,
          catches as unknown as { tagIdx: number; body: S }[],
          catchAll as unknown as S | undefined,
          wasmOut as unknown as S,
        );
        return;
      }
      // Slice 6 part 4 (#1183) — string for-of (native-strings mode).
      // Counter loop with `__str_charAt(str, i)`. The from-ast layer
      // ensures this case only runs in native-strings mode (host-strings
      // mode falls through to forof.iter).
      case "forof.string": {
        // (#1470) __str_charAt_cp — the code-POINT charAt. §22.1.5.1 String
        // iteration yields code points: a well-formed surrogate pair is ONE
        // 2-code-unit element. The cursor advances by the element's `len`
        // (1, or 2 for a pair) below instead of a fixed +1.
        const charAtIdx = resolver.resolveFunc(instr.provider ?? irIntrinsicFuncRef(IR_STRING_ITERATOR_CHAR_AT_FN));
        // The AnyString struct's `len` field is at index 0 (matches
        // `nativeStringType` in src/codegen/native-strings.ts).
        // We recover the typeIdx from the SSA value's IrType — must be
        // string-typed (resolveString() produces (ref $AnyString) in
        // native mode). The lowerer reads the resultType off the
        // defining instr or param.
        const strIrT = typeOf(instr.str);
        if (strIrT.kind !== "string") {
          throw new Error(`ir/lower: forof.string str must be IrType.string, got ${strIrT.kind} (${func.name})`);
        }
        const strRef = resolver.resolveString?.();
        if (!strRef || strRef.kind !== "ref") {
          throw new Error(`ir/lower: forof.string requires native-strings (resolveString()=ref) (${func.name})`);
        }
        const anyStrTypeIdx = (strRef as { typeIdx: number }).typeIdx;

        // #1584 (a0-tail): out-of-subset (embeds an Instr[] loop body). S = Instr[].
        const wasmOut = requireInstrSink(out);

        // #2952 slice 2 — frames: outer block = break target; loop frame is
        // plain (the code-point cursor advance runs AFTER the body, so a
        // continue targets a dedicated body-wrapping block — emitted only
        // when the body contains a continue for this loop).
        const label = instr.loopLabel;
        const needsContinueBlock = label !== undefined && bufferHasBrLabel(instr.body, label, "continue");
        ctrlStack.push(label !== undefined ? { kind: "break", label } : { kind: "plain" });
        ctrlStack.push({ kind: "plain" });

        // <emit str>; local.set <strSlot>
        emitValue(instr.str, out);
        wasmOut.push({ op: "local.set", index: slotWasmIdx(instr.strSlot) });

        // length = str.len  (struct field 0)
        wasmOut.push({ op: "local.get", index: slotWasmIdx(instr.strSlot) });
        wasmOut.push({ op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 });
        wasmOut.push({ op: "local.set", index: slotWasmIdx(instr.lengthSlot) });

        // counter = 0
        wasmOut.push({ op: "i32.const", value: 0 });
        wasmOut.push({
          op: "local.set",
          index: slotWasmIdx(instr.counterSlot),
        });

        // Build loop body Wasm ops.
        const loopBody: Instr[] = [];
        // if (counter >= length) br 1 (exit)
        loopBody.push({
          op: "local.get",
          index: slotWasmIdx(instr.counterSlot),
        });
        loopBody.push({
          op: "local.get",
          index: slotWasmIdx(instr.lengthSlot),
        });
        loopBody.push({ op: "i32.ge_s" });
        // #1584 (a3): control-flow ops route through the trait.
        emitter.emitBrIf(1, loopBody as unknown as S);

        // element = __str_charAt_cp(str, counter)
        loopBody.push({ op: "local.get", index: slotWasmIdx(instr.strSlot) });
        loopBody.push({
          op: "local.get",
          index: slotWasmIdx(instr.counterSlot),
        });
        loopBody.push({ op: "call", funcIdx: charAtIdx });
        loopBody.push({
          op: "local.set",
          index: slotWasmIdx(instr.elementSlot),
        });

        // Body instrs (same materialisation pattern as forof.vec/forof.iter;
        // continue block falls through to the cursor advance below).
        if (needsContinueBlock) {
          const bodyOps: Instr[] = [];
          ctrlStack.push({ kind: "continue", label: label! });
          emitBufferAsStatements(instr.body, bodyOps as unknown as S);
          ctrlStack.pop();
          emitter.emitBlock({ kind: "empty" }, bodyOps as unknown as S, loopBody as unknown as S);
        } else {
          emitBufferAsStatements(instr.body, loopBody as unknown as S);
        }

        // counter = counter + element.len — the element is the whole code
        // point (1 code unit, or 2 for a surrogate pair), and it is never
        // empty inside the bounds-checked loop, so this always advances.
        loopBody.push({
          op: "local.get",
          index: slotWasmIdx(instr.counterSlot),
        });
        loopBody.push({
          op: "local.get",
          index: slotWasmIdx(instr.elementSlot),
        });
        loopBody.push({ op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 });
        loopBody.push({ op: "i32.add" });
        loopBody.push({
          op: "local.set",
          index: slotWasmIdx(instr.counterSlot),
        });

        // br 0 (continue)
        emitter.emitBr(0, loopBody as unknown as S);
        ctrlStack.pop(); // loop frame
        ctrlStack.pop(); // break frame

        // block { loop { ... } } via the trait (#1584 a3).
        const loopWrap: Instr[] = [];
        emitter.emitLoop({ kind: "empty" }, loopBody as unknown as S, loopWrap as unknown as S);
        emitter.emitBlock({ kind: "empty" }, loopWrap as unknown as S, wasmOut as unknown as S);
        return;
      }
      // Slice 10 (#1169i) — extern class ops. All five forms delegate to
      // host imports registered by the legacy `collectUsedExternImports`
      // pass (see `src/codegen/index.ts:6114`), which scans the AST
      // before the IR runs. By the time we reach this case, the funcMap
      // contains stable indices for `<className>_new`,
      // `<className>_<method>`, and `<className>_get_<prop>` /
      // `<className>_set_<prop>`. The resolver's `resolveFunc` looks
      // them up by name.
      case "extern.new": {
        const importName = `${instr.importPrefix}_new`;
        const fn = resolver.resolveFunc(instr.provider ?? irImportFuncRef("env", importName));
        for (const a of instr.args) emitValue(a, out);
        emitter.pushRaw(out, { op: "call", funcIdx: fn });
        return;
      }
      case "extern.call": {
        const importName = `${instr.className}_${instr.method}`;
        const fn = resolver.resolveFunc(instr.provider ?? irImportFuncRef("env", importName));
        emitValue(instr.receiver, out);
        for (const a of instr.args) emitValue(a, out);
        emitter.pushRaw(out, { op: "call", funcIdx: fn });
        return;
      }
      case "extern.prop": {
        const importName = `${instr.className}_get_${instr.property}`;
        const fn = resolver.resolveFunc(instr.provider ?? irImportFuncRef("env", importName));
        emitValue(instr.receiver, out);
        emitter.pushRaw(out, { op: "call", funcIdx: fn });
        return;
      }
      case "extern.propSet": {
        const importName = `${instr.className}_set_${instr.property}`;
        const fn = resolver.resolveFunc(instr.provider ?? irImportFuncRef("env", importName));
        emitValue(instr.receiver, out);
        emitValue(instr.value, out);
        emitter.pushRaw(out, { op: "call", funcIdx: fn });
        return;
      }
      case "extern.regex": {
        // Mirror the legacy `compileRegExpLiteral` pattern (see
        // `src/codegen/typeof-delete.ts:158`):
        //   <emit pattern as string literal>
        //   <emit flags as string literal>
        //   call $RegExp_new
        // The resolver's `emitStringConst` takes care of host-strings vs
        // native-strings — the host-strings backend uses `global.get` of
        // a pre-registered string global; native-strings inlines the
        // `array.new_fixed` + `struct.new`. Both produce a Wasm value
        // compatible with the `RegExp_new` import's externref params.
        const patternOps = resolver.emitStringConst?.(instr.pattern);
        if (!patternOps) {
          throw new Error(`ir/lower: resolver cannot emit string.const for regex pattern (${func.name})`);
        }
        for (const o of patternOps) emitter.pushRaw(out, o);
        const flagsOps = resolver.emitStringConst?.(instr.flags);
        if (!flagsOps) {
          throw new Error(`ir/lower: resolver cannot emit string.const for regex flags (${func.name})`);
        }
        for (const o of flagsOps) emitter.pushRaw(out, o);
        const fn = resolver.resolveFunc(irImportFuncRef("env", "RegExp_new"));
        emitter.pushRaw(out, { op: "call", funcIdx: fn });
        return;
      }
      // Slice 12 (#1280) — generic structured loops. Both kinds emit
      //   block { loop { <cond>; <push condValue>; i32.eqz; br_if 1;
      //                  <body>; <update?>; br 0 } }
      // The body / cond / update buffers each follow the same
      // SSA-materialisation rules as `forof.vec.body` (cross-block
      // values get pre-materialised; void / intra-block-only values
      // are emitted in place).
      case "while.loop":
      case "for.loop": {
        // #3297: generic structured-control-flow path. Nested buffers stay in
        // the backend's own sink type; no raw Instr[] or Wasm-only eqz push is
        // required for scalar loops.
        const loopBody: S = emitter.newSink();

        // Helper: emit a body buffer (cond / body / update) into a
        // backend sink using the standard SSA materialisation rules (mirrors
        // the `forof.*` body emission).
        const emitBodyBuffer = (bodyInstrs: readonly IrInstr[], target: S): void => {
          for (const bodyInstr of bodyInstrs) {
            if (bodyInstr.result === null) {
              emitInstrTree(bodyInstr, target);
            } else if (crossBlock.has(bodyInstr.result)) {
              emitInstrTree(bodyInstr, target);
              emitter.emitLocalSet(localIdx.get(bodyInstr.result)!, target);
              materialized.add(bodyInstr.result);
            } else if ((totalUses.get(bodyInstr.result) ?? 0) === 0 && isSideEffecting(bodyInstr)) {
              // (#2856) Zero-use side-effecting instr — eager emit + drop,
              // same contract as `emitBlockBody` (see the if-arm variant).
              emitInstrTree(bodyInstr, target);
              emitter.emitDrop(target);
            }
            // Intra-block multi-use: handled at use site via tee pattern.
          }
        };

        // #2952 slice 1 — `do { body } while (cond)` is a post-test loop:
        // the body runs BEFORE the first cond check (runs at least once). It
        // reuses the `while.loop` kind with `postCond: true`; only the
        // emission order flips (body → cond-check), so the wrapping
        // `block { loop { ... br 0 } }` and the `br_if 1` exit are identical.
        const postTest = instr.kind === "while.loop" && instr.postCond === true;

        // #2952 slice 2 — CtrlFrames for the two frames this arm opens
        // (outer `block` = break target; inner `loop`). For a pre-test
        // `while`, br-to-loop re-evaluates the cond, so the loop frame IS
        // the continue target. For post-test (do-while) and `for`, a
        // continue must fall into the cond / update code that runs AFTER
        // the body, so the body is wrapped in a dedicated `block` (the
        // continue target) — emitted only when the body actually contains
        // a continue for this loop, keeping continue-free loops
        // byte-identical to the slice-1 emission.
        const label = instr.loopLabel;
        const preTestWhile = instr.kind === "while.loop" && !postTest;
        const needsContinueBlock =
          label !== undefined && !preTestWhile && bufferHasBrLabel(instr.body, label, "continue");
        ctrlStack.push(label !== undefined ? { kind: "break", label } : { kind: "plain" });
        ctrlStack.push(preTestWhile && label !== undefined ? { kind: "continue", label } : { kind: "plain" });
        const emitLoopBodyStatements = (): void => {
          if (needsContinueBlock) {
            const bodyOps: S = emitter.newSink();
            ctrlStack.push({ kind: "continue", label: label! });
            emitBodyBuffer(instr.body, bodyOps);
            ctrlStack.pop();
            emitter.emitBlock({ kind: "empty" }, bodyOps, loopBody);
          } else {
            emitBodyBuffer(instr.body, loopBody);
          }
        };

        if (postTest) {
          // Post-test: body first, then evaluate cond and exit if falsy.
          // 1. Body instructions (continue falls through to the cond).
          emitLoopBodyStatements();
          // 2. Cond instructions (re-evaluated each iteration, after body).
          emitBodyBuffer(instr.cond, loopBody);
          // 3. Push the cond value, invert (i32.eqz), then br_if 1 to exit.
          emitValue(instr.condValue, loopBody);
          emitter.emitUnary("i32.eqz", loopBody);
          emitter.emitBrIf(1, loopBody);
        } else {
          // Pre-test (`while` / `for`): cond first, exit before running body.
          // 1. Cond instructions (re-evaluated each iteration).
          emitBodyBuffer(instr.cond, loopBody);

          // 2. Push the cond value, invert (i32.eqz), then br_if 1 to exit.
          //    #1584 (a3): the control-flow ops route through the trait.
          emitValue(instr.condValue, loopBody);
          emitter.emitUnary("i32.eqz", loopBody);
          emitter.emitBrIf(1, loopBody);

          // 3. Body instructions (for `for`, continue falls to the update).
          emitLoopBodyStatements();

          // 4. Update instructions (for-loop only — empty array for while).
          if (instr.kind === "for.loop") {
            emitBodyBuffer(instr.update, loopBody);
          }
        }

        // 5. Continue back to the loop header.
        emitter.emitBr(0, loopBody);
        ctrlStack.pop(); // loop frame
        ctrlStack.pop(); // break frame

        // 6. Wrap in `block { loop { ... } }` via the trait (#1584 a3).
        const loopWrap: S = emitter.newSink();
        emitter.emitLoop({ kind: "empty" }, loopBody, loopWrap);
        emitter.emitBlock({ kind: "empty" }, loopWrap, out);
        return;
      }
      // (#1373b Phase C) Async / await IR node lowering.
      //
      // C-1 model: the IR claims only the SYNC-PASS-THROUGH async
      // population (the ONE engine — the #2906 $AsyncFrame machine —
      // declines them; see `asyncEngineClaims` in select.ts). `await`
      // lowers per lane below. `async.return` / `async.throw` are NOT
      // emitted by from-ast in C-1 (returns stay plain `return` — the raw-T
      // #1796 contract); their settled-`$Promise` mint arms are retained
      // for C-3, where the IR lowers engine-activated functions onto the
      // frame machine and returns settle the frame's result promise. See
      // plan/issues/1373b-ir-async-cps-lowering.md (Implementation Plan).
      case "async.return": {
        const promiseTypeIdx = resolver.resolvePromiseType?.();
        if (promiseTypeIdx === undefined) {
          throw new Error(
            "ir/lower: async.return requires resolver.resolvePromiseType (#1373b Slice 1) — not wired for this backend",
          );
        }
        // Stack effect: → externref ($Promise wrapped in extern)
        emitter.pushRaw(out, {
          op: "i32.const",
          value: PROMISE_STATE_FULFILLED,
        });
        emitValue(instr.value, out);
        emitter.emitNull({ kind: "val", val: { kind: "externref" } }, out);
        emitter.emitPromiseNew(promiseTypeIdx, out);
        emitter.emitToExternref(out);
        return;
      }
      case "async.throw": {
        const promiseTypeIdx = resolver.resolvePromiseType?.();
        if (promiseTypeIdx === undefined) {
          throw new Error(
            "ir/lower: async.throw requires resolver.resolvePromiseType (#1373b Slice 1) — not wired for this backend",
          );
        }
        // Stack effect: → externref ($Promise wrapped in extern, REJECTED state)
        emitter.pushRaw(out, {
          op: "i32.const",
          value: PROMISE_STATE_REJECTED,
        });
        emitValue(instr.reason, out);
        emitter.emitNull({ kind: "val", val: { kind: "externref" } }, out);
        emitter.emitPromiseNew(promiseTypeIdx, out);
        emitter.emitToExternref(out);
        return;
      }
      case "await": {
        // (#1373b C-1) Sync-pass-through await, per lane:
        //
        //   - JS-host (no native carrier): IDENTITY — under the legacy
        //     synchronous async model the operand already IS the value (the
        //     #1796 call-site consumption contract owns Promise wrapping),
        //     and host promises are opaque host objects the wasm side cannot
        //     inspect. Mirrors the legacy AwaitExpression passthrough in
        //     expressions.ts.
        //
        //   - Native-`$Promise` carrier (wasi): one-level GUARDED unwrap —
        //     mirrors `emitStandaloneAwaitUnwrap` (expressions.ts) EXACTLY;
        //     keep the two in lockstep. `ref.test $Promise` discriminates: a
        //     non-`$Promise` externref (plain value / null / non-native
        //     thenable) passes through unchanged; a `$Promise` yields its
        //     `value` field regardless of state (pending → null — the AG0
        //     synchronous-settlement model). Genuine suspension is the ONE
        //     engine's job; engine-activated fns are never IR-claimed
        //     (`asyncEngineClaims` gate in select.ts), so this arm only ever
        //     sees the sync-model population.
        if (resolver.nativePromiseCarrierActive?.() !== true) {
          emitValue(instr.operand, out);
          return;
        }
        const promiseTypeIdx = resolver.resolvePromiseType?.();
        if (promiseTypeIdx === undefined) {
          throw new Error(
            "ir/lower: await on the native-Promise carrier lane requires resolver.resolvePromiseType (#1373b C-1)",
          );
        }
        // #1584 (a0-tail): out-of-subset — raw WasmGC ref.test/if sequence.
        const wasmOut = requireInstrSink(out);
        emitValue(instr.operand, out);
        // Scratch externref local, allocated lazily on the first await and
        // reused by subsequent awaits in the same function body.
        if (awaitScratchPromiseIdx === null) {
          awaitScratchPromiseIdx = func.params.length + locals.length;
          locals.push({
            name: "$await_operand",
            type: { kind: "externref" },
            logicalType: { kind: "val", val: { kind: "externref" } },
          });
        }
        wasmOut.push({ op: "local.set", index: awaitScratchPromiseIdx });
        wasmOut.push({ op: "local.get", index: awaitScratchPromiseIdx });
        wasmOut.push({ op: "any.convert_extern" });
        wasmOut.push({ op: "ref.test", typeIdx: promiseTypeIdx });
        wasmOut.push({
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } as ValType },
          then: [
            { op: "local.get", index: awaitScratchPromiseIdx },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: promiseTypeIdx },
            // $Promise field 1 = `value` (externref). See getOrRegisterPromiseType.
            { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 1 },
          ],
          else: [{ op: "local.get", index: awaitScratchPromiseIdx }],
        });
        return;
      }
      // (#4070) Exhaustiveness gate — the highest-severity one in the IR.
      // This switch returns `void`, so nothing in the type system forced it to
      // be total: a new IR instruction kind without a case here used to fall
      // straight through and emit NO instructions, silently producing wrong
      // Wasm (a missing operand on the stack) rather than any error at all.
      // The `never` assignment turns that into a compile error at this line.
      default: {
        const _exhaustive: never = instr;
        void _exhaustive;
        // invariant (producer-promise): every IrInstr the selector claims must
        // have a lowering arm. Per #4035/#4502 a bare `Error` is the deliberate
        // hard-error classification — an un-lowerable kind is a broken promise
        // between the union and the emitter, not a capability gap to demote.
        throw new Error(
          `ir/lower: emitInstrTree has no case for IR instruction kind ${(instr as { readonly kind: string }).kind}`,
        );
      }
    }
  };

  const emitBlockBody = (block: IrBlock, out: S): void => {
    for (const instr of block.instrs) {
      if (instr.result === null) {
        // Void-producing instrs (global.set, raw.wasm with no result).
        emitInstrTree(instr, out);
        continue;
      }
      if (crossBlock.has(instr.result) || anchorEager.has(instr.result)) {
        // Pre-materialize for successor blocks (crossBlock) or because the
        // value's tree observes mutable state that a later instruction in
        // this block writes before the use site (#1982 anchorEager).
        // `local.set` is a trait primitive (emitLocalSet) — byte-identical
        // on WasmGC, OP.STORE on bytecode.
        emitInstrTree(instr, out);
        emitter.emitLocalSet(localIdx.get(instr.result)!, out);
        materialized.add(instr.result);
        continue;
      }
      // #1267 — side-effecting instr whose result is unused (e.g. a
      // method call in expression-statement position: `c.bump();`).
      // The lazy-emission pattern below only fires at a USE SITE; if the
      // result has zero uses, the instruction (and its observable side
      // effect) gets silently dropped. For side-effecting kinds —
      // `class.call`, `extern.call`, `call`, `closure.call`, etc. (see
      // dead-code.ts:isSideEffecting) — we eagerly emit the instruction
      // and follow with a Wasm `drop` so the produced value is removed
      // from the operand stack. The DCE pass already keeps these instrs
      // live in the IR; this is the matching emission contract.
      const useCount = totalUses.get(instr.result) ?? 0;
      if (useCount === 0 && isSideEffecting(instr)) {
        emitInstrTree(instr, out);
        emitter.emitDrop(out);
      }
      // Intra-block-only with at least one use: single-use inlines at
      // use site, multi-use uses the lazy-tee pattern at first
      // reference. Skip emission here.
    }

    const t = block.terminator;
    switch (t.kind) {
      case "return":
        for (const v of t.values) emitValue(v, out);
        emitter.emitReturn(out);
        return;
      case "br_if": {
        if (t.ifTrue.args.length !== 0 || t.ifFalse.args.length !== 0) {
          throw new Error(`ir/lower: Phase 1 br_if does not support branch args (${func.name})`);
        }
        const thenBlock = func.blocks[t.ifTrue.target as number];
        const elseBlock = func.blocks[t.ifFalse.target as number];
        if (!thenBlock || !elseBlock) {
          throw new Error(`ir/lower: br_if target missing in ${func.name}`);
        }
        emitValue(t.condition, out);
        // #1584 (a0-tail): each branch arm is built into its own sink and
        // handed to `emitIf` (which realizes the structured `if` per backend) —
        // the same drive shape the value-producing `if` instr uses.
        const thenOps: S = emitter.newSink();
        const elseOps: S = emitter.newSink();
        // #2856: the two arms are SEPARATE runtime paths, and the
        // structurizer tail-duplicates a shared successor block into each arm
        // (a converging mid-body `if` guard reaches its continuation from both
        // the then-block's `br` and this `br_if`'s false edge — see
        // `lowerStatementList`'s non-terminating-if rewrite in from-ast.ts).
        // `materialized` tracks "this value's local has been assigned on the
        // CURRENT path"; it is function-global. An intra-block multi-use value
        // defined in the duplicated successor is lazily tee'd on first use, so
        // the then-arm copy marks it materialized — then the else-arm copy sees
        // it as already-materialized and reads a local the else path never set
        // (a silent 0, or an "undefined SSA value" throw for a cross-block
        // def). Snapshot at the branch and restore before the else arm (and
        // after the `if`) so each path re-materializes its own locals. Values
        // materialized BEFORE the branch (on `out`) stay live in both arms.
        const preBranchMaterialized = new Set(materialized);
        const restoreMaterialized = (): void => {
          materialized.clear();
          for (const v of preBranchMaterialized) materialized.add(v);
        };
        emitBlockBody(thenBlock, thenOps);
        restoreMaterialized();
        emitBlockBody(elseBlock, elseOps);
        restoreMaterialized();
        const blockType: BlockType = { kind: "empty" };
        emitter.emitIf(blockType, thenOps, elseOps, out);
        return;
      }
      case "br": {
        // Unconditional branch — inline the successor block body. Same
        // pattern as the br_if arms above: emit the target block's instrs
        // + terminator directly, no structured `if` wrapper needed since
        // the branch is unconditional. This was added in #1167a so CF can
        // rewrite `br_if(const true, A, B)` to `br(A)` without crashing the
        // lowerer.
        if (t.branch.args.length !== 0) {
          throw new Error(`ir/lower: Phase 1-3 br does not support branch args (${func.name})`);
        }
        const target = func.blocks[t.branch.target as number];
        if (!target) {
          throw new Error(`ir/lower: br target missing in ${func.name}`);
        }
        emitBlockBody(target, out);
        return;
      }
      case "unreachable":
        emitter.emitUnreachable(out);
        return;
    }
  };

  const body: S = emitter.newSink();
  emitBlockBody(func.blocks[0], body);
  // A br_if-terminated entry leaves fallthrough after the structured `if`.
  // Wasm's validator requires the function body to end with an op that
  // produces the return-type-shape on stack — `unreachable` is polymorphic
  // and satisfies that contract without emitting a real value.
  //
  // #1584 (a0-tail): this trailing-op fix-up inspects the last emitted `Instr`
  // (`.op === "return"`), which is a WasmGC-shaped peek. It applies only when
  // S = Instr[] (`Array.isArray`). On a non-`Instr[]` sink (bytecode), an
  // in-subset function's entry block ends in a `return` terminator, so no
  // trailing `unreachable` is needed; a function that didn't would surface the
  // missing terminal downstream, not here.
  if (Array.isArray(body)) {
    const wasmBody = body;
    const last = wasmBody[wasmBody.length - 1];
    if (!last || last.op !== "return") {
      emitter.emitUnreachable(body);
    }
  }

  const convertSlots = (type: IrType, where: string): readonly Slot[] => {
    const slots = typeConverter.convertType(type);
    if (slots.length === 0) {
      throw new Error(`ir/lower: ${emitter.backend} type converter produced no slots for ${where} in ${func.name}`);
    }
    return [...slots];
  };

  return {
    name: func.name,
    body,
    params: func.params.map((param) => ({
      name: param.name,
      slots: convertSlots(param.type, `param ${param.name}`),
    })),
    locals: locals.map((local) => ({
      name: local.name,
      slots: convertSlots(local.logicalType, `local ${local.name}`),
    })),
    results: func.resultTypes.map((type, index) => convertSlots(type, `result ${index}`)),
    exported: func.exported,
  };
}

function collectIrUses(instr: IrInstr): readonly IrValueId[] {
  switch (instr.kind) {
    case "const":
      return [];
    case "call":
      return instr.args;
    case "intrinsic":
      return instr.args;
    case "global.get":
      return [];
    case "global.set":
      return [instr.value];
    case "binary":
      return [instr.lhs, instr.rhs];
    case "unary":
      return [instr.rand];
    case "select":
      return [instr.condition, instr.whenTrue, instr.whenFalse];
    case "if":
      // (#1392) Surface only the cond at top level. Arm-buffer uses of
      // OUTER SSA values are surfaced separately via collectForOfBodyUses
      // so the cross-block / multi-use counters properly materialise
      // them in Wasm locals before the if-instr emits.
      return [instr.cond];
    case "raw.wasm":
      return [];
    case "box":
    case "unbox":
    case "tag.test":
    case "dyn.truthy":
    case "dyn.to_number":
      return [instr.value];
    case "dyn.eq":
      return [instr.lhs, instr.rhs];
    case "dyn.member_get":
      return [instr.recv, instr.key];
    case "dyn.member_set":
      return [instr.recv, instr.key, instr.value];
    case "string.const":
      return [];
    case "string.concat":
    case "string.eq":
      return [instr.lhs, instr.rhs];
    case "string.len":
      return [instr.value];
    case "string.char_at":
    case "string.char_code_at":
      return [instr.value, instr.index];
    case "object.new":
      return instr.values;
    case "object.get":
      return [instr.value];
    case "object.set":
      return [instr.value, instr.newValue];
    // Slice 3 (#1169c): closure / ref-cell ops.
    case "closure.new":
      return instr.captures;
    case "closure.cap":
      return [instr.self];
    case "closure.call":
      // INTENTIONAL DOUBLE COUNT for `callee`: the Wasm emission pattern
      // pushes the closure value twice (once as the implicit __self
      // argument, once as the source of the funcref struct.get). The
      // use-counter must see TWO uses so the closure value gets a Wasm
      // local — otherwise we'd re-emit the (potentially side-effecting)
      // closure subtree. The verifier's collectUses counts it ONCE
      // because that's a pure SSA def→use relationship.
      return [instr.callee, ...instr.args, instr.callee];
    case "refcell.new":
      return [instr.value];
    case "refcell.get":
      return [instr.cell];
    case "refcell.set":
      return [instr.cell, instr.value];
    // Slice 4 (#1169d): class ops.
    case "class.new":
      return instr.args;
    case "class.get":
      return [instr.value];
    case "class.set":
      return [instr.value, instr.newValue];
    case "class.call":
      return [instr.receiver, ...instr.args];
    case "class.super_init":
      return [...instr.args, instr.self];
    case "class.super_call":
      return [instr.receiver, ...instr.args];
    case "class.instanceof":
      return [instr.value];
    case "class.static_call":
      return instr.args;
    // Slice 6 (#1169e): slot / vec / for-of ops.
    case "slot.read":
      return [];
    case "slot.write":
      return [instr.value];
    case "vec.len":
      return [instr.vec];
    case "vec.get":
      return [instr.vec, instr.index];
    case "vec.set":
      return [instr.vec, instr.index, instr.newValue];
    case "vec.set_length":
      return [instr.vec, instr.length];
    case "vec.new_fixed":
      return instr.elements; // #1804
    case "forof.vec":
      // Body uses are collected separately and merged in by
      // `lowerIrFunctionToWasm`.
      return [instr.vec];
    // Slice 6 part 3 (#1182) — coercion + iterator protocol ops.
    case "coerce.to_externref":
      return [instr.value];
    case "iter.new":
      return [instr.iterable];
    case "iter.next":
      return [instr.iter];
    case "iter.done":
      return [instr.resultObj];
    case "iter.value":
      return [instr.resultObj];
    case "iter.return":
      return [instr.iter];
    case "forof.iter":
      // Same rationale as forof.vec — body uses surfaced separately.
      return [instr.iterable];
    // Slice 7a (#1169f): generator ops.
    case "gen.push":
      return [instr.value];
    case "gen.epilogue":
      // No SSA operand uses — buffer + pendingThrow are read from Wasm
      // locals (slot indices stored on the IrFunction).
      return [];
    // Slice 7b (#1169f): yield* delegation.
    case "gen.yieldStar":
      return [instr.inner];
    // #2951 — generator `return <value>` stash.
    case "gen.setReturn":
      return [instr.value];
    // Slice 6 part 4 (#1183) — string for-of.
    case "forof.string":
      return [instr.str];
    // Slice 9 (#1169h) — exception handling.
    case "throw":
      return [instr.value];
    case "try":
      // Body / catch / finally buffer uses are surfaced separately via
      // `collectForOfBodyUses` (recurses into try buffers).
      return [];
    // Slice 10 (#1169i) — extern class ops.
    case "extern.new":
      return instr.args;
    case "extern.call":
      return [instr.receiver, ...instr.args];
    case "extern.prop":
      return [instr.receiver];
    case "extern.propSet":
      return [instr.receiver, instr.value];
    case "extern.regex":
      return [];
    // Slice 12 (#1280) — generic structured loops. Body / cond / update
    // buffer uses are surfaced separately via `collectForOfBodyUses`.
    case "while.loop":
    case "for.loop":
      return [];
    // #2952 slice 2 — br.label has no SSA operands; if.stmt surfaces only
    // its cond (arm-buffer uses via `collectForOfBodyUses`, like `if`).
    case "br.label":
      return [];
    case "if.stmt":
      return [instr.cond];
    // #2952 slice 4 — labeled.block has no operands; switch surfaces its
    // disc (clause-buffer uses via `collectForOfBodyUses`).
    case "labeled.block":
      return [];
    case "switch":
      return [instr.disc];
    // (#1373 Phase B) Async / await IR nodes — type-only in this slice.
    // The lowering Phase C (#1373b) will inflate these into CPS-form
    // microtask-queue calls; until then they're never emitted by
    // from-ast and never reach the lowerer.
    case "await":
      return [instr.operand];
    case "async.return":
      return [instr.value];
    case "async.throw":
      return [instr.reason];
    // (#2856) Early return — the optional return value is a direct use.
    case "early.return":
      return instr.value !== null ? [instr.value] : [];
    // (#4070) Exhaustiveness gate. Under-reporting an instruction's uses would
    // corrupt the lowerer's use accounting (which decides what gets a Wasm
    // local), so the runtime arm throws rather than returning `[]`.
    default: {
      const _exhaustive: never = instr;
      void _exhaustive;
      // invariant (producer-promise): see emitInstrTree's twin above.
      throw new Error(
        `ir/lower: collectIrUses has no case for IR instruction kind ${(instr as { readonly kind: string }).kind}`,
      );
    }
  }
}

/**
 * #2952 slice 2 — does `body` (deeply) contain a `br.label` with the given
 * label + mode? Used by the loop-lowering arms to decide whether to emit the
 * dedicated continue-target block: labels are unique per function, so the
 * deep scan is exact — a nested loop's own continues carry its own label and
 * never match. Continue-free loops therefore stay byte-identical.
 */
export function bufferHasBrLabel(body: readonly IrInstr[], label: IrLabelId, mode: "break" | "continue"): boolean {
  let found = false;
  for (const instr of body) {
    forEachInstrDeep(instr, (i) => {
      if (i.kind === "br.label" && i.label === label && i.mode === mode) found = true;
    });
    if (found) return true;
  }
  return false;
}

/**
 * Slice 6 (#1169e): walk a `forof.vec` body recursively and collect every
 * SSA value referenced. Used by the cross-block use counter to ensure
 * outer-scope values used inside the loop body are materialised in Wasm
 * locals before the loop starts.
 */
export function collectForOfBodyUses(body: readonly IrInstr[]): IrValueId[] {
  const uses: IrValueId[] = [];
  for (const instr of body) {
    // Direct operands first. `collectIrUses` keeps the lowering-specific
    // semantics (the intentional `closure.call` callee double-count for
    // Wasm-local materialisation), so it is NOT replaced by the shared
    // `directUses`.
    for (const u of collectIrUses(instr)) uses.push(u);
    // Recurse into every nested buffer via the single shared authority
    // (#1922 — was five hand-rolled per-kind walkers). Buffer order matches
    // the previous code (loop cond→body→update; if then→else; try
    // body→catch→finally; for-of body).
    forEachNestedBuffer(instr, (buffer) => {
      for (const u of collectForOfBodyUses(buffer)) uses.push(u);
    });
    // `collectIrUses` deliberately omits the loop condValue and the if
    // arm-result values (they are emission-internal, surfaced only here so
    // the cross-block use counter materialises outer SSA values referenced
    // by a loop's condition or an if arm). Push them after the buffer walk,
    // preserving the original ordering.
    if (instr.kind === "while.loop" || instr.kind === "for.loop") {
      uses.push(instr.condValue);
    } else if (instr.kind === "if") {
      uses.push(instr.thenValue);
      uses.push(instr.elseValue);
    }
  }
  return uses;
}

function collectTerminatorUses(block: IrBlock): readonly IrValueId[] {
  const t = block.terminator;
  switch (t.kind) {
    case "return":
      return t.values;
    case "br":
      return t.branch.args;
    case "br_if":
      return [t.condition, ...t.ifTrue.args, ...t.ifFalse.args];
    case "unreachable":
      return [];
  }
}

/**
 * Lower an IrType to the Wasm ValType carried in function signatures / locals.
 *
 * For `val` IrTypes this is identity. For `union` / `boxed` IrTypes we ask
 * the resolver for the corresponding WasmGC struct type and wrap as a `ref`
 * to that struct. Throws if the resolver cannot lower the type — callers must
 * reject such IR before reaching this function.
 */
/**
 * #1926 — unwrap a `union` member / `boxed`-`refcell` inner IrType to the
 * concrete backend ValType the legacy union / ref-cell registries key on.
 *
 * V1 unions admit only scalar (`f64`/`i32`) members and ref cells only box
 * primitives, so every member / inner here is a `val`-kind IrType. We assert
 * that explicitly: a non-`val` member means an upstream pass admitted a
 * symbolic kind into a union/box the backend registries can't key on, which
 * is a selector bug — failing loud here is correct (and matches the existing
 * "resolver cannot lower …" throws).
 */
function memberValType(t: IrType, funcName: string): ValType {
  const v = asVal(t);
  if (!v) {
    throw new Error(`ir/lower: union/boxed member must be a val-kind IrType, got ${t.kind} (${funcName})`);
  }
  return v;
}

export function lowerIrTypeToValType(t: IrType, resolver: IrLowerResolver, funcName: string): ValType {
  if (t.kind === "val") {
    if (!t.typeRef) return t.val;
    if (t.val.kind !== "ref" && t.val.kind !== "ref_null") {
      throw new Error(`ir/lower: symbolic physical type ref is attached to non-reference ${t.val.kind} (${funcName})`);
    }
    return { kind: t.val.kind, typeIdx: resolver.resolveType(t.typeRef) };
  }
  // #3214 B0 — source-level callable boundaries use the same externref ABI as
  // legacy callbacks. The signature remains in IrType for exact unpack/call
  // lowering; it has no distinct Wasm parameter representation.
  if (t.kind === "callable") return { kind: "externref" };
  if (t.kind === "string") {
    const sty = resolver.resolveString?.();
    if (!sty) {
      throw new Error(`ir/lower: resolver cannot lower string IrType (${funcName})`);
    }
    return sty;
  }
  if (t.kind === "vec") {
    const elementValType = lowerIrTypeToValType(t.elementType, resolver, funcName);
    if (t.layout) {
      return {
        kind: t.nullable ? "ref_null" : "ref",
        typeIdx: resolver.resolveType(t.layout.carrierType),
      };
    }
    const vec = resolver.resolveVecForElement?.(elementValType);
    if (!vec) throw new Error(`ir/lower: resolver cannot lower vec IrType (${funcName})`);
    return vec.valueType ?? { kind: t.nullable ? "ref_null" : "ref", typeIdx: vec.vecStructTypeIdx };
  }
  if (t.kind === "object") {
    // Object IrTypes always lower to a (ref $struct) — mutability of the
    // backing reference is decided by the caller (locals/params get a
    // non-null ref since `object.new` produces a definite struct; field
    // slots get a ref_null in the struct definition itself, see
    // `ObjectStructRegistry.resolve`).
    const obj = resolver.resolveObject?.(t.shape);
    if (!obj) {
      throw new Error(`ir/lower: resolver cannot lower object<${describeShape(t.shape)}> (${funcName})`);
    }
    return { kind: "ref", typeIdx: obj.typeIdx };
  }
  if (t.kind === "closure") {
    // Slice 3 / #3214 B0: allocation still resolves the per-signature wrapper,
    // but closure SSA values and lifted `__self` use the canonical root. The
    // same signature can be the root in one separately compiled module and a
    // child in another, so its allocation wrapper is not an ABI-stable carrier.
    const cl = resolver.resolveClosure?.(t.signature);
    if (!cl) {
      throw new Error(`ir/lower: resolver cannot lower closure (${funcName})`);
    }
    const rootTypeIdx = resolver.resolveClosureRoot?.() ?? null;
    if (rootTypeIdx === null) {
      throw new Error(`ir/lower: resolver cannot lower closure wrapper root (${funcName})`);
    }
    return { kind: "ref", typeIdx: rootTypeIdx };
  }
  if (t.kind === "class") {
    // Slice 4 (#1169d): class instances lower to a non-null `(ref
    // $ClassStruct)`. The struct is registered by the legacy
    // `collectClassDeclaration` pass — the resolver looks it up by
    // `shape.className`.
    const cl = resolver.resolveClass?.(t.shape);
    if (!cl) {
      throw new Error(`ir/lower: resolver cannot lower class ${t.shape.className} (${funcName})`);
    }
    return { kind: "ref", typeIdx: cl.structTypeIdx };
  }
  if (t.kind === "extern") {
    // Slice 10 (#1169i): extern-class values are opaque host references
    // — always externref at the Wasm level. The IR carries the
    // className for static dispatch, but it has no Wasm-level analogue.
    return { kind: "externref" };
  }
  if (t.kind === "union") {
    // #1926 — unwrap each member IrType to its backend ValType for the
    // legacy union registry.
    const members = t.members.map((m) => memberValType(m, funcName));
    const union = resolver.resolveUnion?.(members);
    if (!union) {
      throw new Error(`ir/lower: resolver cannot lower union<${members.map((m) => m.kind).join(",")}> (${funcName})`);
    }
    return { kind: "ref", typeIdx: union.typeIdx };
  }
  if (t.kind === "dynamic") {
    // #2949 slice 1 — the dynamic leaf lowers to the module's canonical
    // boxed-any carrier (see `IrLowerResolver.resolveDynamic` for the #1852
    // contract). The optional JsTag refinement is compile-time knowledge
    // only and never changes the carrier ValType.
    const dyn = resolver.resolveDynamic?.();
    if (!dyn) {
      throw new Error(`ir/lower: resolver cannot lower dynamic IrType (resolveDynamic missing) (${funcName})`);
    }
    return dyn;
  }
  // boxed (refcell)
  // Slice 3 (#1169c): the resolver delegates to the legacy ref-cell
  // registry so legacy and IR ref cells share one WasmGC struct.
  // #1926 — unwrap the inner IrType to its backend ValType.
  const innerVal = memberValType(t.inner, funcName);
  if (resolver.resolveRefCell) {
    const cell = resolver.resolveRefCell(innerVal);
    if (cell) {
      return { kind: "ref", typeIdx: cell.typeIdx };
    }
  }
  const box = resolver.resolveBoxed?.(innerVal);
  if (!box) {
    throw new Error(`ir/lower: resolver cannot lower boxed<${innerVal.kind}> (${funcName})`);
  }
  return { kind: "ref", typeIdx: box.typeIdx };
}

/**
 * Compact debug string for an object shape — used in error messages so a
 * mismatched shape surfaces with its field list rather than just an opaque
 * "object" tag. Field types are rendered shallowly (kind only) to keep
 * messages readable; nested objects show as `object{...}` recursively.
 */
function describeShape(shape: IrObjectShape): string {
  return shape.fields.map((f) => `${f.name}:${describeIrTypeShallow(f.type)}`).join(",");
}

function describeIrTypeShallow(t: IrType): string {
  if (t.kind === "val") return t.val.kind;
  if (t.kind === "string") return "string";
  if (t.kind === "vec") return `vec<${describeIrTypeShallow(t.elementType)}>${t.nullable ? "?" : ""}`;
  if (t.kind === "object") return `object{${describeShape(t.shape)}}`;
  if (t.kind === "closure") {
    const ps = t.signature.params.map(describeIrTypeShallow).join(",");
    return `closure(${ps})->${t.signature.returnType === null ? "void" : describeIrTypeShallow(t.signature.returnType)}`;
  }
  if (t.kind === "callable") {
    const ps = t.signature.params.map(describeIrTypeShallow).join(",");
    return `callable(${ps})->${t.signature.returnType === null ? "void" : describeIrTypeShallow(t.signature.returnType)}`;
  }
  if (t.kind === "class") return `class<${t.shape.className}>`;
  if (t.kind === "extern") return `extern<${t.className}>`;
  // #1926 — union members / boxed inner are IrTypes; recurse.
  if (t.kind === "union") return `union<${t.members.map(describeIrTypeShallow).join(",")}>`;
  // #2949 — dynamic leaf; render the optional JsTag refinement when present.
  if (t.kind === "dynamic") return t.tag === undefined ? "dynamic" : `dynamic<tag:${t.tag}>`;
  return `boxed<${describeIrTypeShallow(t.inner)}>`;
}

/**
 * Slice 11 (#1169n) — emit JS ToInt32 for the f64 currently on top of
 * the value stack. After this runs, the stack holds an i32 whose bit
 * pattern matches what `(value | 0)` would produce in JS — including
 * NaN→0, Infinity→0, and modulo-2^32 wrap for out-of-range inputs.
 *
 * This mirrors the legacy `emitToInt32` helper in
 * `src/codegen/binary-ops.ts:1973`. It needs a single f64 scratch
 * local (passed in `tmpLocalIdx`) to duplicate the truncated value
 * for the modulo-2^32 reduction step.
 *
 * Sequence:
 *   - f64.trunc                  ; truncate fractional part toward zero
 *   - local.tee tmp; local.get tmp
 *                                ; duplicate the trunc'd value
 *   - f64.const 2^32; f64.div; f64.floor; f64.const 2^32; f64.mul; f64.sub
 *                                ; reduce modulo 2^32 → range [0, 2^32)
 *   - i32.trunc_sat_f64_u        ; bit pattern of int32 result
 *
 * NaN handling: trunc(NaN)=NaN, NaN/x=NaN, floor(NaN)=NaN, NaN*x=NaN,
 * x-NaN=NaN, trunc_sat_f64_u(NaN)=0. So NaN→0 falls out naturally
 * without a branch.
 */
/**
 * #1126 Stage 3 — map a JS-bitwise IrBinop tag to its native Wasm i32 op.
 * Pure helper; used by both the fast path (both i32) and the legacy
 * scratch-dance path (both f64) inside `case "binary"`. Centralising
 * the mapping keeps the two paths in lock-step on `>>>` vs `>>` (signed
 * vs unsigned) signedness.
 */
function jsBitwiseToI32(
  op: "js.bitand" | "js.bitor" | "js.bitxor" | "js.shl" | "js.shr_s" | "js.shr_u",
): BackendI32BitwiseOp {
  switch (op) {
    case "js.bitand":
      return "i32.and";
    case "js.bitor":
      return "i32.or";
    case "js.bitxor":
      return "i32.xor";
    case "js.shl":
      return "i32.shl";
    case "js.shr_s":
      return "i32.shr_s";
    case "js.shr_u":
      return "i32.shr_u";
  }
}

// #3499: generic over the sink `S` and expressed only through typed scalar
// emitter primitives. WasmGC/linear still receive the byte-identical Instr
// stream, while non-Wasm sinks can represent the same composite semantics
// without observing raw Wasm instructions. Bytecode legality continues to
// reject the js.bitwise family before any of these primitives are called.
//
// (#3739) `S = Instr[]` (WasmGC and linear both use this sink type — see
// `linear-emitter.ts`'s own comment on `emitBinary` for the shared-sink
// rationale) takes a FAST bit-manipulation path instead: a handwritten-Wasm
// bisection found the float-based algorithm below (f64.div/f64.floor/f64.mul)
// never gets tiered up by V8 in a tight loop — stuck at baseline-interpreter
// speed indefinitely, ~12x slower than an equivalent pure-f64 loop with no
// floor at all. The bit-manipulation version (decompose the f64's IEEE-754
// sign/exponent/significand and shift directly) avoids f64.floor entirely;
// see `emitToInt32` in `src/codegen/binary-ops.ts` for the byte-identical
// algorithm with full derivation comments (kept here without re-deriving to
// avoid drift — the two are intentionally the same instruction sequence).
// Non-Instr[] sinks (Porffor) keep the portable float-based algorithm: Porffor
// doesn't model i64 bit-cast/shift ops in its expression tree, and extending
// it to do so is out of scope here (see plan/issues/3739 for the follow-up).
function emitJsToInt32<S>(
  emitter: BackendEmitter<S>,
  out: S,
  tmpLocalIdx: number,
  allocI64Scratch: () => { bits: number; e: number; significand: number; magnitude: number },
): void {
  if (Array.isArray(out)) {
    const wasmOut = out as Instr[];
    const { bits, e, significand, magnitude } = allocI64Scratch();
    wasmOut.push({ op: "i64.reinterpret_f64" }, { op: "local.set", index: bits });
    wasmOut.push(
      { op: "local.get", index: bits },
      { op: "i64.const", value: 52n },
      { op: "i64.shr_u" },
      { op: "i64.const", value: 0x7ffn },
      { op: "i64.and" },
      { op: "i64.const", value: 1023n },
      { op: "i64.sub" },
      { op: "local.set", index: e },
    );
    wasmOut.push(
      { op: "local.get", index: bits },
      { op: "i64.const", value: 0xfffffffffffffn },
      { op: "i64.and" },
      { op: "i64.const", value: 0x10000000000000n },
      { op: "i64.or" },
      { op: "local.set", index: significand },
    );
    const shiftLeft: Instr[] = [
      { op: "local.get", index: significand },
      { op: "local.get", index: e },
      { op: "i64.const", value: 52n },
      { op: "i64.sub" },
      { op: "i64.shl" },
    ];
    const shiftRight: Instr[] = [
      { op: "local.get", index: significand },
      { op: "i64.const", value: 52n },
      { op: "local.get", index: e },
      { op: "i64.sub" },
      { op: "i64.shr_u" },
    ];
    wasmOut.push(
      { op: "local.get", index: e },
      { op: "i64.const", value: 0n },
      { op: "i64.ge_s" },
      { op: "local.get", index: e },
      { op: "i64.const", value: 83n },
      { op: "i64.le_s" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i64" } },
        then: [
          { op: "local.get", index: e },
          { op: "i64.const", value: 52n },
          { op: "i64.ge_s" },
          { op: "if", blockType: { kind: "val", type: { kind: "i64" } }, then: shiftLeft, else: shiftRight },
        ],
        else: [{ op: "i64.const", value: 0n }],
      },
      { op: "local.set", index: magnitude },
    );
    wasmOut.push(
      { op: "local.get", index: bits },
      { op: "i64.const", value: 0n },
      { op: "i64.lt_s" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "i32.const", value: 0 },
          { op: "local.get", index: magnitude },
          { op: "i32.wrap_i64" },
          { op: "i32.sub" },
        ],
        else: [{ op: "local.get", index: magnitude }, { op: "i32.wrap_i64" }],
      },
    );
    return;
  }
  // Stack: [f64]
  emitter.emitUnary("f64.trunc", out);
  // Stack: [f64_trunc]
  emitter.emitLocalTee(tmpLocalIdx, out);
  emitter.emitLocalGet(tmpLocalIdx, out);
  // Stack: [f64_trunc, f64_trunc]
  emitter.emitScalarConst("f64", 4294967296, out);
  emitter.emitBinary("f64.div", out);
  emitter.emitUnary("f64.floor", out);
  emitter.emitScalarConst("f64", 4294967296, out);
  emitter.emitBinary("f64.mul", out);
  emitter.emitBinary("f64.sub", out);
  // Stack: [f64_in_range]
  emitter.emitNumericConversion("i32.trunc_sat_f64_u", out);
  // Stack: [i32]
}

// #1713: exported as `emitConstInstr` so `WasmGcEmitter.emitConst` can delegate
// to this single const-lowering implementation (kept here, not duplicated).
export function emitConstInstr(instr: Extract<IrInstr, { kind: "const" }>, out: Instr[], funcName: string): void {
  const v = instr.value;
  switch (v.kind) {
    case "i32":
      out.push({ op: "i32.const", value: v.value });
      return;
    case "i64":
      out.push({ op: "i64.const", value: v.value });
      return;
    case "f32":
      out.push({ op: "f32.const", value: v.value });
      return;
    case "f64":
      out.push({ op: "f64.const", value: v.value });
      return;
    case "bool":
      out.push({ op: "i32.const", value: v.value ? 1 : 0 });
      return;
    case "null":
      throw new Error(`ir/lower: const null must be emitted through BackendEmitter.emitNull (${funcName})`);
    case "undefined":
      throw new Error(`ir/lower: Phase 1 does not materialize 'undefined' constants (${funcName})`);
  }
}
