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
import type { BackendEmitter } from "./backend/emitter.js";
import { verifyIrBackendLegality } from "./backend/legality.js";
import type {
  IrBoxedLowering,
  IrClassLowering,
  IrClosureLowering,
  IrObjectStructLowering,
  IrRefCellLowering,
  IrUnionLowering,
  IrVecLowering,
} from "./backend/handles.js";
import { WasmGcEmitter } from "./backend/wasmgc-emitter.js";
import {
  type IrBlock,
  type IrClassShape,
  type IrClosureSignature,
  type IrFuncRef,
  type IrFunction,
  type IrGlobalRef,
  type IrInstr,
  type IrObjectShape,
  type IrType,
  type IrTypeRef,
  type IrValueId,
  asVal,
  forEachNestedBuffer,
} from "./nodes.js";
import { isSideEffecting } from "./passes/dead-code.js";
import type { BlockType, FuncTypeDef, Instr, LocalDef, ValType, WasmFunction } from "./types.js";
export type {
  IrBoxedLowering,
  IrClassLowering,
  IrClosureLowering,
  IrObjectStructLowering,
  IrRefCellLowering,
  IrUnionLowering,
  IrVecLowering,
};

export interface IrLowerResolver {
  resolveFunc(ref: IrFuncRef): number;
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
  resolveObject?(shape: IrObjectShape): IrObjectStructLowering | null;
  /**
   * Slice 3 (#1169c): resolve the SUPERTYPE WasmGC struct for a closure
   * signature. Carried by the IrType.closure ValType so all
   * same-signature closures share one Wasm type. Returns `null` if the
   * signature contains an IrType the backend can't lower (e.g. a
   * nested object shape the slice-2 resolver hasn't pre-walked).
   */
  resolveClosure?(signature: IrClosureSignature): IrClosureLowering | null;
  /**
   * Slice 3 (#1169c): resolve the SUBTYPE WasmGC struct for a specific
   * closure-construction site. Different `(signature, captureFieldTypes)`
   * pairs produce different subtypes of the supertype struct, so the
   * lifted body's `ref.cast` recovers capture-field positions.
   */
  resolveClosureSubtype?(signature: IrClosureSignature, captureFieldTypes: readonly IrType[]): IrClosureLowering | null;
  /**
   * Slice 3 (#1169c): resolve the WasmGC struct type for a ref cell
   * over a primitive ValType. Delegates to the legacy
   * `getOrRegisterRefCellType` so legacy and IR ref cells share one
   * type per inner ValType.
   */
  resolveRefCell?(inner: ValType): IrRefCellLowering | null;
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
  resolveVecForElement?(elementValType: ValType): IrVecLowering | null;
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
   *   - native       → inline `i32.const len`, `i32.const 0`, code-unit
   *                    `i32.const`s, `array.new_fixed`, `struct.new`.
   */
  // #1588 PR-B part 2: `alloc` carries the string.const's allocation-site id
  // so the resolver can read the encoding annotation (utf8-storage decision).
  // Optional — resolvers/callers that omit it get the i16 path (byte-identical).
  emitStringConst?(value: string, alloc?: import("./nodes.js").AllocSiteId): readonly Instr[];
  /** `[call concat]` (host) or `[call __str_concat]` (native). */
  emitStringConcat?(): readonly Instr[];
  /** `[call equals]` (host) or `[call __str_equals]` (native). */
  emitStringEquals?(): readonly Instr[];
  /**
   * `[call length]` (host) or `[struct.get $AnyString $len]` (native).
   * Result is i32 — the `string.len` IR instr appends an
   * `f64.convert_i32_s` after this.
   */
  emitStringLen?(): readonly Instr[];
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
 * #1584 (a0-tail): the backend-agnostic lowering result. `lowerIrFunctionBody`
 * is generic over the emitter sink `S`; it returns the lowered body in that
 * sink plus the backend-independent function metadata (`typeIdx`, `locals`,
 * `name`, `exported`). The WasmGC wrapper (`lowerIrFunctionToWasm`, `S =
 * Instr[]`) assembles the concrete `WasmFunction` from this; a bytecode driver
 * consumes `body: BytecodeSink` directly. The `typeIdx`, `locals`, `name`, and
 * `exported` fields are identical regardless of `S` — only `body` changes
 * representation, which is exactly the #1715 sink-is-the-one-seam finding.
 */
export interface IrLoweredBody<S> {
  readonly name: string;
  readonly body: S;
  readonly locals: LocalDef[];
  readonly typeIdx: number;
  readonly exported: boolean;
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
  emitter: BackendEmitter = new WasmGcEmitter(),
): IrLowerResult {
  const lowered = lowerIrFunctionBody<Instr[]>(func, resolver, emitter);
  return {
    func: {
      name: lowered.name,
      typeIdx: lowered.typeIdx,
      locals: lowered.locals,
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
export function lowerIrFunctionBody<S>(
  func: IrFunction,
  resolver: IrLowerResolver,
  // #1713: the active backend. Defaults to WasmGcEmitter (S = Instr[]) so every
  // existing caller is unchanged and Phase 1 stays zero-delta. #1584 passes an
  // explicit emitter (e.g. BytecodeEmitter) selected by compile target.
  emitter: BackendEmitter<S> = new WasmGcEmitter() as unknown as BackendEmitter<S>,
): IrLoweredBody<S> {
  const legalityErrors = verifyIrBackendLegality(func, emitter.backend);
  if (legalityErrors.length > 0) {
    const shown = legalityErrors.slice(0, 3).map((err) => err.message);
    throw new Error(
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
    return out as Instr[];
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
    const fxCache = new Map<IrInstr, SchedFx>();
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
        const fx = schedFxOf(instr, fxCache);
        let anchored = false;
        if (!schedFxIsPure(fx)) {
          for (let k = i + 1; k < e && k < n; k++) {
            const ek = emissionIdx[k];
            if (ek === NEVER || ek > e) continue; // executes after our tree (or never) — def order preserved
            if (ek === e && treeConsumes(k, r)) continue; // same tree, operands emit before consumers
            if (schedFxConflicts(fx, schedFxOf(instrs[k], fxCache))) {
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
    }
  }

  // --- local allocation ---------------------------------------------------
  // Stable order: scan blocks then instrs. Every `needsLocal` value gets one
  // Wasm local slot, placed after the function's parameter slots. The slot's
  // Wasm type is the lowered ValType of the IR resultType (wrap unions /
  // boxed types as refs to the corresponding WasmGC struct).
  const locals: LocalDef[] = [];
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
    locals.push({ name: `$slot_${slot.name}`, type: slot.type });
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
  // #1373b Slice 1 — scratch local for `await` lowering. Holds the
  // ref-cast `$Promise` value across the state-branch dispatch. Allocated
  // lazily on the first await in the function; reused across subsequent
  // awaits in the same function body.
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
    locals.push({ name: `$vec_data_${arrayTypeIdx}`, type: { kind: "ref_null", typeIdx: arrayTypeIdx } });
    vecNewFixedDataScratch.set(arrayTypeIdx, idx);
    return idx;
  };
  const ensureJsBitwiseScratch = (rhsIsI32: boolean): { rhs: number; tmp: number } => {
    if (jsBitwiseTmpIdx === null) {
      jsBitwiseTmpIdx = func.params.length + locals.length;
      locals.push({ name: "$js_bitwise_tmp", type: { kind: "f64" } });
    }
    if (rhsIsI32) {
      if (jsBitwiseRhsIdxI32 === null) {
        jsBitwiseRhsIdxI32 = func.params.length + locals.length;
        locals.push({ name: "$js_bitwise_rhs_i32", type: { kind: "i32" } });
      }
      return { rhs: jsBitwiseRhsIdxI32, tmp: jsBitwiseTmpIdx };
    }
    if (jsBitwiseRhsIdxF64 === null) {
      jsBitwiseRhsIdxF64 = func.params.length + locals.length;
      locals.push({ name: "$js_bitwise_rhs", type: { kind: "f64" } });
    }
    return { rhs: jsBitwiseRhsIdxF64, tmp: jsBitwiseTmpIdx };
  };

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

  // --- emission -----------------------------------------------------------

  const materialized = new Set<IrValueId>();

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
      const idx = resolver.resolveFunc({
        kind: "func",
        name: "__unbox_number",
      });
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
        // (a1) call family (#1584 §2a): route through the typed emitCall
        // primitive — byte-identical {op:"call"} on WasmGC, OP.CALL on bytecode.
        for (const a of instr.args) emitValue(a, out);
        emitter.emitCall(resolver.resolveFunc(instr.target), out);
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
          emitter.pushRaw(out, { op: jsBitwiseToI32(instr.op) });
          if (!resultIsI32) {
            // Convert i32 → f64 to honour the legacy js.bit* result-type
            // contract. `>>>` is unsigned, others signed.
            if (instr.op === "js.shr_u") {
              emitter.pushRaw(out, { op: "f64.convert_i32_u" });
            } else {
              emitter.pushRaw(out, { op: "f64.convert_i32_s" });
            }
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
          emitter.pushRaw(out, { op: "local.set", index: rhsSlot });
          // Stack: [lhs]; rhsSlot holds rhs.
          if (!lhsIsI32) emitJsToInt32(emitter, out, tmpSlot);
          // Stack: [lhs_i32]
          emitter.pushRaw(out, { op: "local.get", index: rhsSlot });
          // Stack: [lhs_i32, rhs]
          if (!rhsIsI32) emitJsToInt32(emitter, out, tmpSlot);
          // Stack: [lhs_i32, rhs_i32]
          emitter.pushRaw(out, { op: jsBitwiseToI32(instr.op) });
          // `>>>` returns a Uint32; everything else is Int32. Convert
          // back to f64 with the matching signedness — UNLESS the IR
          // result type was already narrowed to i32 by Stage 3.
          if (!resultIsI32) {
            if (instr.op === "js.shr_u") {
              emitter.pushRaw(out, { op: "f64.convert_i32_u" });
            } else {
              emitter.pushRaw(out, { op: "f64.convert_i32_s" });
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
            }
            // Intra-arm multi-use: handled at use site via tee pattern.
          }
        };

        // 1. Emit cond.
        emitValue(instr.cond, out);

        // 2. THEN arm.
        const thenBody: S = emitter.newSink();
        emitArmBody(instr.then, thenBody);
        emitValue(instr.thenValue, thenBody);

        // 3. ELSE arm.
        const elseBody: S = emitter.newSink();
        emitArmBody(instr.else, elseBody);
        emitValue(instr.elseValue, elseBody);

        // 4. Wrap in `if (result T) ... else ... end`.
        emitter.emitIf(blockType, thenBody, elseBody, out);
        return;
      }
      case "raw.wasm":
        for (const op of instr.ops) emitter.pushRaw(out, op);
        return;
      case "box": {
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
        const union = resolver.resolveUnion?.(instr.toType.members);
        if (!union) {
          throw new Error(
            `ir/lower: resolver cannot lower union<${instr.toType.members.map((m) => m.kind).join(",")}> (${func.name})`,
          );
        }
        const tag = union.tagFor(valueType);
        // Struct field order: fields at indices tagFieldIdx / valFieldIdx.
        // For V1 registry, tag=0, val=1, so push tag first, then value.
        const pushes: Array<() => void> = [];
        pushes[union.tagFieldIdx] = () => emitter.pushRaw(out, { op: "i32.const", value: tag });
        pushes[union.valFieldIdx] = () => emitValue(instr.value, out);
        for (const push of pushes) push();
        emitter.pushRaw(out, { op: "struct.new", typeIdx: union.typeIdx });
        return;
      }
      case "unbox": {
        // Caller must have proved the tag already; lowering is a plain
        // `struct.get $val`. A future debug mode may prepend a tag check.
        const valueIrType = typeOf(instr.value);
        if (valueIrType.kind !== "union") {
          throw new Error(`ir/lower: unbox value must be a union IrType, got ${valueIrType.kind} (${func.name})`);
        }
        const union = resolver.resolveUnion?.(valueIrType.members);
        if (!union) {
          throw new Error(
            `ir/lower: resolver cannot lower union<${valueIrType.members.map((m) => m.kind).join(",")}> (${func.name})`,
          );
        }
        emitValue(instr.value, out);
        emitter.pushRaw(out, {
          op: "struct.get",
          typeIdx: union.typeIdx,
          fieldIdx: union.valFieldIdx,
        });
        return;
      }
      case "tag.test": {
        // Emit struct.get $tag; i32.const <tagFor(tag)>; i32.eq.
        const valueIrType = typeOf(instr.value);
        if (valueIrType.kind !== "union") {
          throw new Error(`ir/lower: tag.test value must be a union IrType, got ${valueIrType.kind} (${func.name})`);
        }
        const union = resolver.resolveUnion?.(valueIrType.members);
        if (!union) {
          throw new Error(
            `ir/lower: resolver cannot lower union<${valueIrType.members.map((m) => m.kind).join(",")}> (${func.name})`,
          );
        }
        const tag = union.tagFor(instr.tag);
        emitValue(instr.value, out);
        emitter.pushRaw(out, {
          op: "struct.get",
          typeIdx: union.typeIdx,
          fieldIdx: union.tagFieldIdx,
        });
        emitter.pushRaw(out, { op: "i32.const", value: tag });
        emitter.pushRaw(out, { op: "i32.eq" });
        return;
      }
      case "string.const": {
        const ops = resolver.emitStringConst?.(instr.value, instr.alloc);
        if (!ops) throw new Error(`ir/lower: resolver cannot emit string.const (${func.name})`);
        for (const o of ops) emitter.pushRaw(out, o);
        return;
      }
      case "string.concat": {
        emitValue(instr.lhs, out);
        emitValue(instr.rhs, out);
        const ops = resolver.emitStringConcat?.();
        if (!ops) throw new Error(`ir/lower: resolver cannot emit string.concat (${func.name})`);
        for (const o of ops) emitter.pushRaw(out, o);
        return;
      }
      case "string.eq": {
        emitValue(instr.lhs, out);
        emitValue(instr.rhs, out);
        const ops = resolver.emitStringEquals?.();
        if (!ops) throw new Error(`ir/lower: resolver cannot emit string.eq (${func.name})`);
        for (const o of ops) emitter.pushRaw(out, o);
        if (instr.negate) emitter.pushRaw(out, { op: "i32.eqz" });
        return;
      }
      case "string.len": {
        emitValue(instr.value, out);
        const ops = resolver.emitStringLen?.();
        if (!ops) throw new Error(`ir/lower: resolver cannot emit string.len (${func.name})`);
        for (const o of ops) emitter.pushRaw(out, o);
        // IR-level result is f64 — promote the i32 length.
        emitter.pushRaw(out, { op: "f64.convert_i32_s" });
        return;
      }
      case "object.new": {
        const obj = resolver.resolveObject?.(instr.shape);
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
        const sub = resolver.resolveClosureSubtype?.(instr.signature, instr.captureFieldTypes);
        if (!sub) {
          throw new Error(`ir/lower: resolver cannot lower closure subtype (${func.name})`);
        }
        const liftedIdx = resolver.resolveFunc(instr.liftedFunc);
        // ref.func $lifted, push captures, struct.new <subtype>.
        emitter.pushRaw(out, { op: "ref.func", funcIdx: liftedIdx });
        for (const cap of instr.captures) emitValue(cap, out);
        emitter.pushRaw(out, { op: "struct.new", typeIdx: sub.structTypeIdx });
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
        const sub = resolver.resolveClosureSubtype?.(subMeta.signature, subMeta.captureFieldTypes);
        if (!sub) {
          throw new Error(`ir/lower: resolver cannot resolve closure subtype for ${func.name}`);
        }
        emitValue(instr.self, out);
        emitter.pushRaw(out, { op: "ref.cast", typeIdx: sub.structTypeIdx });
        emitter.pushRaw(out, {
          op: "struct.get",
          typeIdx: sub.structTypeIdx,
          fieldIdx: sub.capFieldIdx(instr.index),
        });
        return;
      }
      case "closure.call": {
        const calleeT = typeOf(instr.callee);
        if (calleeT.kind !== "closure") {
          throw new Error(`ir/lower: closure.call callee must be closure IrType, got ${calleeT.kind} (${func.name})`);
        }
        const cl = resolver.resolveClosure?.(calleeT.signature);
        if (!cl) {
          throw new Error(`ir/lower: resolver cannot lower closure for call (${func.name})`);
        }
        // Push __self (closure value), then user args, then the closure
        // value AGAIN to extract the funcref. The double-emit is the
        // reason `collectIrUses` returns `callee` twice — that forces
        // the closure SSA value into a Wasm local so the second emit
        // is just `local.get`, not a re-emission of the producing tree.
        emitValue(instr.callee, out);
        for (const a of instr.args) emitValue(a, out);
        emitValue(instr.callee, out);
        emitter.pushRaw(out, {
          op: "struct.get",
          typeIdx: cl.structTypeIdx,
          fieldIdx: cl.funcFieldIdx,
        });
        // The struct's `func` field is typed as the abstract `funcref`
        // (matches the legacy `getOrCreateFuncRefWrapperTypes` pattern,
        // which avoids a circular type reference between the struct and
        // its lifted func type). `call_ref` requires a typed funcref, so
        // we emit `ref.cast` to convert.
        // The struct.get (a2 struct family) + ref.cast (a5 ref-coercion) before
        // this stay on pushRaw until their families migrate; only the terminal
        // call_ref is the (a1) call family → typed emitCallRef (byte-identical
        // {op:"call_ref"} on WasmGC, OP.CALL_REF on bytecode).
        emitter.pushRaw(out, { op: "ref.cast", typeIdx: cl.funcTypeIdx });
        emitter.emitCallRef(cl.funcTypeIdx, out);
        return;
      }
      case "refcell.new": {
        const valueIrType = typeOf(instr.value);
        const inner = asVal(valueIrType);
        if (!inner) {
          throw new Error(`ir/lower: refcell.new value must be a val-kind IrType (${func.name})`);
        }
        const cell = resolver.resolveRefCell?.(inner);
        if (!cell) {
          throw new Error(`ir/lower: resolver cannot lower refcell<${inner.kind}> (${func.name})`);
        }
        emitValue(instr.value, out);
        emitter.pushRaw(out, { op: "struct.new", typeIdx: cell.typeIdx });
        return;
      }
      case "refcell.get": {
        const cellT = typeOf(instr.cell);
        if (cellT.kind !== "boxed") {
          throw new Error(`ir/lower: refcell.get cell must be boxed, got ${cellT.kind} (${func.name})`);
        }
        const cell = resolver.resolveRefCell?.(cellT.inner);
        if (!cell) {
          throw new Error(`ir/lower: resolver cannot lower refcell<${cellT.inner.kind}> (${func.name})`);
        }
        emitValue(instr.cell, out);
        emitter.pushRaw(out, {
          op: "struct.get",
          typeIdx: cell.typeIdx,
          fieldIdx: cell.fieldIdx,
        });
        return;
      }
      case "refcell.set": {
        const cellT = typeOf(instr.cell);
        if (cellT.kind !== "boxed") {
          throw new Error(`ir/lower: refcell.set cell must be boxed, got ${cellT.kind} (${func.name})`);
        }
        const cell = resolver.resolveRefCell?.(cellT.inner);
        if (!cell) {
          throw new Error(`ir/lower: resolver cannot lower refcell<${cellT.inner.kind}> (${func.name})`);
        }
        emitValue(instr.cell, out);
        emitValue(instr.value, out);
        emitter.pushRaw(out, {
          op: "struct.set",
          typeIdx: cell.typeIdx,
          fieldIdx: cell.fieldIdx,
        });
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
          funcIdx: resolver.resolveFunc({
            kind: "func",
            name: cl.constructorFuncName,
          }),
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
          funcIdx: resolver.resolveFunc({
            kind: "func",
            name: cl.methodFuncName(instr.methodName),
          }),
        });
        return;
      }
      // Slice 6 (#1169e): slot / vec / for-of ops.
      case "slot.read": {
        emitter.pushRaw(out, {
          op: "local.get",
          index: slotWasmIdx(instr.slotIndex),
        });
        return;
      }
      case "slot.write": {
        emitValue(instr.value, out);
        emitter.pushRaw(out, {
          op: "local.set",
          index: slotWasmIdx(instr.slotIndex),
        });
        return;
      }
      case "vec.len": {
        const vecT = asVal(typeOf(instr.vec));
        if (!vecT) throw new Error(`ir/lower: vec.len vec must be a val IrType (${func.name})`);
        const vec = resolver.resolveVec?.(vecT);
        if (!vec) throw new Error(`ir/lower: resolver cannot lower vec for vec.len (${func.name})`);
        emitValue(instr.vec, out);
        emitter.emitVecLen(vec, out);
        // IR-level result is f64 (matches JS Number semantics) — promote.
        // The f64.convert is an IR-result-type coercion, not a backend op,
        // so it stays in the caller (#1713 spec section 3).
        emitter.pushRaw(out, { op: "f64.convert_i32_s" });
        return;
      }
      case "vec.get": {
        const vecT = asVal(typeOf(instr.vec));
        if (!vecT) throw new Error(`ir/lower: vec.get vec must be a val IrType (${func.name})`);
        const vec = resolver.resolveVec?.(vecT);
        if (!vec) throw new Error(`ir/lower: resolver cannot lower vec for vec.get (${func.name})`);
        // Stack: dataArray, index → element
        emitValue(instr.vec, out);
        emitter.emitVecDataPtr(vec, out);
        emitValue(instr.index, out);
        emitter.emitElemGet(vec, out);
        return;
      }
      case "vec.new_fixed": {
        // #1804 — build a fixed-length vec from its element SSA values.
        const elemVT = asVal(instr.elementType);
        if (!elemVT) {
          throw new Error(`ir/lower: vec.new_fixed elementType must be a val IrType (${func.name})`);
        }
        const vec = resolver.resolveVecForElement?.(elemVT);
        if (!vec) {
          throw new Error(`ir/lower: resolver cannot lower vec for vec.new_fixed (${func.name})`);
        }
        // Push e0…eN in order (deepest first), then build the data array +
        // wrap in the vec struct via a scratch local for the (length, data)
        // field order.
        for (const el of instr.elements) emitValue(el, out);
        const dataScratch = ensureVecDataScratch(vec.arrayTypeIdx);
        emitter.emitVecNewFixed(vec, instr.elements.length, dataScratch, out);
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
        const fnIdx = resolver.resolveFunc({ kind: "func", name: importName });
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
        const fnIdx = resolver.resolveFunc({
          kind: "func",
          name: "__create_generator",
        });
        emitter.pushRaw(out, {
          op: "local.get",
          index: slotWasmIdx(func.generatorBufferSlot),
        });
        emitter.pushRaw(out, { op: "ref.null.extern" });
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
        const fnIdx = resolver.resolveFunc({
          kind: "func",
          name: "__gen_yield_star",
        });
        emitter.pushRaw(out, {
          op: "local.get",
          index: slotWasmIdx(func.generatorBufferSlot),
        });
        emitValue(instr.inner, out);
        emitter.pushRaw(out, { op: "call", funcIdx: fnIdx });
        return;
      }
      case "forof.vec": {
        // The forof.vec instr is statement-level (result: null) but we
        // implement it inside emitInstrTree for code-organization parity
        // with the other instrs. The lowerer in `emitBlockBody` calls
        // `emitInstrTree` for void-producing instrs as a unit.
        const vecT = asVal(typeOf(instr.vec));
        if (!vecT) throw new Error(`ir/lower: forof.vec vec must be a val IrType (${func.name})`);
        const vec = resolver.resolveVec?.(vecT);
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

        // Body instrs
        for (const bodyInstr of instr.body) {
          if (bodyInstr.result === null) {
            emitInstrTree(bodyInstr, loopBody as unknown as S);
          } else if (crossBlock.has(bodyInstr.result)) {
            emitInstrTree(bodyInstr, loopBody as unknown as S);
            loopBody.push({
              op: "local.set",
              index: localIdx.get(bodyInstr.result)!,
            });
            materialized.add(bodyInstr.result);
          }
          // Intra-block multi-use: handled at use site via tee pattern.
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

        // Wrap in block { loop { ... } } via the trait (#1584 a3).
        const loopWrap: Instr[] = [];
        emitter.emitLoop({ kind: "empty" }, loopBody as unknown as S, loopWrap as unknown as S);
        emitter.emitBlock({ kind: "empty" }, loopWrap as unknown as S, wasmOut as unknown as S);
        return;
      }
      // Slice 6 part 3 (#1182) — coercion + iterator protocol ops.
      case "coerce.to_externref": {
        // Push the value, then convert any (ref) → externref. If the
        // input is already externref, the convert is a wasm validation
        // no-op (it's permitted on already-externref values). For all
        // ref-typed inputs the wasm engine simply re-tags the reference
        // so it can flow into externref-typed positions.
        emitValue(instr.value, out);
        emitter.pushRaw(out, { op: "extern.convert_any" });
        return;
      }
      case "iter.new": {
        const fnName = instr.async ? "__async_iterator" : "__iterator";
        const funcIdx = resolver.resolveFunc({ kind: "func", name: fnName });
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
        const funcIdx = resolver.resolveFunc({
          kind: "func",
          name: "__iterator_return",
        });
        emitValue(instr.iter, out);
        emitter.pushRaw(out, { op: "call", funcIdx });
        return;
      }
      case "forof.iter": {
        // Mirror of forof.vec but using the iterator protocol. The lowerer
        // emits the `block { loop { ... } }` Wasm pattern documented on
        // `IrInstrForOfIter` in `nodes.ts`.
        const iteratorIdx = resolver.resolveFunc({
          kind: "func",
          name: "__iterator",
        });
        const iteratorNextIdx = resolver.resolveFunc({
          kind: "func",
          name: "__iterator_next",
        });
        const iteratorReturnIdx = resolver.resolveFunc({
          kind: "func",
          name: "__iterator_return",
        });

        // #1584 (a0-tail): out-of-subset (embeds an Instr[] loop body). S = Instr[].
        const wasmOut = requireInstrSink(out);

        // iter = __iterator(iterable)
        emitValue(instr.iterable, out);
        wasmOut.push({ op: "call", funcIdx: iteratorIdx });
        wasmOut.push({ op: "local.set", index: slotWasmIdx(instr.iterSlot) });

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
        for (const bodyInstr of instr.body) {
          if (bodyInstr.result === null) {
            emitInstrTree(bodyInstr, loopBody as unknown as S);
          } else if (crossBlock.has(bodyInstr.result)) {
            emitInstrTree(bodyInstr, loopBody as unknown as S);
            loopBody.push({
              op: "local.set",
              index: localIdx.get(bodyInstr.result)!,
            });
            materialized.add(bodyInstr.result);
          }
        }

        // br 0 (continue)
        emitter.emitBr(0, loopBody as unknown as S);

        // block { loop { ... } } via the trait (#1584 a3).
        const loopWrap: Instr[] = [];
        emitter.emitLoop({ kind: "empty" }, loopBody as unknown as S, loopWrap as unknown as S);
        emitter.emitBlock({ kind: "empty" }, loopWrap as unknown as S, wasmOut as unknown as S);

        // Normal-exit close: iter.return(iter). Note this runs only on
        // normal loop exit (done=true). Abrupt exits (break/return)
        // would need a try/finally — slice 6 step E (#1169h dependency).
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
            }
            // Intra-block multi-use: handled via tee at use site.
          }
        };

        // Try body — emits user instrs + inlined finally on normal exit.
        const tryBody: Instr[] = [];
        emitBodyBuffer(instr.body, tryBody);
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
            const innerBody: Instr[] = [];
            emitBodyBuffer(instr.catchClause.body, innerBody);
            const innerCatchAll: Instr[] = [];
            emitBodyBuffer(instr.finallyBody, innerCatchAll);
            emitter.emitRethrow(0, innerCatchAll as unknown as S);
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
        const charAtIdx = resolver.resolveFunc({
          kind: "func",
          name: "__str_charAt_cp",
        });
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

        // Body instrs (same materialisation pattern as forof.vec/forof.iter).
        for (const bodyInstr of instr.body) {
          if (bodyInstr.result === null) {
            emitInstrTree(bodyInstr, loopBody as unknown as S);
          } else if (crossBlock.has(bodyInstr.result)) {
            emitInstrTree(bodyInstr, loopBody as unknown as S);
            loopBody.push({
              op: "local.set",
              index: localIdx.get(bodyInstr.result)!,
            });
            materialized.add(bodyInstr.result);
          }
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
        const importName = `${instr.className}_new`;
        const fn = resolver.resolveFunc({ kind: "func", name: importName });
        for (const a of instr.args) emitValue(a, out);
        emitter.pushRaw(out, { op: "call", funcIdx: fn });
        return;
      }
      case "extern.call": {
        const importName = `${instr.className}_${instr.method}`;
        const fn = resolver.resolveFunc({ kind: "func", name: importName });
        emitValue(instr.receiver, out);
        for (const a of instr.args) emitValue(a, out);
        emitter.pushRaw(out, { op: "call", funcIdx: fn });
        return;
      }
      case "extern.prop": {
        const importName = `${instr.className}_get_${instr.property}`;
        const fn = resolver.resolveFunc({ kind: "func", name: importName });
        emitValue(instr.receiver, out);
        emitter.pushRaw(out, { op: "call", funcIdx: fn });
        return;
      }
      case "extern.propSet": {
        const importName = `${instr.className}_set_${instr.property}`;
        const fn = resolver.resolveFunc({ kind: "func", name: importName });
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
        const fn = resolver.resolveFunc({ kind: "func", name: "RegExp_new" });
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
        // #1584 (a0-tail): out-of-subset (embeds an Instr[] loop body). S = Instr[].
        const wasmOut = requireInstrSink(out);
        const loopBody: Instr[] = [];

        // Helper: emit a body buffer (cond / body / update) into a
        // target ops array using the standard SSA materialisation
        // rules (mirrors the `forof.*` body emission). `target` is a local
        // Instr[] sub-buffer; the arm asserted S = Instr[] so the cast to S
        // on the recursive emit is sound (#1584 §2a).
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
            }
            // Intra-block multi-use: handled at use site via tee pattern.
          }
        };

        // 1. Cond instructions (re-evaluated each iteration).
        emitBodyBuffer(instr.cond, loopBody);

        // 2. Push the cond value, invert (i32.eqz), then br_if 1 to exit.
        //    #1584 (a3): the control-flow ops route through the trait.
        emitValue(instr.condValue, loopBody as unknown as S);
        loopBody.push({ op: "i32.eqz" });
        emitter.emitBrIf(1, loopBody as unknown as S);

        // 3. Body instructions.
        emitBodyBuffer(instr.body, loopBody);

        // 4. Update instructions (for-loop only — empty array for while).
        if (instr.kind === "for.loop") {
          emitBodyBuffer(instr.update, loopBody);
        }

        // 5. Continue back to the loop header.
        emitter.emitBr(0, loopBody as unknown as S);

        // 6. Wrap in `block { loop { ... } }` via the trait (#1584 a3).
        const loopWrap: Instr[] = [];
        emitter.emitLoop({ kind: "empty" }, loopBody as unknown as S, loopWrap as unknown as S);
        emitter.emitBlock({ kind: "empty" }, loopWrap as unknown as S, wasmOut as unknown as S);
        return;
      }
      // (#1373b Phase C Slice 1) Async / await IR node lowering.
      //
      // The IR selector still rejects async functions today (gate
      // hardcoded `false` in `isAsyncIrReady`), so these arms only fire
      // when a future caller flips the flag OR when a synthesised IR
      // construction reaches the lowerer directly (e.g. from tests).
      // The Slice 1 implementation covers the synchronous cases:
      //
      //   - `async.return v` → struct.new $Promise with state=FULFILLED
      //     and value=v. Result is a settled-fulfilled Promise as
      //     externref. Reuses the same struct shape as
      //     `emitStandalonePromiseResolve` in async-scheduler.ts.
      //
      //   - `async.throw r` → struct.new $Promise with state=REJECTED
      //     and value=r. Result is a settled-rejected Promise as
      //     externref. Mirrors `emitStandalonePromiseReject`.
      //
      //   - `await p` → cast p to ref $Promise and branch on its state:
      //     * FULFILLED (1): read $value field → push as externref result
      //     * REJECTED  (2): throw $value via the shared exn tag
      //     * PENDING   (0): blocked on #1326c Phase 1C-B
      //       (`emitStandalonePromiseThen`). Slice 1 emits an
      //       `unreachable` after a runtime-throw marker so the
      //       failure mode is observable but the gate's hardcoded
      //       `false` prevents it from ever firing.
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
        emitter.pushRaw(out, { op: "ref.null.extern" } as Instr);
        emitter.pushRaw(out, { op: "struct.new", typeIdx: promiseTypeIdx });
        emitter.pushRaw(out, { op: "extern.convert_any" } as Instr);
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
        emitter.pushRaw(out, { op: "ref.null.extern" } as Instr);
        emitter.pushRaw(out, { op: "struct.new", typeIdx: promiseTypeIdx });
        emitter.pushRaw(out, { op: "extern.convert_any" } as Instr);
        return;
      }
      case "await": {
        const promiseTypeIdx = resolver.resolvePromiseType?.();
        if (promiseTypeIdx === undefined) {
          throw new Error(
            "ir/lower: await requires resolver.resolvePromiseType (#1373b Slice 1) — not wired for this backend",
          );
        }
        // Strategy:
        //   1. Push the operand (a Promise as externref)
        //   2. extern.convert_any → anyref → ref.cast $Promise
        //   3. Save to a scratch local so we can read state + value
        //   4. Branch on state:
        //      - FULFILLED: return $value (externref) — fast path
        //      - REJECTED: read $value, throw via exn tag
        //      - PENDING: throw "Phase 1C-B not yet landed" marker
        //
        // Result type: externref (the resolved value, OR the function
        // ungracefully terminates via throw on REJECTED/PENDING).
        //
        // SSA scope note: this implementation evaluates the operand
        // exactly once and binds the result inline. There is no
        // continuation closure here — the function continues in the
        // same wasm frame. PENDING-path continuation synthesis is
        // Slice 2 (blocked on #1326c Phase 1C-B).
        //
        // #1584 (a0-tail): out-of-subset — embeds Instr[] `if`-arm sub-buffers
        // (rejectedBranch / pendingBranch) into a raw WasmGC `{op:"if"...}`.
        // Assert S = Instr[].
        const wasmOut = requireInstrSink(out);
        emitValue(instr.operand, out);
        wasmOut.push({ op: "any.convert_extern" } as Instr);
        wasmOut.push({ op: "ref.cast", typeIdx: promiseTypeIdx });
        // The next emit needs a scratch local. Reuse the
        // jsBitwiseTmp pattern: allocate lazily into `locals` and
        // remember the index for any further await in the same fn.
        if (awaitScratchPromiseIdx === null) {
          awaitScratchPromiseIdx = func.params.length + locals.length;
          locals.push({
            name: "$await_promise",
            type: { kind: "ref", typeIdx: promiseTypeIdx } as ValType,
          });
        }
        wasmOut.push({ op: "local.tee", index: awaitScratchPromiseIdx });
        wasmOut.push({
          op: "struct.get",
          typeIdx: promiseTypeIdx,
          fieldIdx: 0,
        }); // state: i32
        // Build:
        //   if state == FULFILLED then
        //     local.get $await_promise
        //     struct.get $Promise $value      ;; externref
        //   else
        //     if state == REJECTED then
        //       throw $exn ( $value )
        //     else
        //       unreachable + #1326c-1C-B marker
        //     end
        //   end
        const exnTagIdx = resolver.ensureExnTag?.();
        const rejectedBranch: Instr[] = [];
        if (exnTagIdx !== undefined) {
          rejectedBranch.push({
            op: "local.get",
            index: awaitScratchPromiseIdx,
          });
          rejectedBranch.push({
            op: "struct.get",
            typeIdx: promiseTypeIdx,
            fieldIdx: 1,
          } as Instr);
          // #1584 (a4): throw routes through the trait.
          emitter.emitThrow(exnTagIdx, rejectedBranch as unknown as S);
        }
        rejectedBranch.push({ op: "unreachable" } as Instr);
        // PENDING / fall-through marker. Slice 2 (#1373b) replaces with
        // the CPS continuation synthesis once #1326c Phase 1C-B lands.
        const pendingBranch: Instr[] = [{ op: "unreachable" } as Instr];
        wasmOut.push({ op: "i32.const", value: PROMISE_STATE_FULFILLED });
        wasmOut.push({ op: "i32.eq" });
        wasmOut.push({
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } as ValType },
          then: [
            { op: "local.get", index: awaitScratchPromiseIdx },
            { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 1 } as Instr,
          ],
          else: [
            { op: "local.get", index: awaitScratchPromiseIdx },
            { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 0 } as Instr,
            { op: "i32.const", value: PROMISE_STATE_REJECTED } as Instr,
            { op: "i32.eq" } as Instr,
            {
              op: "if",
              blockType: {
                kind: "val",
                type: { kind: "externref" } as ValType,
              },
              then: rejectedBranch,
              else: pendingBranch,
            } as Instr,
          ],
        } as Instr);
        return;
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
        emitBlockBody(thenBlock, thenOps);
        emitBlockBody(elseBlock, elseOps);
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
    const wasmBody = body as Instr[];
    const last = wasmBody[wasmBody.length - 1];
    if (!last || last.op !== "return") {
      emitter.emitUnreachable(body);
    }
  }

  const paramTypes: ValType[] = func.params.map((p) => lowerIrTypeToValType(p.type, resolver, func.name));
  const resultTypes: ValType[] = func.resultTypes.map((t) => lowerIrTypeToValType(t, resolver, func.name));
  const typeIdx = resolver.internFuncType({
    kind: "func",
    params: paramTypes,
    results: resultTypes,
  });

  return {
    name: func.name,
    body,
    locals,
    typeIdx,
    exported: func.exported,
  };
}

// --- #1982: emission-scheduling effect summaries ----------------------------
//
// `emitBlockBody`'s lazy use-site emission re-orders instruction trees
// relative to program order. That is sound only for values that commute with
// everything in between. These summaries classify what each instruction reads
// and writes so the scheduler can anchor order-sensitive values at their def
// position instead.
//
// Slots are Wasm locals of the current function: nothing but `slot.write`
// (and the loop headers that own dedicated slot indices) can modify them —
// calls cannot reach another function's locals, and mutable closure captures
// go through refcells. That keeps slot conflicts precise per index, which
// matters because `slot.read` is by far the most common deferred read.

interface SchedFx {
  /** Reads mutable heap state (struct fields, globals, vec elements, host objects). */
  readsHeap: boolean;
  /** Writes heap state or has arbitrary effects (calls, iterator advance, throw). */
  writesHeap: boolean;
  /** Touches statically-unknown slots (raw.wasm may local.set; gen.* use func-level slots). */
  allSlots: boolean;
  readSlots: Set<number>;
  writeSlots: Set<number>;
}

function schedFxOf(instr: IrInstr, cache: Map<IrInstr, SchedFx>): SchedFx {
  const hit = cache.get(instr);
  if (hit) return hit;
  const fx: SchedFx = {
    readsHeap: false,
    writesHeap: false,
    allSlots: false,
    readSlots: new Set(),
    writeSlots: new Set(),
  };
  // Memoize BEFORE recursing — buffers cannot be cyclic, but this keeps the
  // walk linear in total instr count.
  cache.set(instr, fx);
  const mergeBuffer = (body: readonly IrInstr[]): void => {
    for (const sub of body) {
      const s = schedFxOf(sub, cache);
      fx.readsHeap ||= s.readsHeap;
      fx.writesHeap ||= s.writesHeap;
      fx.allSlots ||= s.allSlots;
      for (const x of s.readSlots) fx.readSlots.add(x);
      for (const x of s.writeSlots) fx.writeSlots.add(x);
    }
  };
  switch (instr.kind) {
    // Pure: constants, arithmetic, allocation of fresh objects, immutable
    // string content ops. Re-ordering these is unobservable.
    case "const":
    case "string.const":
    case "binary":
    case "unary":
    case "select":
    case "box":
    case "unbox":
    case "tag.test":
    case "coerce.to_externref":
    case "string.concat":
    case "string.eq":
    case "string.len":
    case "object.new":
    case "vec.new_fixed": // #1804 — fresh vec allocation, pure (like object.new)
    case "refcell.new":
    case "closure.new":
    case "extern.regex":
      break;
    // Reads of mutable heap state.
    case "global.get":
    case "object.get":
    case "class.get":
    case "vec.get":
    case "vec.len":
    case "refcell.get":
    case "closure.cap":
      fx.readsHeap = true;
      break;
    // Writes of heap state (void-result, so only ever hazards).
    case "global.set":
    case "object.set":
    case "class.set":
    case "refcell.set":
      fx.writesHeap = true;
      break;
    // Call-like: may read AND write arbitrary heap state. `extern.prop` can
    // trigger a host getter; iterator ops advance host iterator state; throw
    // is a control effect treated as a full heap barrier.
    case "call":
    case "class.call":
    case "closure.call":
    case "extern.call":
    case "class.new":
    case "extern.new":
    case "extern.prop":
    case "extern.propSet":
    case "iter.new":
    case "iter.next":
    case "iter.done":
    case "iter.value":
    case "iter.return":
    case "throw":
    case "await":
    case "async.return":
    case "async.throw":
      fx.readsHeap = true;
      fx.writesHeap = true;
      break;
    // Generator ops read/write the function-level buffer/pendingThrow slots
    // (slot indices live on IrFunction, not on the instr) plus the heap.
    case "gen.push":
    case "gen.epilogue":
    case "gen.yieldStar":
      fx.readsHeap = true;
      fx.writesHeap = true;
      fx.allSlots = true;
      break;
    // Raw embedded Wasm may contain arbitrary ops including local.set.
    case "raw.wasm":
      fx.readsHeap = true;
      fx.writesHeap = true;
      fx.allSlots = true;
      break;
    case "slot.read":
      fx.readSlots.add(instr.slotIndex);
      break;
    case "slot.write":
      fx.writeSlots.add(instr.slotIndex);
      break;
    // Loop headers write their pre-allocated state slots every iteration;
    // body/cond/update effects merge in recursively.
    case "forof.vec":
      fx.readsHeap = true;
      for (const s of [instr.counterSlot, instr.lengthSlot, instr.vecSlot, instr.dataSlot, instr.elementSlot]) {
        fx.writeSlots.add(s);
      }
      mergeBuffer(instr.body);
      break;
    case "forof.iter":
      fx.readsHeap = true;
      fx.writesHeap = true; // iterator protocol host calls
      for (const s of [instr.iterSlot, instr.resultSlot, instr.elementSlot]) fx.writeSlots.add(s);
      mergeBuffer(instr.body);
      break;
    case "forof.string":
      fx.readsHeap = true;
      for (const s of [instr.counterSlot, instr.lengthSlot, instr.strSlot, instr.elementSlot]) {
        fx.writeSlots.add(s);
      }
      mergeBuffer(instr.body);
      break;
    case "while.loop":
      mergeBuffer(instr.cond);
      mergeBuffer(instr.body);
      break;
    case "for.loop":
      mergeBuffer(instr.cond);
      mergeBuffer(instr.body);
      mergeBuffer(instr.update);
      break;
    case "try":
      mergeBuffer(instr.body);
      if (instr.catchClause) mergeBuffer(instr.catchClause.body);
      if (instr.finallyBody) mergeBuffer(instr.finallyBody);
      break;
    case "if":
      mergeBuffer(instr.then);
      mergeBuffer(instr.else);
      break;
    default: {
      // Future instruction kinds default to a full barrier so a new kind can
      // never silently become re-orderable.
      const _exhaustive: never = instr;
      void _exhaustive;
      fx.readsHeap = true;
      fx.writesHeap = true;
      fx.allSlots = true;
      break;
    }
  }
  return fx;
}

function schedFxIsPure(fx: SchedFx): boolean {
  return !fx.readsHeap && !fx.writesHeap && !fx.allSlots && fx.readSlots.size === 0 && fx.writeSlots.size === 0;
}

/** May re-ordering `a` across `b` change observable behavior? */
function schedFxConflicts(a: SchedFx, b: SchedFx): boolean {
  if (a.writesHeap && (b.readsHeap || b.writesHeap)) return true;
  if (b.writesHeap && a.readsHeap) return true;
  const aTouchesSlots = a.allSlots || a.readSlots.size > 0 || a.writeSlots.size > 0;
  const bTouchesSlots = b.allSlots || b.readSlots.size > 0 || b.writeSlots.size > 0;
  if (a.allSlots && bTouchesSlots) return true;
  if (b.allSlots && aTouchesSlots) return true;
  for (const s of a.writeSlots) {
    if (b.readSlots.has(s) || b.writeSlots.has(s)) return true;
  }
  for (const s of b.writeSlots) {
    if (a.readSlots.has(s)) return true;
  }
  return false;
}

function collectIrUses(instr: IrInstr): readonly IrValueId[] {
  switch (instr.kind) {
    case "const":
      return [];
    case "call":
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
      return [instr.value];
    case "string.const":
      return [];
    case "string.concat":
    case "string.eq":
      return [instr.lhs, instr.rhs];
    case "string.len":
      return [instr.value];
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
    // Slice 6 (#1169e): slot / vec / for-of ops.
    case "slot.read":
      return [];
    case "slot.write":
      return [instr.value];
    case "vec.len":
      return [instr.vec];
    case "vec.get":
      return [instr.vec, instr.index];
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
  }
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
export function lowerIrTypeToValType(t: IrType, resolver: IrLowerResolver, funcName: string): ValType {
  if (t.kind === "val") return t.val;
  if (t.kind === "string") {
    const sty = resolver.resolveString?.();
    if (!sty) {
      throw new Error(`ir/lower: resolver cannot lower string IrType (${funcName})`);
    }
    return sty;
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
    // Slice 3 (#1169c): a closure value lowers to a (ref $base_struct)
    // — the supertype struct shared by all closures with this signature.
    // `call_ref` against the base func type accepts any subtype value,
    // so the same Wasm-level type works for both construction (subtype)
    // and call (supertype). The resolver registers the supertype lazily
    // on first use.
    const cl = resolver.resolveClosure?.(t.signature);
    if (!cl) {
      throw new Error(`ir/lower: resolver cannot lower closure (${funcName})`);
    }
    return { kind: "ref", typeIdx: cl.structTypeIdx };
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
    const union = resolver.resolveUnion?.(t.members);
    if (!union) {
      throw new Error(`ir/lower: resolver cannot lower union<${t.members.map((m) => m.kind).join(",")}> (${funcName})`);
    }
    return { kind: "ref", typeIdx: union.typeIdx };
  }
  // boxed (refcell)
  // Slice 3 (#1169c): the resolver delegates to the legacy ref-cell
  // registry so legacy and IR ref cells share one WasmGC struct.
  if (resolver.resolveRefCell) {
    const cell = resolver.resolveRefCell(t.inner);
    if (cell) {
      return { kind: "ref", typeIdx: cell.typeIdx };
    }
  }
  const box = resolver.resolveBoxed?.(t.inner);
  if (!box) {
    throw new Error(`ir/lower: resolver cannot lower boxed<${t.inner.kind}> (${funcName})`);
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
  if (t.kind === "object") return `object{${describeShape(t.shape)}}`;
  if (t.kind === "closure") {
    const ps = t.signature.params.map(describeIrTypeShallow).join(",");
    return `closure(${ps})->${describeIrTypeShallow(t.signature.returnType)}`;
  }
  if (t.kind === "class") return `class<${t.shape.className}>`;
  if (t.kind === "extern") return `extern<${t.className}>`;
  if (t.kind === "union") return `union<${t.members.map((m) => m.kind).join(",")}>`;
  return `boxed<${t.inner.kind}>`;
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
): "i32.and" | "i32.or" | "i32.xor" | "i32.shl" | "i32.shr_s" | "i32.shr_u" {
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

// #1584 (a0-tail): generic over the sink `S` so the js-bitwise ToInt32 dance
// flows through the same `emitter.pushRaw` escape hatch as its caller. On
// WasmGC (`S = Instr[]`) the emitted stream is byte-identical to the prior
// direct pushes; the js-bitwise family is out of the bytecode subset, so on a
// bytecode sink `pushRaw` throws (the not-yet-migrated boundary, §2a a6).
function emitJsToInt32<S>(emitter: BackendEmitter<S>, out: S, tmpLocalIdx: number): void {
  // Stack: [f64]
  emitter.pushRaw(out, { op: "f64.trunc" });
  // Stack: [f64_trunc]
  emitter.pushRaw(out, { op: "local.tee", index: tmpLocalIdx });
  emitter.pushRaw(out, { op: "local.get", index: tmpLocalIdx });
  // Stack: [f64_trunc, f64_trunc]
  emitter.pushRaw(out, { op: "f64.const", value: 4294967296 });
  emitter.pushRaw(out, { op: "f64.div" });
  emitter.pushRaw(out, { op: "f64.floor" });
  emitter.pushRaw(out, { op: "f64.const", value: 4294967296 });
  emitter.pushRaw(out, { op: "f64.mul" });
  emitter.pushRaw(out, { op: "f64.sub" });
  // Stack: [f64_in_range]
  emitter.pushRaw(out, { op: "i32.trunc_sat_f64_u" });
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
    case "null": {
      const valTy = instr.resultType ? asVal(instr.resultType) : null;
      if (valTy && valTy.kind === "ref_null") {
        out.push({
          op: "ref.null",
          typeIdx: (valTy as { typeIdx: number }).typeIdx,
        });
        return;
      }
      // Slice 7b (#1169f): bare `yield;` lowers to a `gen.push` of
      // a null externref. The IrConst `{ kind: "null", ty:
      // irVal({ kind: "externref" }) }` materializes here as a
      // `ref.null.extern` Wasm op. Same shape the legacy generator
      // path uses for the "no value" yield (see misc.ts:212-215).
      if (valTy && valTy.kind === "externref") {
        out.push({ op: "ref.null.extern" });
        return;
      }
      throw new Error(`ir/lower: const null must have ref_null or externref resultType (${funcName})`);
    }
    case "undefined":
      throw new Error(`ir/lower: Phase 1 does not materialize 'undefined' constants (${funcName})`);
  }
}
