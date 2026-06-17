// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// BackendEmitter trait (#1713).
//
// The seam between IR-lowering *intent* (`src/ir/lower.ts` decides "read
// field N of this object", "build a closure cell", "box a scalar") and the
// concrete *ops* a backend emits ("WasmGC: struct.get typeIdx fieldIdx" vs
// "linear: i32.load offset" vs "bytecode: OP_GETFIELD slot").
//
// This generalises the pattern `lower.ts` already shipped for strings:
// `resolver.emitStringConst()` / `emitStringConcat()` / `emitStringEquals()`
// / `emitStringLen()` do NOT push WasmGC ops inline -- they delegate to the
// resolver because strings genuinely differ between backends (host externref
// vs native i16 array). `BackendEmitter` extends that to the struct / array /
// ref ops.
//
// Boundary contract:
//   - The emitter NEVER owns the `IrLowerResolver` (layout factory). `lower.ts`
//     resolves the layout handle (an `IrVecLowering` etc.) and passes it in.
//     Memoisation / registration stays in one place.
//   - Operand evaluation order is the CALLER's job: `lower.ts` emits operand
//     subtrees via `emitValue(v, out)` BEFORE calling an emitter primitive,
//     exactly as the inline code did. The emitter only pushes the *terminal*
//     op(s) for the node -- it never calls `emitValue`. SSA / materialisation
//     logic stays in `lower.ts`.
//   - Every method takes the output sink `out: Instr[]` and PUSHES onto it
//     (side-effecting `void` return), mirroring the original `out.push(...)`
//     call sites and the existing `emitValue(v, out)` helper. The emitter does
//     NOT return `Instr[]` to be spliced.
//
// Phase 1 (#1713) implements only the pass-through group (locals / globals /
// const / arithmetic / control flow) and the vec group; `WasmGcEmitter`
// produces a byte-identical `Instr` stream. The remaining methods
// (aggregate / union / closure / ref-coercion) are declared so #1714 / a
// later stage can route them, and are implemented in `WasmGcEmitter` as
// they get wired. Async (Promise) + string groups stay where they are in
// `lower.ts` for Phase 1 (strings are already behind `emit*` resolver
// methods; Promise/await is WasmGC-only with no linear analogue yet).
//
// The `out: Instr[]` sink is WasmGC/linear-shaped (both backends share the
// `Instr` union -- see codegen-axes "types.ts stays shared"). It does NOT fit
// bytecode (`number[]`); #1715 generalises the sink to reach a stack-VM. That
// generalisation is the #1715 deliverable, not a Phase-1 blocker.

import type { IrBackendKind } from "./legality.js";
import type { IrBinop, IrInstr, IrType, IrUnop } from "../nodes.js";
import type { BlockType, Instr } from "../types.js";
import type {
  IrClassLowering,
  IrClosureLowering,
  IrObjectStructLowering,
  IrRefCellLowering,
  IrUnionLowering,
  IrVecLowering,
  LinearVecLowering,
} from "./handles.js";

// #1714: the vec primitives accept either backend's vec-layout handle. WasmGc
// uses IrVecLowering (typeIdx-based); Linear uses LinearVecLowering
// (offset-based). Each emitter narrows to its own shape. This is the
// "widen to a handle union" option from the #1713 spec section 7.
type VecLayout = IrVecLowering | LinearVecLowering;

/**
 * #1584: the trait is generic over its SINK type `S`. `WasmGcEmitter` /
 * `LinearEmitter` use `S = Instr[]` (the default — every pre-#1584 caller is
 * unchanged). `BytecodeEmitter` uses `S = BytecodeSink` (a flat opcode stream).
 * The sink abstraction is the ONE representation-specific seam the #1715 finding
 * identified; this generic parameter realizes it.
 *
 * Two sink operations belong to the trait (not the per-node primitives) because
 * `lower.ts` itself touches the sink directly:
 *  - `newSink()` — the sink factory `lower.ts` uses to build `if`-arm buffers
 *    (it builds each arm into its own sink, then hands both to `emitIf`).
 *  - `pushRaw(out, instr)` — the raw-`Instr` escape hatch (#1584 contract
 *    §0a-1). `lower.ts` still has ~119 inline pushes for op families not yet
 *    migrated behind the trait. On WasmGC these append to the `Instr[]`; on the
 *    bytecode sink they hit an unrealized op family and throw (the
 *    not-yet-migrated boundary, surfaced loudly). As each family migrates
 *    (§2a), its sites move from `pushRaw` to a typed primitive.
 */
export interface BackendEmitter<S = Instr[]> {
  /** Backend identity used by the IR legality verifier at the emit boundary. */
  readonly backend: IrBackendKind;

  /** Create a fresh empty sink (for `if`-arm buffers built by lower.ts). */
  newSink(): S;
  /** Raw-`Instr` escape hatch for op families not yet routed through the trait. */
  pushRaw(out: S, instr: Instr): void;

  // ---- vec (array) -- the Phase-1 stage-2 primitives ------------------
  /**
   * vec ref on stack -> i32 length. The caller appends `f64.convert_i32_s`
   * when the IR result type is f64 (that is an IR-result-type coercion, not
   * a backend op, so it stays in lower.ts).
   */
  emitVecLen(layout: VecLayout, out: S): void;
  /**
   * vec ref on stack -> data-region handle. WasmGC leaves a `(ref $arr)`;
   * a linear backend would leave an `i32` base pointer. Both feed
   * `emitElemGet`, which closes the abstraction so `lower.ts` never reasons
   * about what is on the stack between the two calls.
   */
  emitVecDataPtr(layout: VecLayout, out: S): void;
  /** data-region handle + i32 index on stack -> element value. */
  emitElemGet(layout: VecLayout, out: S): void;
  /**
   * #1804 — N element values on the stack (e0 deepest … eN top) -> a fully
   * built vec ref. WasmGC: `array.new_fixed $arr N`, stash the data ref in
   * `dataScratchLocal`, push `i32.const N` (length, field 0), re-load the data
   * ref (field 1), `struct.new $vec`. Linear: bump-allocate
   * `[header][len=N][cap=N][e0…eN]` and leave the base i32 (or `notImplemented`).
   * `dataScratchLocal` is a function-local index of the array's ValType,
   * allocated lazily by `lower.ts`.
   */
  emitVecNewFixed(layout: VecLayout, count: number, dataScratchLocal: number, out: S): void;

  // ---- scalars / locals / globals / control flow (Phase-1 stage 1) ----
  /** Emit a `const` IR instr's literal op(s). Delegates to the shared free fn. */
  emitConst(instr: Extract<IrInstr, { kind: "const" }>, funcName: string, out: S): void;
  /** Pass-through binary op (`f64.add`, `i32.eq`, `i32.and`, ...). Bitwise
   * `js.*` ops are lowered earlier in lower.ts and never reach here. */
  emitBinary(op: IrBinop, out: S): void;
  /** Pass-through unary op. */
  emitUnary(op: IrUnop, out: S): void;
  emitLocalGet(index: number, out: S): void;
  emitLocalSet(index: number, out: S): void;
  emitLocalTee(index: number, out: S): void;
  emitGlobalGet(index: number, out: S): void;
  emitGlobalSet(index: number, out: S): void;
  emitDrop(out: S): void;
  emitSelect(out: S): void;
  emitReturn(out: S): void;
  emitUnreachable(out: S): void;
  /** Structured if. then/else are already lowered into their own sink. */
  emitIf(blockType: BlockType, then: S, els: S, out: S): void;
  emitBr(depth: number, out: S): void;
  emitBrIf(depth: number, out: S): void;

  // ---- (a3) control-flow family — MIGRATED behind the trait (#1584 §2a) ----
  // The structured `block` / `loop` wrappers. The caller (real `lower.ts`)
  // pre-lowers the wrapped region into its own sink (via `newSink()`), embedding
  // any `br` / `br_if` whose `depth` counts block/loop nesting outward (De Bruijn).
  // WasmGc realizes them as byte-identical `{op:"block",body}` / `{op:"loop",body}`
  // — the WasmGC `Instr` stream is unchanged. Bytecode realizes them by splicing
  // `body` and resolving its pending `br`/`br_if` jumps to `JZ`/`JNZ`/`JMP` with
  // backpatched targets (block ⇒ forward exit label, loop ⇒ backward header
  // label), exactly as `emitIf` already lowers structured `if` (issue §1c/§2a:
  // "loop / block / br_if … lowered to JZ/JNZ/JMP + backpatch labels").
  /** Wrap `body` in a structured block; `body` was built via `newSink()`. */
  emitBlock(blockType: BlockType, body: S, out: S): void;
  /** Wrap `body` in a structured loop; `body` was built via `newSink()`. */
  emitLoop(blockType: BlockType, body: S, out: S): void;

  // ---- NOT YET MOVED (declared for #1714+ staging; see issue Scope) ----
  // The following are part of the full seam the spec audited but are NOT
  // routed through the trait in Phase 1 (#1713). They remain inline in
  // lower.ts. Declared here so the staged groups (aggregate / union /
  // closure / ref-coercion) have a stable signature to migrate against and
  // #1714 knows the shape of the not-yet-moved surface. A `WasmGcEmitter`
  // need not implement them until its group is wired.
  emitBox?(layout: IrUnionLowering, out: Instr[]): void;
  emitUnbox?(layout: IrUnionLowering, out: Instr[]): void;
  emitTagLoad?(layout: IrUnionLowering, out: Instr[]): void;
  emitNull?(irType: IrType, out: Instr[]): void;
  emitToExternref?(out: Instr[]): void;
  emitFromExternref?(layout: { typeIdx: number } | IrType, out: Instr[]): void;
  emitFuncRef?(funcIdx: number, out: Instr[]): void;
  emitClosureNew?(layout: IrClosureLowering, captureCount: number, out: Instr[]): void;
  emitClosureFuncGet?(layout: IrClosureLowering, out: Instr[]): void;
  emitCaptureGet?(layout: IrClosureLowering, index: number, out: Instr[]): void;
  emitRefCellNew?(layout: IrRefCellLowering, out: Instr[]): void;
  emitRefCellGet?(layout: IrRefCellLowering, out: Instr[]): void;
  emitRefCellSet?(layout: IrRefCellLowering, out: Instr[]): void;

  // ---- (a1) call family — MIGRATED behind the trait (#1584 §2a) -----------
  // The first op-family to move from inline `lower.ts` pushes to typed trait
  // primitives. WasmGc/Linear realize them as byte-identical `{op:"call"}` /
  // `{op:"call_ref"}`; Bytecode realizes `OP.CALL` / `OP.CALL_REF`. Generic
  // over the sink `S` (the a0-tail seam) so both backends drive the same arms.
  /** Direct call to compiled function `funcIdx`. Args already on the stack. */
  emitCall(funcIdx: number, out: S): void;
  /** Indirect call through a typed funcref already on the stack. */
  emitCallRef(funcTypeIdx: number, out: S): void;

  // ---- (a2) struct/object family — MIGRATED behind the trait (#1584 §2a) ---
  // The object struct ops (object.new / object.get / object.set). WasmGc/Linear
  // realize them as byte-identical `{op:"struct.new"}` / `{op:"struct.get"}` /
  // `{op:"struct.set"}`; Bytecode realizes `OP.STRUCT_NEW` / `STRUCT_GET` /
  // `STRUCT_SET` over a VM heap (struct ref ≡ f64(heapIndex), null ≡ f64(-1)).
  /** Allocate an aggregate from `fieldCount` values already on the stack
   * (canonical field order, field0 deepest); leaves the new struct ref. */
  emitAggregateNew(layout: IrObjectStructLowering, fieldCount: number, out: S): void;
  /** struct ref on stack -> the named field's value. */
  emitFieldGet(layout: IrObjectStructLowering | IrClassLowering, name: string, out: S): void;
  /** struct ref + value on stack -> writes the named field (void). */
  emitFieldSet(layout: IrObjectStructLowering | IrClassLowering, name: string, out: S): void;

  // ---- (a4) try-throw family — MIGRATED behind the trait (#1584 §2a) --------
  // The exception ops (throw / try / rethrow). The caller (real `lower.ts`)
  // pre-lowers the try/catch/finally regions into their own sinks (via
  // `newSink()`), exactly as it builds the WasmGC `try`'s body/catch/catchAll as
  // separate `Instr[]`. WasmGc realizes them byte-identically (`{op:"throw"}` /
  // `{op:"try",body,catches,catchAll}` / `{op:"rethrow"}`); Bytecode realizes
  // `OP.THROW` / `OP.TRY_START`+`TRY_END` + an `exceptionTable` sink field
  // (issue §1c/§2a). Finally semantics are compiled away in `lower.ts` (inlined
  // on every exit path + an inner try/catch_all+rethrow), so neither backend
  // needs a finally concept — both only see throw/try/catch_all/rethrow.
  /** Throw the exception value already on the stack via the `__exn` tag. */
  emitThrow(tagIdx: number, out: S): void;
  /** Re-throw the currently-caught exception (`depth` levels out; lower.ts
   * only emits depth 0 today). */
  emitRethrow(depth: number, out: S): void;
  /** Structured try. `body` / each catch `body` / `catchAll` are pre-lowered
   * into their own sinks (built via `newSink()`). `catches[i].tagIdx` selects
   * the handler by exception tag. */
  emitTry(blockType: BlockType, body: S, catches: { tagIdx: number; body: S }[], catchAll: S | undefined, out: S): void;
}
