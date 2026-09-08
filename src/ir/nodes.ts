// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Middle-end SSA IR — per spec #1131.
//
// This file is intentionally separate from `types.ts` (the backend Wasm IR).
// The middle-end IR sits between the TypedAST and the Wasm IR, and carries:
//   - Symbolic references to functions, globals, and types (not raw indices).
//   - Typed SSA value nodes carrying IrType, not ValType.
//   - Basic-block structure with block arguments (linear SSA with blockargs).
//   - Source location metadata (for error reporting and debug info).
//
// Phase 1 scope: the smallest set of node shapes needed to describe
// `function f(): number { return <literal>; }`. The union is open —
// Phase 2 & 3 widen the Instr and Terminator sets.

import type { IrAsyncPlan, PreparedIrAsyncRuntime } from "./async-plan.js";
// #3954 phase 2 — the ECMAScript-specific instruction kinds. This is the ONE
// sanctioned core->dialect import; `scripts/check-ir-dialect.mjs` fails the
// build on any other. Type-only, so the core<->dialect cycle has no runtime edge.
import type {
  IrInstrAsyncReturn,
  IrInstrAsyncThrow,
  IrInstrAwait,
  IrInstrDynEq,
  IrInstrDynMemberGet,
  IrInstrDynMemberSet,
  IrInstrDynToNumber,
  IrInstrDynTruthy,
  IrInstrExternCall,
  IrInstrExternNew,
  IrInstrExternProp,
  IrInstrExternPropSet,
  IrInstrForOfIter,
  IrInstrForOfString,
  IrInstrGenEpilogue,
  IrInstrGenPush,
  IrInstrGenSetReturn,
  IrInstrGenYieldStar,
  IrInstrIterDone,
  IrInstrIterNew,
  IrInstrIterNext,
  IrInstrIterReturn,
  IrInstrIterValue,
  IrInstrRegExpLiteral,
  IrInstrStringCharAt,
  IrInstrStringCharCodeAt,
  IrInstrStringRepeat,
} from "./dialect/js.js";
import type { IrFunctionIdentity } from "../shared/contracts/ir-identity.js";
import type { IntrinsicId, IntrinsicSignatureVersion } from "./intrinsics.js";
// #3954 phase 3 (W4) — `js-tag.ts` is no longer imported here at all. The last
// two references were `unbox.jsTag` / `tag.test.jsTag`; both now carry the
// neutral `TagId` below, so the IR's core node module names no ECMAScript
// partition, in a type position or otherwise.
import type { IrStringConcatMode, IrStringEncoding } from "./string-runtime.js";
import type { IrFnctorShape } from "./fnctor-abi.js";
// #3954 phase 1 — the tag-domain seam. `IrType`'s dynamic leaf carries an
// OPAQUE `TagId` resolved against a `TagDomain` (`producer.ts` picks the
// producer's domain), not a bare ECMAScript `JsTag`. `core/tag-refinement.ts` is itself
// a ZERO-import leaf, so this adds a graph edge with no back edge and no TDZ
// exposure — the same property `js-tag.ts`'s header protects.
import type { TagId } from "./core/tag-refinement.js";
import type {
  IrTypeRef,
  IrObjectShape,
  IrClosureSignature,
  IrClassMemberKind,
  IrClassShape,
  IrType,
} from "./core/types.js";
export type {
  IrTypeBinding,
  IrTypeRef,
  IrVecLayoutRef,
  IrObjectShape,
  IrClosureSignature,
  IrClassFieldDescriptor,
  IrClassMemberKind,
  IrClassMethodDescriptor,
  IrClassShape,
  IrType,
} from "./core/types.js";
export {
  IR_CLASS_SHAPE_CELL,
  irVal,
  irVec,
  irFnctor,
  asVal,
  irDynamic,
  irTypeEquals,
  classShapeEquals,
  closureSignatureEquals,
  objectShapeEquals,
} from "./core/types.js";
import type { ValType } from "./types.js";
import type { IrDomCallbackAuthority } from "./capability-provenance.js";
import type { IrCallableBinding, IrFuncRef, IrGlobalBinding, IrGlobalRef } from "./value-references.js";
export type { IrDomCallbackAuthority } from "./capability-provenance.js";
export type { IrCallableBinding, IrFuncRef, IrGlobalBinding, IrGlobalRef } from "./value-references.js";

/**
 * Wrap a ValType as an IrType with an explicit signedness fact (#1126 Stage 1).
 * Use this only for `i32` ValTypes where the value-domain (signed `int32` vs
 * unsigned `uint32`) is known. For non-i32 ValTypes the `signed` flag is
 * meaningless; callers should use `irVal()` instead.
 *
 * The flag is read by Stage 3 emit decisions (signed vs unsigned shifts,
 * comparisons, conversions back to f64). For Stage 1 it is purely additive —
 * no existing emitter consults it yet.
 */
export function irValSigned(v: ValType, signed: boolean): IrType {
  return { kind: "val", val: v, signed };
}

/** #2949 slice 1 — narrow an IrType to its dynamic arm (refined or not). */
export function isDynamic(t: IrType): t is Extract<IrType, { kind: "dynamic" }> {
  return t.kind === "dynamic";
}

// ---------------------------------------------------------------------------
// SSA values
// ---------------------------------------------------------------------------

/**
 * An SSA value ID — uniquely identifies one defining instruction or block arg
 * within one IrFunction. Values are NOT shared across functions.
 *
 * Represented as a branded number for cheap comparison + map-key use. `-1`
 * is reserved as an intentionally invalid sentinel and must never appear in
 * an emitted IR graph.
 */
export type IrValueId = number & { readonly __brand: "IrValueId" };

export function asValueId(n: number): IrValueId {
  return n as IrValueId;
}

/**
 * #2952 slice 2 — per-function-unique identity of a loop (or, in slice 3, a
 * labeled block) that `br.label` can target. Like {@link IrValueId} it is a
 * branded number allocated by the builder; unlike an SSA value it names a
 * CONTROL-FLOW frame, not a value. Labels are semantic: the Wasm `br` depth
 * is NEVER stored in the IR — it is derived at lowering time by the
 * `ctrlStack` frame counter in `lower.ts` (a stored depth would rot under
 * any pass that re-nests buffers).
 */
export type IrLabelId = number & { readonly __brand: "IrLabelId" };

export function asLabelId(n: number): IrLabelId {
  return n as IrLabelId;
}

/**
 * Stable identity of an allocation site (#1586).
 *
 * Unlike {@link IrValueId} — which is a per-function SSA index that inlining
 * and monomorphization renumber — an `AllocSiteId` is **module-global** and
 * travels on the instruction itself (`IrInstrBase.alloc`). It survives every
 * IR transformation: passes preserve it through value-preserving rewrites,
 * alias it through fusion, and retire it on deletion (see the pass-discipline
 * rules in docs/adr/0013-ir-allocation-sites.md).
 *
 * Identity MUST NOT be keyed on `IrValueId` — that breaks under renumbering.
 */
export type AllocSiteId = number & { readonly __brand: "AllocSiteId" };

export function asAllocSiteId(n: number): AllocSiteId {
  return n as AllocSiteId;
}

/**
 * The category of value an allocation site brings into existence. Mirrors the
 * value-creating IR instr kinds (object.new, closure.new, …). Black-box
 * built-in internal allocations are out of scope (#1586 non-goals).
 */
export type AllocKind =
  | "object"
  | "array"
  | "string"
  | "closure"
  | "refcell"
  | "box"
  | "extern"
  | "iterator"
  | "generator";

/** Allocate sequential IrValueIds within a function. */
export class IrValueIdAllocator {
  private next = 0;
  fresh(): IrValueId {
    return asValueId(this.next++);
  }
  get count(): number {
    return this.next;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export type IrConst =
  | { readonly kind: "i32"; readonly value: number }
  | { readonly kind: "i64"; readonly value: bigint }
  | { readonly kind: "f32"; readonly value: number }
  | { readonly kind: "f64"; readonly value: number }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "null"; readonly ty: IrType }
  | { readonly kind: "undefined" };

// ---------------------------------------------------------------------------
// Instructions (pure, side-effecting, and memory ops)
// ---------------------------------------------------------------------------
//
// An IrInstr defines zero or one SSA values (`result`). Multi-result support
// (for destructuring / tuple returns) is deferred to Phase 2.
//
// `site` carries source-location info for diagnostics and source maps. It's
// kept minimal — line/column — and is optional so Phase 1 builders can omit
// it without the verifier complaining.

export interface IrSiteId {
  readonly line: number;
  readonly column: number;
}

export interface IrInstrBase {
  /** SSA def produced by this instr. `null` for void instrs. */
  readonly result: IrValueId | null;
  /** Static type of the result, if any. Redundant w/ `result`'s type but kept local for verifier speed. */
  readonly resultType: IrType | null;
  /** Source location for diagnostics. Optional in Phase 1. */
  readonly site?: IrSiteId;
  /**
   * Stable allocation-site identity (#1586). Present iff this instr is a
   * value-creating (allocation) site — see {@link AllocKind} and the audit
   * table in docs/adr/0013-ir-allocation-sites.md. Distinct from `result`
   * (an `IrValueId`, which inlining/monomorphize renumber). Inert at
   * lowering, so the emitted Wasm is byte-identical whether or not it is set.
   */
  readonly alloc?: AllocSiteId;
}

/** Materialize a constant into an SSA value. */
export interface IrInstrConst extends IrInstrBase {
  readonly kind: "const";
  readonly value: IrConst;
}

/** Call a function by symbolic reference. Return value (if any) is `result`. */
export interface IrInstrCall extends IrInstrBase {
  readonly kind: "call";
  readonly target: IrFuncRef;
  readonly args: readonly IrValueId[];
}

/** Backend primitive choices available to the first semantic-intrinsic family. */
export type IrIntrinsicBackendOp = "f64.abs" | "f64.sqrt" | "f64.floor" | "f64.ceil" | "f64.trunc";

/** Closed multi-op backend expansions available to semantic intrinsics. */
export type IrIntrinsicBackendSequence = "f64.fround";

/** Closed backend-neutral composite scalar semantics with backend-owned scratch. */
export type IrIntrinsicBackendComposite = "math.clz32" | "math.imul" | "math.max" | "math.min" | "to-uint32";

/**
 * Provider attachment selected after middle-end transforms and manifest
 * freeze. Source/type lowering emits no provider; preparation attaches a
 * backend primitive, closed composite expansion, or exact symbolic callable.
 */
export type IrIntrinsicProvider =
  | { readonly kind: "backend-op"; readonly opcode: IrIntrinsicBackendOp }
  | { readonly kind: "backend-sequence"; readonly sequence: IrIntrinsicBackendSequence }
  | { readonly kind: "backend-composite"; readonly operation: IrIntrinsicBackendComposite }
  | { readonly kind: "callable"; readonly target: IrFuncRef };

/**
 * Versioned semantic intrinsic. Unlike `call`, this names source meaning, not
 * a concrete runtime helper. The optional provider is a preparation artifact
 * and must be present before backend lowering.
 */
export interface IrInstrIntrinsic extends IrInstrBase {
  readonly kind: "intrinsic";
  readonly id: IntrinsicId;
  readonly version: IntrinsicSignatureVersion;
  readonly args: readonly IrValueId[];
  readonly provider?: IrIntrinsicProvider;
}

/** Read a global by symbolic reference. */
export interface IrInstrGlobalGet extends IrInstrBase {
  readonly kind: "global.get";
  readonly target: IrGlobalRef;
}

/** Write a global by symbolic reference. Void-result. */
export interface IrInstrGlobalSet extends IrInstrBase {
  readonly kind: "global.set";
  readonly target: IrGlobalRef;
  readonly value: IrValueId;
}

/**
 * Typed binary primitive. The `op` tag encodes both operand type(s) and the
 * operation, so the lowerer can map 1:1 to a Wasm instruction without
 * re-inferring types. Phase 1 covers the numeric/bool subset.
 */
export type IrBinop =
  // f64 arithmetic
  | "f64.add"
  | "f64.sub"
  | "f64.mul"
  | "f64.div"
  | "f64.copysign"
  // f64 comparison → i32 (bool)
  | "f64.eq"
  | "f64.ne"
  | "f64.lt"
  | "f64.le"
  | "f64.gt"
  | "f64.ge"
  // i32 comparison (used for bool === / !==) → i32
  | "i32.eq"
  | "i32.ne"
  // i32 logical (for bool && / || — operands assumed 0|1)
  | "i32.and"
  | "i32.or"
  // Exact-bit comparison used by the numeric default-parameter sentinel.
  | "i64.eq"
  // (#3758) Native i32 arithmetic — WRAPS modulo 2^32 on overflow, matching
  // ECMA-262 ToInt32's wrap semantics exactly (unlike `i32.trunc_sat_f64_s`,
  // which SATURATES to INT32_MIN/MAX instead — the distinction that made a
  // prior attempt in this area unsound and reverted, see #3745's history).
  // Only emitted by `ir/from-ast.ts`'s `emitI32PureArithmetic` for operand
  // subtrees PROVEN to be built entirely from already-int32-range leaves
  // (i32-coerced locals, in-range literals, or nested bitwise/shift results,
  // which are ALWAYS int32-range by ECMA-262 spec regardless of their own
  // operands). `i32.add`/`i32.sub` need no extra guard (f64 add/sub of two
  // int32-range operands is exact, |a±b| < 2^32 < 2^53, so wrapping the exact
  // sum mod 2^32 via native i32.add is bit-identical to ToInt32(a+b)). `i32.mul`
  // additionally requires the `isI32MulSafe` guard (at least one operand a
  // "small" literal, |n| < 2^21) to match legacy's OWN i32.mul guard
  // (`src/codegen/binary-ops.ts`) — not for wrap correctness (native i32.mul
  // always wraps exactly) but because JS `*` computes in f64 first: for large
  // operands the true product can exceed 2^53 and round, so an EXACT native
  // i32.mul can diverge from what JS's (lossy) float64 multiply then ToInt32
  // would produce. The guard keeps native i32.mul's exact result aligned with
  // JS's actual (here lossless) float64 semantics.
  //
  // (#3741) Also emitted by the i32-SLOT-PROMOTION lowering
  // (`emitPromotedI32Step` / `lowerAsI32` in `ir/from-ast.ts`) for the same
  // ToInt32-guaranteed positions: an `a + b` under a bitwise wrapper, and the
  // `i++` / `i += <int literal>` step of a promoted counter. Same soundness
  // argument, same #1236 boundary — the general `+`/`-` lowering stays
  // f64-only.
  | "i32.add"
  | "i32.sub"
  | "i32.mul"
  // Guarded JS Number remainder fast path. The AST-to-IR lowerer emits this
  // only after proving or checking that both f64 operands are exact signed-i64
  // integers, the divisor is non-zero, and INT64_MIN / -1 is excluded.
  | "i64.rem_s"
  // #1126 Stage 3 — native i32 magnitude compares. Emitted by the
  // AST→IR lowerer when both operands of `<`, `<=`, `>`, `>=` are
  // i32-typed (a bool, a comparison result, or an i32-domain value
  // out of `js.bit*`). Signed vs unsigned is picked from the operands'
  // `IrType.val.signed` flag (signed if either is signed; unsigned only
  // when BOTH are unsigned `u32`). Result is i32 (bool).
  | "i32.lt_s"
  | "i32.le_s"
  | "i32.gt_s"
  | "i32.ge_s"
  | "i32.lt_u"
  | "i32.le_u"
  | "i32.gt_u"
  | "i32.ge_u"
  // Slice 11 (#1169n) — JS bitwise ops on f64 operands.
  // Each lowers to: ToInt32(lhs); ToInt32(rhs); i32.<op>; convert back to f64.
  // The `js.*` prefix marks them as composite (multi-Wasm-instr) ops; the
  // lowerer's `case "binary"` arm dispatches on this prefix to emit the
  // ToInt32 / convert dance using a per-function shared scratch local.
  // Result type is f64 for all.
  //
  // #1126 Stage 3 — when BOTH operands' IrTypes are already i32-shaped,
  // the lowerer emits the native `i32.*` op directly and skips the
  // ToInt32 dance. The AST→IR lowerer also narrows the result type
  // from f64 to i32 in that case so chains of bitwise ops (e.g. an
  // FNV-1a hash mixer `(h ^ b) * P | 0`) stay in the i32 domain.
  | "js.bitand"
  | "js.bitor"
  | "js.bitxor"
  | "js.shl"
  | "js.shr_s"
  | "js.shr_u";

/**
 * Typed unary primitive. `f64.neg` negates a number. `i32.eqz` implements
 * bool negation (`!x` where x is bool — 0↔1).
 *
 * Slice 12 (#1169o) adds `i32.trunc_sat_f64_s` — saturating f64 → i32
 * truncation. Used to convert a JS-style f64 array index into the i32
 * the backend `vec.get` instruction expects. Saturation handles
 * NaN→0 and out-of-range values gracefully (no trap), matching what
 * test262's array-indexing patterns expect.
 */
export type IrUnop =
  | "f64.neg"
  // (#3214 A) Bit-exact caller-side sNaN sentinel for expression defaults.
  | "f64.reinterpret_i64"
  // Reverse bit-cast used by a lifted closure to recognize that sentinel.
  | "i64.reinterpret_f64"
  | "i32.eqz"
  | "i32.trunc_sat_f64_s"
  // Trapping conversion used only inside the proven/guarded remainder arm.
  | "i64.trunc_f64_s"
  // (#3168) boolean → f64 ToNumber for unary `+`/`-` (§7.1.4: false/true →
  // 0/1). Same pass-through footprint as the #1371 Math family below: the
  // WasmGC/linear emitters push the op tag verbatim (a valid `Instr` op); the
  // bytecode backend's `unopToOpcode` throws loudly for it (not in the #1584
  // production subset), exactly like `f64.abs` et al.
  | "f64.convert_i32_s"
  | "f64.convert_i64_s"
  // (#1371) Math.* unary ops that map 1:1 to a Wasm f64 instruction.
  // The IR's `case "unary"` lowerer already passes the `op` tag through
  // verbatim (lower.ts line 770), so we only need to extend the type
  // and the from-ast lowering surface.
  | "f64.abs"
  | "f64.sqrt"
  | "f64.floor"
  | "f64.ceil"
  | "f64.trunc"
  // (#1392) `ref.is_null` — tests whether a Wasm reference is null. Result
  // is i32 (1 if null, 0 otherwise). Used by the optional-chain lowering
  // to short-circuit `recv?.prop` when `recv` is null. The Wasm op is
  // valid for `ref` / `ref_null` / externref / funcref operands; the IR
  // type carrier on `IrInstrUnary.rand` must be a `val`-kind IrType
  // wrapping one of those.
  | "ref.is_null";

export interface IrInstrBinary extends IrInstrBase {
  readonly kind: "binary";
  readonly op: IrBinop;
  readonly lhs: IrValueId;
  readonly rhs: IrValueId;
}

export interface IrInstrUnary extends IrInstrBase {
  readonly kind: "unary";
  readonly op: IrUnop;
  readonly rand: IrValueId;
}

/**
 * Conditional expression — lowers to Wasm `select`. Both arms are evaluated;
 * this is safe for pure Phase 1 expressions (no calls, no side effects).
 * Branching control flow (for statements with side effects) comes in Phase 2
 * via `br_if` terminators.
 */
export interface IrInstrSelect extends IrInstrBase {
  readonly kind: "select";
  readonly condition: IrValueId;
  readonly whenTrue: IrValueId;
  readonly whenFalse: IrValueId;
}

/**
 * (#1392) Value-producing if/else expression. UNLIKE `select`, this
 * SHORT-CIRCUITS — only one branch's instructions are executed. Used by
 * the optional-chain lowering (`recv?.prop`) where the right-hand side
 * (`recv.prop`) MUST NOT execute when `recv` is null.
 *
 * The two arm buffers (`then` / `else`) are self-contained instruction
 * lists collected via `IrFunctionBuilder.collectBodyInstrs(...)`. They
 * may reference SSA values defined OUTSIDE the if-instr (those are
 * available through Wasm locals), but values defined INSIDE one arm are
 * NOT visible to the other arm or to instructions following the if.
 *
 * The carrier values are `thenValue` / `elseValue` — IrValueIds defined
 * inside the corresponding arm. The lowerer emits a Wasm
 * `if (result T) ... else ... end` block where each arm leaves its
 * carrier value on the stack; the post-block `local.set` binds the
 * result to the if-instr's `result` SSA value.
 *
 * Both arms must produce values of `resultType`. The verifier rejects
 * shape mismatches.
 */
export interface IrInstrIf extends IrInstrBase {
  readonly kind: "if";
  readonly cond: IrValueId;
  readonly then: readonly IrInstr[];
  readonly thenValue: IrValueId;
  readonly else: readonly IrInstr[];
  readonly elseValue: IrValueId;
}

/**
 * Escape hatch: a raw backend instruction sequence with no SSA structure.
 * Phase 1 uses this as a bridge so we can describe any function without
 * re-encoding the whole Wasm opcode set in IR. Phase 2 will narrow uses.
 * The verifier treats it as an opaque block: stack contract must match.
 */
export interface IrInstrRawWasm extends IrInstrBase {
  readonly kind: "raw.wasm";
  /** Backend ops to emit verbatim. */
  readonly ops: readonly import("./types.js").Instr[];
  /** Wasm value-stack delta after running `ops` (positive = pushes). */
  readonly stackDelta: number;
}

/**
 * Box a value into a tagged carrier. Two targets (discriminated by
 * `toType.kind` — ONE boxing concept in the IR, the type system carries the
 * representation):
 *
 *   - `toType.kind === "union"` (V1, scalar tagged unions): `members` must
 *     contain `value`'s static ValType. Lowering emits `struct.new
 *     $union_<members>` with the matching tag constant + the value in the
 *     `$val` field. Result is `(ref $union_<members>)`.
 *   - `toType.kind === "dynamic"` (#2949): erase `value` into the module's
 *     canonical boxed-any carrier (per the #1852 table — `$AnyValue` family
 *     on WasmGC, routed through the existing `__any_box_*` helpers; never a
 *     second boxing engine). `value` must NOT itself be dynamic (a re-box is
 *     provably redundant — the verifier rejects it). Lowering lands in
 *     #2949 slice 3; until then the lowerer throws a staged error.
 */
export interface IrInstrBox extends IrInstrBase {
  readonly kind: "box";
  readonly value: IrValueId;
  readonly toType: IrType;
}

/**
 * Unbox a tagged value to a concrete payload. The caller must have proved
 * the tag already (via `tag.test` earlier in the same IR path); lowering
 * emits a payload read without a runtime tag check. A debug-mode assertion
 * can still verify the tag.
 *
 *   - union operand (V1): `tag` (REQUIRED here) names the member ValType to
 *     extract; lowers to `struct.get $val`.
 *   - dynamic operand (#2949): `tagId` (REQUIRED here) names the proven
 *     partition of the producer's {@link TagId} domain; it must have a payload
 *     (`domain.carrierKindOf(tagId) !== null` — a SINGLETON partition, e.g.
 *     ECMAScript's Null/Undefined, cannot be unboxed). `tag`, when also
 *     present, must be consistent with the partition's payload kind (exact for
 *     scalar carriers, ref-shaped for reference carriers). Lowering lands in
 *     #2949 slice 3.
 *
 * #3954 phase 3 (W4) — `tagId` is the NEUTRAL `TagId`, not the ECMAScript
 * `JsTag` enum. It was `jsTag: JsTag` until this slice, which made the field an
 * ECMAScript declaration sitting on a core-neutral node; worse, the brand is
 * ONE-DIRECTIONAL (TypeScript assigns a branded `number` straight to a numeric
 * enum), so a foreign domain's tag flowed in with no cast and failed at run
 * time in the verifier instead of at compile time. The field is renamed as well
 * as re-typed: every construction site had to change anyway (the brand blocks
 * `JsTag → TagId`), and a `js`-prefixed name carrying a neutral id would have
 * survived the widening as a lie.
 */
export interface IrInstrUnbox extends IrInstrBase {
  readonly kind: "unbox";
  readonly value: IrValueId;
  /** Target member ValType — REQUIRED for union operands (V1 contract). */
  readonly tag?: ValType;
  /** Proven domain partition — REQUIRED for dynamic operands (#2949). */
  readonly tagId?: TagId;
}

/**
 * Runtime tag discriminator — result (via `IrInstrBase.result`) is `i32`,
 * 1 if `value`'s runtime tag matches, else 0.
 *
 *   - union operand (V1): `tag` (REQUIRED here) must be a member ValType;
 *     lowers to `struct.get $tag; i32.const <N>; i32.eq`.
 *   - dynamic operand (#2949): `tagId` (REQUIRED here) names the domain
 *     partition under test — ANY partition, including a payload-less singleton
 *     (ECMAScript's Null/Undefined — testing for them is the point). Lowering
 *     (slice 3) dispatches on the carrier's runtime tag via the canonical
 *     classifier path (`emitTagLoad`/`emitTagTest` on the backend emitter).
 *
 * #3954 phase 3 (W4) — `tagId` is the NEUTRAL `TagId`; see `IrInstrUnbox` for
 * why the field was renamed as well as re-typed.
 */
export interface IrInstrTagTest extends IrInstrBase {
  readonly kind: "tag.test";
  readonly value: IrValueId;
  /** Member ValType under test — REQUIRED for union operands (V1 contract). */
  readonly tag?: ValType;
  /** Domain partition under test — REQUIRED for dynamic operands (#2949). */
  readonly tagId?: TagId;
}

// ---------------------------------------------------------------------------
// String operations (#1169a — IR Phase 4 Slice 1)
// ---------------------------------------------------------------------------
//
// All string ops are backend-agnostic at the IR level: they carry the raw
// JS string value (for `string.const`) or operand IDs, and rely on the
// `IrLowerResolver` to emit the appropriate backend op sequence (host
// `wasm:js-string` builtins vs. native NativeString GC structs).

/**
 * Materialize a string literal as an SSA value of `IrType.string`. The
 * backend representation is determined by `IrLowerResolver.emitStringConst`:
 *   - host strings → register a `string_constants.<value>` global import,
 *                    emit `global.get`.
 *   - native       → read an interned immutable literal global, or call the
 *                    prepared materializer for an oversized literal.
 */
export interface IrInstrStringConst extends IrInstrBase {
  readonly kind: "string.const";
  /** Raw JS string; the lowerer treats `value.length` as UTF-16 code units. */
  readonly value: string;
  /**
   * Exact immutable storage selected during final program preparation.
   *
   * Inference deliberately leaves this absent. The WasmGC preparation layer
   * attaches either the host `string_constants` import or the interned native
   * literal global before a component can seal, so lowering never has to
   * discover or allocate literal storage mid-emission.
   */
  readonly storage?: IrGlobalRef;
  /**
   * Exact backend callable selected when the literal cannot use immutable
   * storage. Mutually exclusive with `storage`; production preparation uses
   * this only for native literals beyond the backend's fixed-array limit.
   */
  readonly materializer?: IrFuncRef;
}

/**
 * Concatenate two strings — the ECMAScript `s1 + s2` operator restricted to
 * the case where both operands are statically known to be strings. Result
 * type: `IrType.string`.
 */
export interface IrInstrStringConcat extends IrInstrBase {
  readonly kind: "string.concat";
  readonly lhs: IrValueId;
  readonly rhs: IrValueId;
  /** Producer proof for the result; the encoding pass validates/records it. */
  readonly encodingEvidence?: IrStringEncoding;
  /** `owned-append` is legal only after the producer proves prior values unobservable. */
  readonly concatMode?: IrStringConcatMode;
  /** Semantic callable intent bound to the exact backend provider during preparation. */
  readonly provider?: IrFuncRef;
}

/**
 * String equality. `===` and `!==` are both modeled via this single instr —
 * `negate: true` ↔ `!==`. Result type: `i32` (bool).
 */
export interface IrInstrStringEq extends IrInstrBase {
  readonly kind: "string.eq";
  readonly lhs: IrValueId;
  readonly rhs: IrValueId;
  readonly negate: boolean;
  /** Semantic callable intent bound to the exact backend provider during preparation. */
  readonly provider?: IrFuncRef;
}

/**
 * String length — corresponds to the JS `s.length` property access. Despite
 * the underlying Wasm op returning `i32`, the IR result is `f64` to match
 * JS Number semantics, so consumers can compose with the rest of the
 * numeric IR without an extra coercion step. Lowering inserts the
 * `f64.convert_i32_s` after the backend's length op.
 */
export interface IrInstrStringLen extends IrInstrBase {
  readonly kind: "string.len";
  readonly value: IrValueId;
  readonly inputEncoding?: IrStringEncoding;
  /** Exact backend provider selected during final program preparation. */
  readonly provider?: IrStringLengthProvider;
}

/** Backend-selected dependency for the representation-neutral `string.len`. */
export type IrStringLengthProvider =
  | {
      readonly kind: "callable";
      /** Host `wasm:js-string.length` import. */
      readonly target: IrFuncRef;
    }
  | {
      readonly kind: "struct-field";
      /** Native `$AnyString` layout; field 0 is the UTF-16 code-unit length. */
      readonly ownerType: IrTypeRef;
      readonly fieldIndex: number;
    };

// ---------------------------------------------------------------------------
// Function-style constructor operations (#3521)
// ---------------------------------------------------------------------------

/**
 * Materialize one source-qualified function-style constructor instance.
 * `captureArgs` is the flattened legacy capture ABI: all capture values in
 * capture order, followed by all paired TDZ flags in capture order;
 * `args` is the user-visible constructor ABI. The hidden
 * constructor identity is explicit so standalone lowering can preserve the
 * exact trailing parameter without recovering it from a display name.
 *
 * This checkpoint only defines and verifies the contract. Lowering remains
 * fail-closed until a backend resolves the nominal shape.
 */
export interface IrInstrFnctorNew extends IrInstrBase {
  readonly kind: "fnctor.new";
  readonly shape: IrFnctorShape;
  readonly captureArgs: readonly IrValueId[];
  readonly args: readonly IrValueId[];
  readonly constructorIdentity: IrValueId | null;
}

/** Read one field from a nominal function-style constructor instance. */
export interface IrInstrFnctorGet extends IrInstrBase {
  readonly kind: "fnctor.get";
  readonly shape: IrFnctorShape;
  readonly value: IrValueId;
  readonly fieldName: string;
}

// ---------------------------------------------------------------------------
// Object operations (#1169b — IR Phase 4 Slice 2)
// ---------------------------------------------------------------------------

/**
 * Materialize an object literal as a WasmGC struct. `shape` declares the
 * struct's field layout (already canonically sorted by name); `values` is
 * parallel to `shape.fields` and must have the same length. Lowering emits
 * each value in canonical order followed by `struct.new $obj_<shape>`.
 *
 * Result type: `{ kind: "object", shape }`.
 */
export interface IrInstrObjectNew extends IrInstrBase {
  readonly kind: "object.new";
  readonly shape: IrObjectShape;
  readonly values: readonly IrValueId[];
}

/**
 * Read a named field from an object. `value` must be of `IrType.object`
 * with a shape whose `fields` contain `name`. Lowering emits
 * `struct.get $obj_<shape> <fieldIdx>`.
 *
 * Result type: the field's IrType (must match `resultType`).
 */
export interface IrInstrObjectGet extends IrInstrBase {
  readonly kind: "object.get";
  readonly value: IrValueId;
  readonly name: string;
}

/**
 * Write a named field on an object. `value` must be `IrType.object`,
 * `newValue` must match the field's IrType. Void result. Lowering emits
 * `struct.set $obj_<shape> <fieldIdx>`.
 */
export interface IrInstrObjectSet extends IrInstrBase {
  readonly kind: "object.set";
  readonly value: IrValueId;
  readonly name: string;
  readonly newValue: IrValueId;
}

// ---------------------------------------------------------------------------
// Closure + ref-cell operations (#1169c — IR Phase 4 Slice 3)
// ---------------------------------------------------------------------------

/**
 * Materialize a closure value. `liftedFunc` structurally identifies the lifted
 * top-level function (registered in the IR module as a synthesized BuiltFn).
 * `signature` is the caller-visible signature (used to look up its allocation
 * wrapper + exact funcref type). `captures` populates an optional
 * captured subtype's fields parallel to `captureFieldTypes`; an empty capture
 * list constructs the exact wrapper itself.
 *
 * Lowering emits:
 *   ref.func $lifted
 *   <push each capture>
 *   struct.new $closure_<signature>_<captureSig>
 *
 * Result type: `{ kind: "closure"; signature }`. The Wasm-level SSA carrier is
 * the canonical wrapper root; construction still creates the signature
 * wrapper or a captured subtype beneath it.
 */
export interface IrInstrClosureNew extends IrInstrBase {
  readonly kind: "closure.new";
  readonly liftedFunc: IrFuncRef;
  readonly signature: IrClosureSignature;
  /** Capture-field IrTypes in struct field order (post-funcref). */
  readonly captureFieldTypes: readonly IrType[];
  /** SSA values populating the capture fields, parallel to captureFieldTypes. */
  readonly captures: readonly IrValueId[];
  /** Checker-certified immediate one-shot host-boundary consumption. */
  readonly hostOneShot?: boolean;
  /** Exact reusable DOM callback authority. */
  readonly domCallbackAuthority?: IrDomCallbackAuthority;
}

/**
 * Read a capture field from the implicit `__self` closure struct. Only
 * valid inside a lifted closure body whose IrFunction carries
 * `closureSubtype` metadata. `index` is the 0-based capture position
 * (post-funcref).
 *
 * Lowering emits:
 *   <self>
 *   ref.cast $self_subtype
 *   struct.get $self_subtype (index+1)
 */
export interface IrInstrClosureCap extends IrInstrBase {
  readonly kind: "closure.cap";
  /** SSA value of the closure-typed __self param (the lifted func's param 0). */
  readonly self: IrValueId;
  readonly index: number;
}

/**
 * Invoke a compiler-owned closure or a boundary callable. `args` must match
 * the callee signature's params arity and types.
 *
 * Lowering emits:
 *   <emit/unpack callee>   ;; pushes canonical-root self
 *   <emit args>
 *   <emit/unpack callee>   ;; pushes self again — second use forces a Wasm local
 *   struct.get $wrapper_root $func
 *   ref.cast $lifted_func_type
 *   call_ref $lifted_func_type
 *
 * A `callable<S>` unpack converts externref→anyref and casts once to the
 * canonical wrapper root. The typed funcref cast performs the exact signature
 * check; `call_ref` receives that field-0 funcref, never the wrapper itself.
 *
 * Result type: `signature.returnType`, or null for a void call in statement
 * position.
 */
export interface IrInstrClosureCall extends IrInstrBase {
  readonly kind: "closure.call";
  readonly callee: IrValueId;
  readonly args: readonly IrValueId[];
}

/**
 * Wrap a primitive value in a fresh ref cell. Lowering:
 *   <emit value>
 *   struct.new $refcell_<inner>
 *
 * Result type: `{ kind: "boxed"; inner: <ValType of value> }`.
 */
export interface IrInstrRefCellNew extends IrInstrBase {
  readonly kind: "refcell.new";
  readonly value: IrValueId;
}

/**
 * Read the inner value out of a ref cell. `cell` must be `IrType.boxed`.
 * Result type is `irVal(cell.inner)`.
 *
 * Lowering: `<emit cell>; struct.get $refcell 0`.
 */
export interface IrInstrRefCellGet extends IrInstrBase {
  readonly kind: "refcell.get";
  readonly cell: IrValueId;
}

/**
 * Write a new value through a ref cell. `cell` must be `IrType.boxed`,
 * `value` ValType must equal `cell.inner`. Void result.
 *
 * Lowering: `<emit cell>; <emit value>; struct.set $refcell 0`.
 */
export interface IrInstrRefCellSet extends IrInstrBase {
  readonly kind: "refcell.set";
  readonly cell: IrValueId;
  readonly value: IrValueId;
}

// ---------------------------------------------------------------------------
// Class operations (#1169d — IR Phase 4 Slice 4)
// ---------------------------------------------------------------------------
//
// Class instances live as `(ref $ClassStruct)` at the Wasm level. The IR
// represents them via `IrType.class` carrying the full `IrClassShape`, and
// `IrInstrClass*` ops symbolically reference the class through `shape`.
// The lowerer's `resolveClass` maps `shape.className` → struct typeIdx +
// constructor / method funcIdx + per-field index, all of which were
// allocated by the legacy `collectClassDeclaration` pass before the IR
// runs.
//
// Slice 4 keeps class methods themselves on the legacy path. The IR only
// claims OUTER functions that USE class instances — `class.call` resolves
// to a direct `call $<className>_<methodName>` against the legacy-compiled
// method body, with `this` prepended as the first argument.

/**
 * Construct a class instance through the class-owned AST-free `_new` wrapper.
 *
 * Lowering:
 *   <emit each arg in order>
 *   call $<className>_new
 *
 * Result type: `{ kind: "class"; shape }`. The Wasm-level value type is
 * `(ref $ClassStruct)` (non-null). The wrapper allocates once and tail-calls
 * the exact source-owned `<className>_init`.
 */
export interface IrInstrClassNew extends IrInstrBase {
  readonly kind: "class.new";
  readonly shape: IrClassShape;
  readonly target?: IrFuncRef;
  readonly args: readonly IrValueId[];
}

/**
 * Read a named field from a class instance. `value` must be `IrType.class`
 * with a shape containing `fieldName`. Lowering emits:
 *   <emit value>
 *   struct.get $<className> <wasmFieldIdx>
 *
 * The wasm field index accounts for the legacy `__tag` prefix at field 0
 * — see `IrLowerResolver.resolveClass`.
 *
 * Result type: the field's IrType (also placed in `resultType`).
 */
export interface IrInstrClassGet extends IrInstrBase {
  readonly kind: "class.get";
  readonly value: IrValueId;
  readonly fieldName: string;
}

/**
 * Write a named field on a class instance. Void result. Lowering emits:
 *   <emit value>
 *   <emit newValue>
 *   struct.set $<className> <wasmFieldIdx>
 *
 * The legacy `collectClassDeclaration` pass widens all class fields to
 * `mutable: true`, so `struct.set` is always valid.
 */
export interface IrInstrClassSet extends IrInstrBase {
  readonly kind: "class.set";
  readonly value: IrValueId;
  readonly fieldName: string;
  readonly newValue: IrValueId;
}

/**
 * Invoke an instance method or accessor. `receiver` must be `IrType.class`
 * whose shape contains the (`memberKind`, `methodName`) pair. `methodName`
 * remains the source-level member name even for getters/setters; the resolver
 * owns their compatibility spelling. The implicit `this` is prepended as the
 * first call argument. Lowering emits:
 *   <emit receiver>
 *   <emit each arg in order>
 *   call $<resolved exact member binding>
 *
 * Result type: the member descriptor's `returnType`. A void method/setter has
 * `result: null` and `resultType: null`; the AST→IR lowerer rejects
 * such calls in expression position so we never see a void method as
 * `lowerExpr` output.
 */
export interface IrInstrClassCall extends IrInstrBase {
  readonly kind: "class.call";
  readonly receiver: IrValueId;
  readonly target?: IrFuncRef;
  readonly memberKind: Exclude<IrClassMemberKind, "static">;
  readonly methodName: string;
  readonly args: readonly IrValueId[];
}

/**
 * #3000-E: a derived constructor's `super(args)` call. Runs the PARENT class's
 * `<parent>_init` on the already-allocated `self` — NOT the parent's `_new`
 * (which would allocate a second, wrong-typed instance). The legacy backend
 * splits every WasmGC-struct class into `<Class>_new` (alloc + tail-call init)
 * and `<Class>_init` (`(...ctorParams, self) -> (ref $struct)` — field inits +
 * ctor body, self LAST), and lowers a derived `super(...)` to
 * `call <Parent>_init(args..., self)`. This instr mirrors that exactly.
 *
 * Statement-only (no SSA result): `<Parent>_init` returns `(ref $ParentStruct)`
 * but `super(...)` as a statement discards it, so the lowering drops the result.
 * `self` is a `(ref $SubStruct)` — a WasmGC subtype of `(ref $ParentStruct)`, so
 * the raw `call` typechecks. Lowering emits: <each arg>, <self>, call, drop.
 */
export interface IrInstrClassSuperInit extends IrInstrBase {
  readonly kind: "class.super_init";
  readonly parentShape: IrClassShape;
  readonly target?: IrFuncRef;
  readonly self: IrValueId;
  readonly args: readonly IrValueId[];
}

/**
 * #3000-E: a `super.method(args)` call inside a subclass method. Static-dispatches
 * to the PARENT's method slot (`<parent>_<method>`) with the subclass receiver.
 * Unlike `class.call` (which resolves the method against the RECEIVER's shape),
 * this resolves against `parentShape` so an override on the subclass is bypassed.
 * The receiver value is a `(ref $SubStruct)` passed where the parent method
 * expects `(ref $ParentStruct)` (valid WasmGC subtyping). Lowering emits:
 *   <receiver> <each arg> call $<parent>_<method>
 * Result type: the parent method descriptor's `returnType` (null → void).
 *
 * (#3522 W1-C) `memberKind` selects WHICH member slot of the parent is
 * dispatched, exactly as it does on `class.call`: `"method"` → `<parent>_<name>`,
 * `"getter"` → `<parent>_get_<name>` (a `super.<accessor>` read, no args),
 * `"setter"` → `<parent>_set_<name>` (a `super.<accessor> = v` write, one arg,
 * void). ABSENT means `"method"` — the pre-#3522 population, so every existing
 * producer keeps its exact slot. The kind never widens the OPERATION: this is
 * still one static call to a parent slot, which is why the op is shared rather
 * than split.
 */
export interface IrInstrClassSuperCall extends IrInstrBase {
  readonly kind: "class.super_call";
  readonly parentShape: IrClassShape;
  readonly receiver: IrValueId;
  readonly target?: IrFuncRef;
  readonly methodName: string;
  readonly memberKind?: Exclude<IrClassMemberKind, "static">;
  readonly args: readonly IrValueId[];
}

/**
 * (#3144) `value instanceof C` where `C` is a locally-declared user class.
 * `value` must be `IrType.class` (a non-null `(ref $Struct)` — the IR's class
 * carrier is never null, so no null arm is needed). Lowering mirrors the
 * legacy `compileInstanceOf` non-nullable-ref path byte-for-byte in shape:
 *   <emit value>
 *   struct.get $<RecvStruct> <__tag fieldIdx>       ;; hidden tag at slot 0
 *   ;; compare against the TARGET class's tag + all descendant tags
 *   i32.const t0, i32.eq [ (i32.or i32.const ti, i32.eq)* via scratch local ]
 * The compatible-tag set comes from the resolver (`IrClassLowering.
 * instanceOfTags` — own tag + transitive children, the same walk as legacy's
 * `collectInstanceOfTags`). An empty tag set lowers to `drop; i32.const 0`
 * (legacy parity for a tag-less class). Result type: i32 (JS boolean).
 */
export interface IrInstrClassInstanceOf extends IrInstrBase {
  readonly kind: "class.instanceof";
  readonly value: IrValueId;
  readonly targetShape: IrClassShape;
}

/**
 * (#3144) Static method call `C.m(args)` on a locally-declared user class.
 * No receiver: legacy compiles a static method WITHOUT a `self` param
 * (`class-bodies.ts` — `methodParams = isStatic ? [] : [self]`), so the
 * lowering emits args then a call resolved via `IrClassLowering.memberFunc`.
 * Its typed binding selects the slot; its name remains the compatibility key
 * for the current backend adapter. `shape` is the class named at the call site; an inherited static
 * resolves through the same key thanks to legacy's inherited-member key
 * propagation. Result type: the descriptor's `returnType` (null → void).
 */
export interface IrInstrClassStaticCall extends IrInstrBase {
  readonly kind: "class.static_call";
  readonly shape: IrClassShape;
  readonly target?: IrFuncRef;
  readonly methodName: string;
  readonly args: readonly IrValueId[];
}

// ---------------------------------------------------------------------------
// Slot ops + for-of (#1169e — IR Phase 4 Slice 6)
// ---------------------------------------------------------------------------
//
// Slice 6 introduces the first STATEMENT-level loop to the IR. Before this
// slice the IR could only express tail-shaped programs (return / if-else
// terminating in return); for-of bodies in contrast have non-terminating
// statement sequences and need cross-iteration mutable state (the loop
// counter, the element binding, any outer-scope accumulator the body
// updates).
//
// To avoid adding general structured-CFG recovery to the lowerer (which
// today inlines `br` / `br_if` recursively without a Wasm `block` / `loop`
// concept), Slice 6 takes a HIGH-LEVEL approach: a single `forof.vec`
// instruction declaratively encodes the loop, and the lowerer emits a
// known-good Wasm pattern directly. The body's IR instrs are still real
// IR (so the optimisation passes can rewrite them) but mutable
// cross-iteration state lives in WASM-LOCAL slots accessed via
// `slot.read` / `slot.write`.

/**
 * Read a Wasm-local slot. `index` is the function-level slot index assigned
 * at IR build time (allocated via `IrFunctionBuilder.declareSlot`). The slot's
 * declared type must be a primitive ValType; the result IrType is `irVal`
 * of that ValType.
 *
 * Lowering: `local.get <slotIndex>`.
 */
export interface IrInstrSlotRead extends IrInstrBase {
  readonly kind: "slot.read";
  readonly slotIndex: number;
}

/**
 * Write a value to a Wasm-local slot. The value's IrType must be `val` with
 * a ValType matching the slot's declared type. Void result.
 *
 * Lowering: `<emit value>; local.set <slotIndex>`.
 */
export interface IrInstrSlotWrite extends IrInstrBase {
  readonly kind: "slot.write";
  readonly slotIndex: number;
  readonly value: IrValueId;
}

/**
 * Read `vec.length` (i32) from a vec struct. The vec must have an IrType
 * that the lowerer's resolver recognises as a vec (typeIdx with a layout of
 * `{ length: i32, data: (ref $arr) }`). Result is f64 (matching JS Number
 * semantics — same approach as `string.len`); lowering inserts the
 * `f64.convert_i32_s` after the i32 read.
 */
export interface IrInstrVecLen extends IrInstrBase {
  readonly kind: "vec.len";
  readonly vec: IrValueId;
  readonly integer?: true; // Certified internal counted-loop length stays physical i32.
}
/**
 * Index into a vec struct's data array. `index` must be an SSA value of
 * IrType `irVal({ kind: "i32" })` (f64-to-i32 conversion happens at the
 * caller — for-of always uses an i32 counter so this is always already i32).
 *
 * `resultType` carries the vec element's IrType (the lowerer matches it
 * against the vec struct's data array's element type).
 *
 * Lowering: `<emit vec>; struct.get $vec data; <emit index>; array.get $arr`.
 */
export interface IrInstrVecGet extends IrInstrBase {
  readonly kind: "vec.get";
  readonly vec: IrValueId;
  readonly index: IrValueId;
}

/**
 * Mutate one already-allocated dense-vector element. The index is i32 and the
 * value must match the vector element type. Bounds/growth policy stays
 * explicit in surrounding IR; this terminal instruction performs one planned
 * in-bounds store.
 */
export interface IrInstrVecSet extends IrInstrBase {
  readonly kind: "vec.set";
  readonly vec: IrValueId;
  readonly index: IrValueId;
  readonly newValue: IrValueId;
}

/** Update the logical length of an already-allocated vector. */
export interface IrInstrVecSetLength extends IrInstrBase {
  readonly kind: "vec.set_length";
  readonly vec: IrValueId;
  readonly length: IrValueId;
}

/**
 * #1804 — Construct a vec from a fixed, statically-known set of element SSA
 * values. All `elements` share the IrType `elementType` (the from-ast lowerer
 * coerces each element to this type before emitting). `resultType` is the vec
 * ref IrType (a `ref` to the registered vec struct for `elementType`).
 *
 * Lowering (WasmGC): push e0…eN and construct a backing array whose capacity
 * defaults to N; an empty vector may reserve a greater proven capacity while
 * retaining logical length zero. The backend emitter owns the exact sequence
 * so the linear backend can realize the same `[header][len][cap][elements…]`
 * intent.
 *
 * Empty literals (`[]`) carry `elements: []`; the `elementType` is supplied by
 * the from-ast layer from the declared/inferred array type (it cannot be
 * inferred from zero elements).
 */
export interface IrInstrVecNewFixed extends IrInstrBase {
  readonly kind: "vec.new_fixed";
  readonly elements: readonly IrValueId[];
  readonly elementType: IrType;
  /** Backing capacity when greater than the initial logical length. */
  readonly capacity?: number;
}

/**
 * Statement-level `for (const <bind> of <vec>) <body>` loop instruction.
 *
 * Encodes the array fast path declaratively. The lowerer emits:
 *   <emit vec>
 *   local.set <vecSlot>
 *   local.get <vecSlot>
 *   struct.get $vec data
 *   local.set <dataSlot>
 *   local.get <vecSlot>
 *   struct.get $vec length
 *   local.set <lenSlot>
 *   i32.const 0
 *   local.set <counterSlot>
 *   block
 *     loop
 *       local.get <counterSlot>
 *       local.get <lenSlot>
 *       i32.ge_s
 *       br_if 1                  ;; exit loop
 *       local.get <dataSlot>
 *       local.get <counterSlot>
 *       array.get $arr
 *       local.set <elementSlot>
 *       <body instrs>
 *       local.get <counterSlot>
 *       i32.const 1
 *       i32.add
 *       local.set <counterSlot>
 *       br 0                     ;; continue
 *     end
 *   end
 *
 * The vec must have a non-null ref type pointing to a registered vec struct
 * (the resolver's `resolveVec` resolves it to typeIdx + length/data field
 * indices + element array typeIdx + element ValType). Nullable vec types
 * are not in slice 6 — the selector keeps them on the legacy path.
 *
 * Slot indices are pre-allocated via `IrFunctionBuilder.declareSlot` before
 * the from-ast layer emits this instr.
 *
 * Result: void (`result: null`).
 */
export interface IrInstrForOfVec extends IrInstrBase {
  readonly kind: "forof.vec";
  /** SSA value of the iterable. Lowered as the vec ref. */
  readonly vec: IrValueId;
  /** Element type — must match the vec's data array's element ValType. */
  readonly elementType: IrType;
  /** Pre-allocated slot indices (Wasm local indices) for the loop's state. */
  readonly counterSlot: number;
  readonly lengthSlot: number;
  readonly vecSlot: number;
  readonly dataSlot: number;
  readonly elementSlot: number;
  /** Body instrs emitted inside the loop. */
  readonly body: readonly IrInstr[];
  /** #2952 slice 2 — loop identity for `br.label` (see IrInstrWhileLoop). */
  readonly loopLabel?: IrLabelId;
}

// ---------------------------------------------------------------------------
// Coercion + iterator protocol (#1182 — IR Phase 4 Slice 6 part 3)
// ---------------------------------------------------------------------------
//
// Slice 6 part 3 widens the for-of bridge to the host iterator protocol
// — `for (const x of <set>)`, `for (const x of <map>)`, generators, and
// any other JS iterable that responds to `Symbol.iterator`. A new
// declarative `forof.iter` instr (parallel to `forof.vec`) carries the
// loop's state slots and body buffer; the lowerer emits the
// `block { loop { ... } }` Wasm pattern with calls to the existing
// `__iterator` / `__iterator_next` / `__iterator_done` /
// `__iterator_value` / `__iterator_return` host imports (registered
// lazily by `addIteratorImports`).
//
// The granular `iter.*` instrs (iter.new / iter.next / iter.done /
// iter.value / iter.return) are part of the IR surface even though
// `forof.iter` doesn't decompose into them at the body-buffer level.
// Future passes that want to reason about iterator manipulation
// outside a for-of loop (e.g., a generator's next() inlined into a
// caller, or async-iter in slice 7) can produce these directly.

/**
 * Coerce a reference-typed IR value to externref. Used by the iterator-
 * protocol arm of `lowerForOfStatement` to feed an arbitrary iterable
 * into the externref-typed `__iterator` host import.
 *
 * The input value must have a reference IrType (val/ref, val/ref_null,
 * val/externref, object, class, closure, or string). Numeric values
 * (i32, f64, etc.) cannot be coerced — the from-ast layer rejects them
 * upstream.
 *
 * Lowering:
 *   - val/externref input → no-op (input already externref)
 *   - any other ref input → `extern.convert_any` after pushing the value.
 *
 * Result type is normally `irVal({ kind: "externref" })`. The explicit
 * closure-boundary pack reuses this representation operation with result
 * type `{ kind: "callable"; signature }`; both lower to externref.
 */
export interface IrInstrCoerceToExternref extends IrInstrBase {
  readonly kind: "coerce.to_externref";
  readonly value: IrValueId;
}

// ---------------------------------------------------------------------------
// Generator / async ops (#1169f — IR Phase 4 Slice 7)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Extern class ops (#1169i — IR Phase 4 Slice 10)
// ---------------------------------------------------------------------------
//
// The legacy compiler registers a fixed set of "extern classes" in
// `src/codegen/index.ts` (`ctx.externClasses`) that map host JS classes
// like RegExp, Uint8Array, DataView, Map, etc. to a per-class import
// surface — `<className>_new` for construction, `<className>_<method>`
// for methods, `<className>_get_<prop>` / `<className>_set_<prop>` for
// properties. The IR doesn't try to model the structure of these values:
// at the Wasm level they're all opaque externref handles.
//
// Slice 10 surfaces five thin IR instrs that delegate to the legacy
// import registration. Each carries a `className` string that the
// resolver maps to the legacy-registered import names; the result of
// `extern.new` / `extern.regex` / method calls is tagged as
// `IrType.extern { className }` so subsequent receiver lookups can
// dispatch the same way without a TS-checker round trip.

// ---------------------------------------------------------------------------
// Exception handling — throw / try / catch / finally (#1169h — IR Slice 9)
// ---------------------------------------------------------------------------
//
// Slice 9 introduces the IR's first non-linear control flow: an exception
// thrown inside a `try` body bypasses the static block graph and lands in
// the matching catch clause (or unwinds out of the function). The
// implementation uses two new declarative node kinds — `throw` and `try` —
// that mirror the slice-6 forof.vec / forof.iter pattern: the body buffers
// are self-contained Instr[] sequences that the lowerer expands to Wasm
// `try`/`catch`/`catch_all` ops directly. This keeps the IR's block-graph
// model simple (no exceptional-edge terminators) while still expressing
// structured exception handling at the source level.
//
// Tag: slice 9 reuses the legacy `__exn` tag (signature `(externref)`) so
// IR-compiled throws can be caught by legacy-compiled handlers and vice
// versa. The lowerer's `IrLowerResolver.ensureExnTag()` resolves the tag
// index at emit time.

/**
 * Slice 9 (#1169h) — throw an exception. The `value` is coerced to externref
 * upstream (the `__exn` tag's signature is `(externref)`). After throw,
 * control transfers to the nearest enclosing catch matching the tag, or
 * unwinds out of the function.
 *
 * The instr produces NO SSA value (control doesn't fall through), so
 * `result` and `resultType` are always null. The verifier treats it as a
 * "stop" instr — instructions after it in the same block are unreachable
 * in source but still validated structurally.
 *
 * Lowering:
 *   <emit value>          ;; pushes externref
 *   throw $__exn
 */
export interface IrInstrThrow extends IrInstrBase {
  readonly kind: "throw";
  readonly value: IrValueId;
}

/**
 * (#2856) Early `return` from inside a nested body buffer — the
 * `if (v === target) return mid;` inside a `while` loop shape. The block
 * TERMINATOR `return` can't express this (buffers aren't blocks), so this
 * statement-level instr lowers to the Wasm `return` op, which unwinds all
 * enclosing blocks/loops and returns from the function directly.
 *
 * `value` is null for a bare `return;` in a void function (the Wasm
 * `return` then carries no operand). When non-null, the value is emitted
 * onto the stack first and must match the function's single result type
 * (from-ast routes it through the same `coerceReturnValue` the tail path
 * uses).
 *
 * SOUNDNESS SCOPE (selector-enforced, mirrored in from-ast):
 *   - NOT valid inside `try`/`catch`/`finally` buffers — a Wasm `return`
 *     would skip the inlined finally blocks.
 *   - NOT valid inside `forof.iter` bodies — the iterator protocol's
 *     `iter.return` cleanup would be skipped (spec: `return` inside
 *     for-of calls the iterator's return()).
 *   - NOT valid in generators (their return routes through the buffer
 *     epilogue, not a plain Wasm return).
 *   Plain `while`/`for`/`do` bodies (and `if.stmt` arms nested in them)
 *   are the supported contexts — a Wasm `return` there is exactly JS's
 *   early-exit semantics.
 *
 * Like `throw`, it produces NO SSA value; instructions after it in the
 * same buffer are dead but structurally valid.
 */
export interface IrInstrEarlyReturn extends IrInstrBase {
  readonly kind: "early.return";
  readonly value: IrValueId | null;
}

// ---------------------------------------------------------------------------
// Generic structured loops (#1280 — IR Phase 4 Slice 12)
// ---------------------------------------------------------------------------
//
// Slice 12 extends the IR's loop coverage beyond the iterator-shaped
// `forof.*` family. `while.loop` and `for.loop` are statement-level
// declarative instructions that wrap a condition buffer, a body buffer,
// and (for `for.loop`) an update buffer. The lowerer emits the
// canonical `block { loop { <cond>; i32.eqz; br_if 1; <body>; <update?>;
// br 0 } }` Wasm pattern.
//
// Cross-iteration mutable state lives in slots (same convention as the
// `forof.*` family) — outer-scope `let` bindings that the source code
// reassigns inside / through the loop are slot-bound during from-ast
// lowering via the existing `mutatedLets` analysis. SSA values defined
// inside the body register against the surrounding block via the
// recursive walks in `lower.ts::registerInstrDefs` /
// `allocLocalForInstr`; uses inside the body are recorded against a
// synthetic block id (-1) so any outer-defined operand crosses the
// loop boundary and pre-materializes into a Wasm local before the
// loop op runs.

/**
 * Slice 12 (#1280) — `while (cond) body` loop.
 *
 * Lowering pattern:
 *   block
 *     loop
 *       <cond instrs>          ;; computes condValue
 *       <emit condValue>       ;; pushes the i32 boolean
 *       i32.eqz
 *       br_if 1                ;; exit on falsy
 *       <body instrs>
 *       br 0                   ;; continue
 *     end
 *   end
 *
 * `condValue` MUST be the SSA result of an instruction in `cond` (or
 * an outer-scope value that's loaded into `cond`'s last instr). The
 * resolver coerces non-i32 values to i32 via the standard truthy
 * lowering path — for now the from-ast layer enforces an i32 result.
 *
 * Result: void (`result: null`).
 */
export interface IrInstrWhileLoop extends IrInstrBase {
  readonly kind: "while.loop";
  /** Instructions that compute the condition. Re-evaluated per iteration. */
  readonly cond: readonly IrInstr[];
  /** SSA value of the condition (an i32 boolean). */
  readonly condValue: IrValueId;
  /** Body instructions executed each iteration when the cond is truthy. */
  readonly body: readonly IrInstr[];
  /**
   * #2952 slice 1 — `do { body } while (cond)`. When `true`, the lowerer
   * emits the body BEFORE the cond check so the body runs at least once
   * (post-test loop). The IR structure is otherwise identical to a `while`
   * (same `cond` / `condValue` / `body` buffers), so every pass — verify,
   * hygiene, effects, propagate — treats a do-while exactly as a while.
   * Only the lowering emission order differs. Absent/`false` ↔ pre-test
   * (`while`).
   *
   * SAFETY of sharing the kind: the verifier walks `cond` before `body`
   * only to register `condValue`'s def ahead of its use; a do-while body
   * never has a cross-buffer SSA dependency on the cond buffer (each buffer's
   * SSA values are buffer-local; the only shared state is outer-scope slots),
   * so the cond-first walk order is sound for both loop shapes.
   */
  readonly postCond?: boolean;
  /**
   * #2952 slice 2 — identity of this loop for `br.label` targeting. The
   * from-ast layer always synthesises one (unlabeled break/continue resolve
   * to the innermost loop's label); loops built directly by tests may omit
   * it. Purely semantic — no pass reads it except the lowering resolver.
   */
  readonly loopLabel?: IrLabelId;
}

/**
 * Slice 12 (#1280) — `for (init; cond; update) body` loop.
 *
 * The init clause is emitted by the from-ast layer as ordinary IR
 * statements BEFORE the `for.loop` instr (init is just a let-decl or
 * an assignment expression statement, no special encoding needed).
 * The instr carries cond, body, update.
 *
 * Lowering pattern:
 *   block
 *     loop
 *       <cond instrs>
 *       <emit condValue>
 *       i32.eqz
 *       br_if 1
 *       <body instrs>
 *       <update instrs>        ;; runs after body, before re-evaluating cond
 *       br 0
 *     end
 *   end
 *
 * Result: void (`result: null`).
 */
export interface IrInstrForLoop extends IrInstrBase {
  readonly kind: "for.loop";
  /** Instructions that compute the condition. Re-evaluated per iteration. */
  readonly cond: readonly IrInstr[];
  /** SSA value of the condition (an i32 boolean). */
  readonly condValue: IrValueId;
  /** Body instructions executed each iteration when the cond is truthy. */
  readonly body: readonly IrInstr[];
  /** Update instructions executed after the body each iteration. */
  readonly update: readonly IrInstr[];
  /** #2952 slice 2 — loop identity for `br.label` (see IrInstrWhileLoop). */
  readonly loopLabel?: IrLabelId;
}

/**
 * Slice 9 (#1169h) — try / catch / finally as a declarative statement-level
 * instr. Mirrors the slice-6 `forof.vec` shape: the body / catch handler /
 * finally are self-contained Instr[] buffers, and the lowerer emits the
 * structured Wasm `try`/`catch`/`catch_all` op directly without
 * restructuring the IR's block graph.
 *
 * Encoding:
 *   - `body`              the try block's instructions.
 *   - `catchClause`       optional. When present, encodes a source-level
 *                         `catch (e) { ... }` (or `catch { ... }`).
 *                            * `payloadSlot` — slot of `(externref)` that
 *                              receives the thrown value at handler entry
 *                              (or -1 when there is no source binding).
 *                            * `body`        — handler instructions.
 *   - `finallyBody`       optional. When present, the lowerer inlines this
 *                         buffer at every "abrupt completion" path:
 *                            * normal exit of try body
 *                            * normal exit of catch body
 *                            * a synthesized catch_all that re-throws
 *
 * Acceptable shapes (selector-enforced):
 *   try { ... } catch (e) { ... }              catchClause set
 *   try { ... } catch { ... }                  catchClause set, payloadSlot=-1
 *   try { ... } finally { ... }                finallyBody set
 *   try { ... } catch (e) { ... } finally { ... }   both set
 *
 * Result is void (`result: null`).
 */
export interface IrInstrTry extends IrInstrBase {
  readonly kind: "try";
  /** Try block instructions. */
  readonly body: readonly IrInstr[];
  /** Optional source-level catch handler. */
  readonly catchClause?: {
    /**
     * Externref-typed slot index that the lowerer writes the caught
     * exception into at handler entry. `-1` when the source has no
     * binding (`catch { ... }`).
     */
    readonly payloadSlot: number;
    readonly body: readonly IrInstr[];
  };
  /** Optional finally body, inlined at every exit path. */
  readonly finallyBody?: readonly IrInstr[];
}

// ---------------------------------------------------------------------------
// Multi-exit control flow (#2952 slice 2 — unlabeled break / continue)
// ---------------------------------------------------------------------------

/**
 * #2952 slice 2 — branch to an enclosing loop frame identified by `label`.
 *
 * `mode` selects WHICH of the loop's Wasm frames the branch targets:
 *   - `"break"`    → the loop's outer `block` (exit the loop);
 *   - `"continue"` → the frame whose fall-through re-runs the loop's
 *                    advance/cond (the Wasm `loop` frame for pre-test
 *                    `while` / `forof.iter`, or a dedicated body-wrapping
 *                    `block` for `for` / do-while / counter-advancing
 *                    for-of shapes — the lowerer decides).
 *
 * NO depth is stored here (see the issue's Design-A spec): depth is a
 * lowering-time artifact derived by scanning the emitter's `ctrlStack`.
 * The verifier enforces (a) `label` is bound by an enclosing loop in the
 * same buffer-nesting chain, and (b) the instr terminates its buffer
 * (statements after it are dead code the from-ast layer never emits).
 *
 * A `br.label` that lexically crosses a `try` with a `finallyBody` makes
 * the lowerer inline that finally buffer immediately before the `br` —
 * the same inlining `IrInstrTry` already does for normal completion.
 *
 * Result is always void (`result: null`); control does not fall through.
 */
export interface IrInstrBrLabel extends IrInstrBase {
  readonly kind: "br.label";
  readonly label: IrLabelId;
  readonly mode: "break" | "continue";
}

/**
 * #2952 slice 2 — statement-level `if (cond) then [else]` inside a nested
 * buffer (loop body / try body / another if-arm). UNLIKE the value-producing
 * `IrInstrIf` (#1392) there are no carrier values and no result: both arms
 * are void statement lists, and `else` may be empty (plain `if` without
 * `else` — the lowerer emits a Wasm `if` with no else branch).
 *
 * This is the enabler for useful break/continue adoption: `if (c) break;`
 * is the canonical multi-exit shape, and the loop-body statement grammar
 * previously had no statement-`if` at all (top-level `if` uses the block
 * CFG layer, which nested buffers cannot reach).
 *
 * Lowering:
 *   <emit cond>            ;; i32
 *   if                     ;; blocktype empty
 *     <then instrs>
 *   [else
 *     <else instrs>]
 *   end
 */
export interface IrInstrIfStmt extends IrInstrBase {
  readonly kind: "if.stmt";
  readonly cond: IrValueId;
  readonly then: readonly IrInstr[];
  readonly else: readonly IrInstr[];
}

/**
 * #2952 slice 4 — a break-only labeled frame: `lbl: { ... break lbl; ... }`
 * (a LabeledStatement wrapping a NON-loop statement). Lowers to a single
 * Wasm `block`; `br.label{label, mode:"break"}` exits it. `continue` can
 * never target it (JS grammar; the verifier enforces break-only binding).
 * Labeled LOOPS do NOT use this kind — their label rides the loop's own
 * `loopLabel` (slice 3).
 */
export interface IrInstrLabeledBlock extends IrInstrBase {
  readonly kind: "labeled.block";
  readonly label: IrLabelId;
  readonly body: readonly IrInstr[];
}

/**
 * #2952 slice 4 — `switch (disc) { case <literal>: ...; default: ... }`.
 *
 * `tests[k]` is clause k's literal test value in SOURCE order (`null` =
 * the default clause, legal in any position). `bodies[k]` is clause k's
 * statement buffer; per JS §14.12 a body that does not `break` FALLS
 * THROUGH into `bodies[k+1]`.
 *
 * Lowering emits the classic block-per-case ladder:
 *
 *   block $exit            ;; breakLabel — `break` inside a case brs here
 *     block $b(N-1) … block $b0
 *       <dispatch: eq-chain (or br_table for dense-i32 disc) br k;
 *        no-match: br to default clause's block, or $exit if none>
 *     end $b0
 *     <bodies[0]>          ;; falls into bodies[1]
 *     end $b1
 *     <bodies[1]>
 *     …
 *   end $exit
 *
 * Case selection uses strict equality against literal tests: numeric
 * compare in the disc's own value type (NaN matches nothing, -0 === 0 —
 * both correct for f64.eq/i32.eq). `breakLabel` binds break-only, exactly
 * like `labeled.block` (an unlabeled `break` in a case targets the
 * switch; `continue` passes through to the enclosing loop).
 */
export interface IrInstrSwitch extends IrInstrBase {
  readonly kind: "switch";
  readonly disc: IrValueId;
  /**
   * Slot the lowerer stores the evaluated discriminant into (declared by
   * from-ast with the disc's ValType, same idiom as the forof.* slots) —
   * the dispatch chain reads it once per comparison; the disc expression
   * itself is evaluated exactly once (§14.12.9 step 1).
   */
  readonly discSlot: number;
  readonly tests: readonly (number | null)[];
  readonly bodies: readonly (readonly IrInstr[])[];
  readonly breakLabel: IrLabelId;
}

// ---------------------------------------------------------------------------
// JavaScript dialect (#3954 phase 2)
// ---------------------------------------------------------------------------
//
// The ECMAScript-specific instruction kinds live in `./dialect/js.ts`. They are
// imported here for the `IrInstr` union and re-exported so every existing
// importer of `nodes.js` is unaffected. This is the ONE sanctioned core->dialect
// edge; `scripts/check-ir-dialect.mjs` fails the build on any other.
//
// Adding a new ECMAScript-specific kind? Declare it in the dialect, not here.

export type {
  IrInstrAwait,
  IrInstrAsyncReturn,
  IrInstrAsyncThrow,
  IrInstrDynTruthy,
  IrInstrDynToNumber,
  IrInstrDynEq,
  IrInstrDynMemberGet,
  IrInstrDynMemberSet,
  IrInstrGenPush,
  IrInstrIterNew,
  IrInstrIterNext,
  IrInstrIterDone,
  IrInstrIterValue,
  IrInstrIterReturn,
  IrInstrForOfIter,
  IrInstrGenEpilogue,
  IrInstrGenYieldStar,
  IrInstrGenSetReturn,
  IrInstrExternNew,
  IrInstrExternCall,
  IrInstrExternProp,
  IrInstrExternPropSet,
  IrInstrRegExpLiteral,
  IrInstrStringCharAt,
  IrInstrStringCharCodeAt,
  IrInstrStringRepeat,
  IrInstrForOfString,
} from "./dialect/js.js";

export type IrInstr =
  | IrInstrConst
  | IrInstrCall
  | IrInstrIntrinsic
  | IrInstrGlobalGet
  | IrInstrGlobalSet
  | IrInstrBinary
  | IrInstrUnary
  | IrInstrSelect
  // (#1392) Value-producing short-circuiting if/else — used by optional-chain.
  | IrInstrIf
  | IrInstrRawWasm
  | IrInstrBox
  | IrInstrUnbox
  | IrInstrTagTest
  | IrInstrDynTruthy
  | IrInstrDynToNumber
  | IrInstrDynEq
  | IrInstrDynMemberGet
  | IrInstrDynMemberSet
  | IrInstrStringConst
  | IrInstrStringConcat
  | IrInstrStringRepeat
  | IrInstrStringEq
  | IrInstrStringLen
  | IrInstrStringCharAt
  | IrInstrStringCharCodeAt
  | IrInstrFnctorNew
  | IrInstrFnctorGet
  | IrInstrObjectNew
  | IrInstrObjectGet
  | IrInstrObjectSet
  | IrInstrClosureNew
  | IrInstrClosureCap
  | IrInstrClosureCall
  | IrInstrRefCellNew
  | IrInstrRefCellGet
  | IrInstrRefCellSet
  | IrInstrClassNew
  | IrInstrClassSuperInit
  | IrInstrClassSuperCall
  | IrInstrClassGet
  | IrInstrClassSet
  | IrInstrClassCall
  | IrInstrClassInstanceOf
  | IrInstrClassStaticCall
  | IrInstrSlotRead
  | IrInstrSlotWrite
  | IrInstrVecLen
  | IrInstrVecGet
  | IrInstrVecSet
  | IrInstrVecSetLength
  | IrInstrVecNewFixed
  | IrInstrForOfVec
  | IrInstrCoerceToExternref
  | IrInstrIterNew
  | IrInstrIterNext
  | IrInstrIterDone
  | IrInstrIterValue
  | IrInstrIterReturn
  | IrInstrForOfIter
  | IrInstrGenPush
  | IrInstrGenEpilogue
  | IrInstrGenYieldStar
  | IrInstrGenSetReturn
  | IrInstrForOfString
  // Slice 9 (#1169h) — exception handling.
  | IrInstrThrow
  | IrInstrTry
  // (#2856) Early return inside body buffers.
  | IrInstrEarlyReturn
  // Slice 10 (#1169i) — extern class ops.
  | IrInstrExternNew
  | IrInstrExternCall
  | IrInstrExternProp
  | IrInstrExternPropSet
  | IrInstrRegExpLiteral
  // Slice 12 (#1280) — generic structured loops.
  | IrInstrWhileLoop
  | IrInstrForLoop
  // #2952 slice 2 — multi-exit control flow.
  | IrInstrBrLabel
  | IrInstrIfStmt
  // #2952 slice 4 — switch + labeled non-loop block.
  | IrInstrLabeledBlock
  | IrInstrSwitch
  // (#1373 Phase B) Async / await IR nodes. Currently type-only —
  // Phase C (CPS transform, follow-up #1373b) wires lowering.
  | IrInstrAwait
  | IrInstrAsyncReturn
  | IrInstrAsyncThrow;

// ---------------------------------------------------------------------------
// Slot definitions (#1169e — IR Phase 4 Slice 6)
// ---------------------------------------------------------------------------

/**
 * Slice 6 (#1169e) — declaration of one Wasm-local slot used for cross-
 * iteration mutable state. Slots are allocated by the IR builder and
 * surface in the lowered Wasm function as additional locals appended
 * after the params and the SSA-driven locals.
 *
 *   - `index`        stable slot index, used by `slot.read` / `slot.write`.
 *                    NOT a Wasm local index — the lowerer translates slot
 *                    index N to Wasm local index `params + ssaLocals + N`.
 *   - `name`         debug name for the local.
 *   - `type`         primitive ValType (i32 / f64 / etc.) — slots only
 *                    carry primitives; reference-typed cross-iteration
 *                    state is rare in slice-6 loop bodies.
 */
export interface IrSlotDef {
  readonly index: number;
  readonly name: string;
  readonly type: ValType;
}

// ---------------------------------------------------------------------------
// Terminators
// ---------------------------------------------------------------------------
//
// Every basic block ends with exactly one terminator. Block args replace phi
// nodes: `br target(a, b)` passes SSA values into the target's block-arg slots.

export interface IrBranch {
  readonly target: IrBlockId;
  readonly args: readonly IrValueId[];
}

export type IrBlockId = number & { readonly __brand: "IrBlockId" };

export function asBlockId(n: number): IrBlockId {
  return n as IrBlockId;
}

export interface IrTerminatorReturn {
  readonly kind: "return";
  readonly values: readonly IrValueId[];
  readonly site?: IrSiteId;
}

export interface IrTerminatorBr {
  readonly kind: "br";
  readonly branch: IrBranch;
  readonly site?: IrSiteId;
}

export interface IrTerminatorBrIf {
  readonly kind: "br_if";
  readonly condition: IrValueId;
  readonly ifTrue: IrBranch;
  readonly ifFalse: IrBranch;
  readonly site?: IrSiteId;
}

export interface IrTerminatorUnreachable {
  readonly kind: "unreachable";
  readonly site?: IrSiteId;
}

export type IrTerminator = IrTerminatorReturn | IrTerminatorBr | IrTerminatorBrIf | IrTerminatorUnreachable;

// ---------------------------------------------------------------------------
// Basic blocks
// ---------------------------------------------------------------------------

export interface IrBlock {
  readonly id: IrBlockId;
  /** SSA values bound on entry (replace phi nodes). Types are parallel to `blockArgTypes`. */
  readonly blockArgs: readonly IrValueId[];
  readonly blockArgTypes: readonly IrType[];
  readonly instrs: readonly IrInstr[];
  readonly terminator: IrTerminator;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

export interface IrParam {
  readonly value: IrValueId;
  readonly type: IrType;
  readonly name: string;
}

export interface IrFunction extends IrFunctionIdentity {
  readonly params: readonly IrParam[];
  readonly resultTypes: readonly IrType[];
  /** Entry block is always `blocks[0]`. */
  readonly blocks: readonly IrBlock[];
  readonly exported: boolean;
  /** Highest IrValueId allocated + 1 (useful for re-entering the builder). */
  readonly valueCount: number;
  /**
   * Slice 3 (#1169c): for closure-lifted bodies only, identifies the
   * subtype struct that captures live on. Set by `liftClosureBody` in
   * `from-ast.ts`. The lowerer reads this when emitting `closure.cap`
   * to compute the correct ref.cast target. Absent for nested function
   * declarations (which don't take a __self param) and for outer
   * functions.
   */
  readonly closureSubtype?: {
    readonly signature: IrClosureSignature;
    readonly captureFieldTypes: readonly IrType[];
    readonly hostOneShot?: boolean;
    readonly domCallbackAuthority?: IrDomCallbackAuthority;
  };
  /**
   * Slice 6 (#1169e): Wasm-local slots used for cross-iteration mutable
   * state in for-of loops. Empty for functions that don't contain a
   * for-of (or any other slot user). Slot indices are stable; the
   * lowerer maps slot index N to Wasm local index
   *   `params.length + ssaLocalCount + N`
   * — i.e. slots come AFTER the SSA-driven locals.
   */
  readonly slots?: readonly IrSlotDef[];
  /**
   * Slice 7a (#1169f) — distinguishes regular / generator / async
   * functions. Set by `lowerFunctionAstToIr` from the AST node's
   * `asteriskToken` and `async` modifier. The lowerer reads this to:
   *   - `"generator"`: select the externref Wasm-result type regardless
   *     of the source-level annotation (the function returns a
   *     Generator-like object, not the source-declared yield element
   *     type), AND register the function name in `ctx.generatorFunctions`
   *     downstream (for any name-based dispatch the legacy already wires).
   *   - `"async"`: register in `ctx.asyncFunctions` so the export glue's
   *     `wrapAsyncReturn` wraps the result in `Promise.resolve`. (Slice
   *     7d, not 7a.)
   *   - `"regular"`: no special treatment (default if absent).
   */
  readonly funcKind?: "regular" | "generator" | "async";
  /**
   * Canonical, target-neutral suspension graph for a genuinely asynchronous
   * function. It is produced before backend selection and contains no AST,
   * Wasm indices, or concrete host adapter spellings.
   */
  readonly asyncPlan?: IrAsyncPlan;
  /**
   * Lookup-only backend attachment added after runtime-manifest freeze. This
   * is deliberately separate from `asyncPlan` so plan hashes stay target
   * independent while Program ABI sealing can see exact adapter callables.
   */
  readonly asyncRuntime?: PreparedIrAsyncRuntime;
  /**
   * Slice 7a (#1169f) — for `funcKind === "generator"` functions only,
   * the slot index (in `slots`) of the `__gen_buffer` Wasm-local. The
   * lowerer reads this when emitting `gen.push` / `gen.epilogue` to
   * produce the `local.get $__gen_buffer` op.
   */
  readonly generatorBufferSlot?: number;
}

// ---------------------------------------------------------------------------
// Module — collection of IR functions visible simultaneously
// ---------------------------------------------------------------------------
//
// Module-scope passes (e.g. `inlineSmall` in Phase 3b — #1167b) need to see
// every IR-path function at once. The AST→IR lowerer emits per-function, so
// `integration.ts` accumulates the per-function results into an `IrModule`
// container between the build phase and the lower phase.
//
// The container holds functions plus the OPTIONAL declared-type tables #4605
// added. Globals/types/imports are still *resolved* lazily via the symbolic-ref
// mechanism at lowering; the tables are a declaration record, not a resolver.
// The rules that read them, and the key function they are keyed by, live in
// `declared-types.ts` — only the shapes are here, so that module's import edge
// into `nodes.ts` has no back edge.

/**
 * (#4605) The declared shape of one callable, as the module DECLARES it —
 * independent of any particular call site. `result === null` means "no single
 * declarable result carrier" (void, or a call-site-dependent one such as an
 * async body's Promise-vs-awaited split — see `declarableResultType`).
 */
export interface IrDeclaredSignature {
  readonly params: readonly IrType[];
  readonly result: IrType | null;
}

/**
 * (#4605) Module-level declaration tables, keyed by `irBindingKey`. Both are
 * OPTIONAL and both may be partial: a missing entry means "no declaration in
 * scope", which consumers must treat as a conservative skip.
 */
export interface IrModuleDeclarations {
  readonly declaredSignatures?: ReadonlyMap<string, IrDeclaredSignature>;
  readonly declaredGlobals?: ReadonlyMap<string, IrType>;
}

export interface IrModule extends IrModuleDeclarations {
  readonly functions: readonly IrFunction[];
}

// ---------------------------------------------------------------------------
// Shared IR traversal / use-collection (#1922)
//
// Single authority on (a) which IrInstr kinds carry nested `IrInstr[]` buffers,
// and (b) the direct SSA-value operands of an instr. Before this, ≥5 hand-rolled
// copies of "walk nested buffers / collect uses" lived across verify.ts,
// lower.ts, passes/dead-code.ts, passes/constant-fold.ts and
// passes/alloc-discipline.ts, kept in sync only by comments — the failure mode
// that let `while.loop`/`for.loop` body buffers go unwalked by DCE (#1922), so
// the most ordinary loop shape silently demoted off the IR path. Consumers now
// route their structural traversal through `forEachNestedBuffer`; adding a new
// buffer-bearing instr kind is a single exhaustive-switch edit here that the
// compiler enforces.
// ---------------------------------------------------------------------------

/**
 * Invoke `fn` once per nested `IrInstr[]` buffer carried directly by `instr`
 * (NOT recursively — see `forEachInstrDeep` for the deep walk). The exhaustive
 * switch is the authoritative list of buffer-bearing kinds; the trailing
 * `never` assignment makes a missing case a compile error, so a new
 * buffer-bearing instr kind cannot be added without extending this one place.
 *
 * Buffer order is the lowering/evaluation order (cond before body before
 * update; then before else; body/catch/finally) so callers that care about
 * order (def registration) get it for free.
 */
export function forEachNestedBuffer(instr: IrInstr, fn: (buffer: readonly IrInstr[]) => void): void {
  switch (instr.kind) {
    case "if":
      fn(instr.then);
      fn(instr.else);
      return;
    case "forof.vec":
    case "forof.iter":
    case "forof.string":
      fn(instr.body);
      return;
    case "while.loop":
      fn(instr.cond);
      fn(instr.body);
      return;
    case "for.loop":
      fn(instr.cond);
      fn(instr.body);
      fn(instr.update);
      return;
    case "try":
      fn(instr.body);
      if (instr.catchClause) fn(instr.catchClause.body);
      if (instr.finallyBody) fn(instr.finallyBody);
      return;
    // #2952 slice 2 — statement-level if. Both arms are plain buffers
    // (else may be empty — still visited, mirroring `if`'s unconditional
    // arm visit so pass behavior is uniform).
    case "if.stmt":
      fn(instr.then);
      fn(instr.else);
      return;
    // #2952 slice 4 — labeled block (one buffer) / switch (one per clause,
    // in source = fallthrough order).
    case "labeled.block":
      fn(instr.body);
      return;
    case "switch":
      for (const body of instr.bodies) fn(body);
      return;
    // All remaining kinds carry no nested IrInstr[] buffer. The `never`
    // binding turns a newly-added buffer-bearing kind into a compile error
    // here — the single point that must know about every buffer.
    case "const":
    case "call":
    case "intrinsic":
    case "global.get":
    case "global.set":
    case "binary":
    case "unary":
    case "select":
    case "raw.wasm":
    case "box":
    case "unbox":
    case "tag.test":
    case "dyn.truthy":
    case "dyn.to_number":
    case "dyn.eq":
    case "dyn.member_get":
    case "dyn.member_set":
    case "string.const":
    case "string.concat":
    case "string.repeat":
    case "string.eq":
    case "string.len":
    case "string.char_at":
    case "string.char_code_at":
    case "fnctor.new":
    case "fnctor.get":
    case "object.new":
    case "object.get":
    case "object.set":
    case "closure.new":
    case "closure.cap":
    case "closure.call":
    case "refcell.new":
    case "refcell.get":
    case "refcell.set":
    case "class.new":
    case "class.get":
    case "class.set":
    case "class.call":
    case "class.super_init":
    case "class.super_call":
    case "class.instanceof":
    case "class.static_call":
    case "slot.read":
    case "slot.write":
    case "vec.len":
    case "vec.get":
    case "vec.set":
    case "vec.set_length":
    case "vec.new_fixed":
    case "coerce.to_externref":
    case "iter.new":
    case "iter.next":
    case "iter.done":
    case "iter.value":
    case "iter.return":
    case "gen.push":
    case "gen.epilogue":
    case "gen.yieldStar":
    case "gen.setReturn":
    case "throw":
    case "br.label": // #2952 slice 2 — leaf (buffer-terminating branch)
    case "extern.new":
    case "extern.call":
    case "extern.prop":
    case "extern.propSet":
    case "extern.regex":
    case "await":
    case "async.return":
    case "async.throw":
    case "early.return":
      return;
    default: {
      const _exhaustive: never = instr;
      void _exhaustive;
      return;
    }
  }
}

/**
 * Visit `instr` and every instruction nested within its buffers, recursively
 * (pre-order: the containing instr before its buffer contents). The single
 * deep-walk primitive shared by the verifier (def registration) and the
 * alloc-discipline pass (allocation retirement).
 */
export function forEachInstrDeep(instr: IrInstr, visit: (i: IrInstr) => void): void {
  visit(instr);
  forEachNestedBuffer(instr, (buffer) => {
    for (const sub of buffer) forEachInstrDeep(sub, visit);
  });
}

/**
 * Rebuild `instr` with each nested buffer replaced by `mapBuffer(buffer)` — the
 * write-side companion to `forEachNestedBuffer`, used by the hygiene passes
 * (#1925) to fold / DCE *inside* control-flow buffers. Buffers are passed in the
 * same evaluation order `forEachNestedBuffer` yields them.
 *
 * Reference-equality preserving: when `mapBuffer` returns each buffer unchanged
 * (same array reference), the original `instr` is returned as-is, so callers can
 * detect "no change" by `===` and keep their fixpoint contract. A non-buffer
 * instr is always returned unchanged.
 */
export function mapNestedBuffers(
  instr: IrInstr,
  mapBuffer: (buffer: readonly IrInstr[]) => readonly IrInstr[],
): IrInstr {
  switch (instr.kind) {
    case "if": {
      const then_ = mapBuffer(instr.then);
      const else_ = mapBuffer(instr.else);
      if (then_ === instr.then && else_ === instr.else) return instr;
      return { ...instr, then: then_, else: else_ };
    }
    case "forof.vec":
    case "forof.iter":
    case "forof.string": {
      const body = mapBuffer(instr.body);
      if (body === instr.body) return instr;
      return { ...instr, body };
    }
    case "while.loop": {
      const cond = mapBuffer(instr.cond);
      const body = mapBuffer(instr.body);
      if (cond === instr.cond && body === instr.body) return instr;
      return { ...instr, cond, body };
    }
    case "for.loop": {
      const cond = mapBuffer(instr.cond);
      const body = mapBuffer(instr.body);
      const update = mapBuffer(instr.update);
      if (cond === instr.cond && body === instr.body && update === instr.update) return instr;
      return { ...instr, cond, body, update };
    }
    case "try": {
      const body = mapBuffer(instr.body);
      const catchBody = instr.catchClause ? mapBuffer(instr.catchClause.body) : undefined;
      const finallyBody = instr.finallyBody ? mapBuffer(instr.finallyBody) : undefined;
      const catchUnchanged = !instr.catchClause || catchBody === instr.catchClause.body;
      const finallyUnchanged = !instr.finallyBody || finallyBody === instr.finallyBody;
      if (body === instr.body && catchUnchanged && finallyUnchanged) return instr;
      return {
        ...instr,
        body,
        catchClause: instr.catchClause && catchBody ? { ...instr.catchClause, body: catchBody } : instr.catchClause,
        finallyBody: instr.finallyBody && finallyBody ? finallyBody : instr.finallyBody,
      };
    }
    // #2952 slice 2 — statement-level if.
    case "if.stmt": {
      const then_ = mapBuffer(instr.then);
      const else_ = mapBuffer(instr.else);
      if (then_ === instr.then && else_ === instr.else) return instr;
      return { ...instr, then: then_, else: else_ };
    }
    // #2952 slice 4 — labeled block / switch.
    case "labeled.block": {
      const body = mapBuffer(instr.body);
      if (body === instr.body) return instr;
      return { ...instr, body };
    }
    case "switch": {
      const bodies = instr.bodies.map((b) => mapBuffer(b));
      if (bodies.every((b, i) => b === instr.bodies[i])) return instr;
      return { ...instr, bodies };
    }
    // Leaf kinds carry no nested buffer — returned unchanged. (Same exhaustive
    // set as forEachNestedBuffer; the never-check enforces parity.)
    case "const":
    case "call":
    case "intrinsic":
    case "global.get":
    case "global.set":
    case "binary":
    case "unary":
    case "select":
    case "raw.wasm":
    case "box":
    case "unbox":
    case "tag.test":
    case "dyn.truthy":
    case "dyn.to_number":
    case "dyn.eq":
    case "dyn.member_get":
    case "dyn.member_set":
    case "string.const":
    case "string.concat":
    case "string.repeat":
    case "string.eq":
    case "string.len":
    case "string.char_at":
    case "string.char_code_at":
    case "fnctor.new":
    case "fnctor.get":
    case "object.new":
    case "object.get":
    case "object.set":
    case "closure.new":
    case "closure.cap":
    case "closure.call":
    case "refcell.new":
    case "refcell.get":
    case "refcell.set":
    case "class.new":
    case "class.get":
    case "class.set":
    case "class.call":
    case "class.super_init":
    case "class.super_call":
    case "class.instanceof":
    case "class.static_call":
    case "slot.read":
    case "slot.write":
    case "vec.len":
    case "vec.get":
    case "vec.set":
    case "vec.set_length":
    case "vec.new_fixed":
    case "coerce.to_externref":
    case "iter.new":
    case "iter.next":
    case "iter.done":
    case "iter.value":
    case "iter.return":
    case "gen.push":
    case "gen.epilogue":
    case "gen.yieldStar":
    case "gen.setReturn":
    case "throw":
    case "br.label": // #2952 slice 2 — leaf
    case "extern.new":
    case "extern.call":
    case "extern.prop":
    case "extern.propSet":
    case "extern.regex":
    case "await":
    case "async.return":
    case "async.throw":
    case "early.return":
      return instr;
    default: {
      const _exhaustive: never = instr;
      void _exhaustive;
      return instr;
    }
  }
}

/**
 * The direct SSA-value operands of `instr` — the values it reads at its own
 * level, NOT including operands buried in nested buffers. This is the canonical
 * single-count mapping used by the verifier and DCE (so e.g. `closure.call`'s
 * callee is counted once; the lowering use-counter's intentional double-count
 * for Wasm-local materialisation stays local to lower.ts).
 *
 * For buffer-bearing control-flow instrs, the operands surfaced here are only
 * the ones evaluated at the instr's own level: `if` → cond; `while/for` →
 * condValue; `forof.*` → the iterable/vec/str; `try` → none. Buffer-interior
 * uses are reached via `collectUses(instr, { deep: true })`.
 */
export function directUses(instr: IrInstr): readonly IrValueId[] {
  switch (instr.kind) {
    case "const":
    case "global.get":
    case "raw.wasm":
    case "string.const":
    case "slot.read":
    case "gen.epilogue":
    case "extern.regex":
      return [];
    case "call":
      return instr.args;
    case "intrinsic":
      return instr.args;
    case "global.set":
      return [instr.value];
    case "binary":
      return [instr.lhs, instr.rhs];
    case "unary":
      return [instr.rand];
    case "select":
      return [instr.condition, instr.whenTrue, instr.whenFalse];
    case "if":
      return [instr.cond, instr.thenValue, instr.elseValue];
    case "box":
    case "unbox":
    case "tag.test":
    case "dyn.truthy":
    case "dyn.to_number":
      return [instr.value];
    case "dyn.eq":
    case "string.concat":
    case "string.eq":
      return [instr.lhs, instr.rhs];
    case "string.repeat":
      return [instr.value, instr.count];
    case "dyn.member_get":
      return [instr.recv, instr.key];
    case "dyn.member_set":
      return [instr.recv, instr.key, instr.value];
    case "string.len":
      return [instr.value];
    case "string.char_at":
    case "string.char_code_at":
      return [instr.value, instr.index];
    case "fnctor.new":
      return [
        ...instr.captureArgs,
        ...instr.args,
        ...(instr.constructorIdentity === null ? [] : [instr.constructorIdentity]),
      ];
    case "fnctor.get":
      return [instr.value];
    case "object.new":
      return instr.values;
    case "object.get":
      return [instr.value];
    case "object.set":
      return [instr.value, instr.newValue];
    case "closure.new":
      return instr.captures;
    case "closure.cap":
      return [instr.self];
    case "closure.call":
      return [instr.callee, ...instr.args];
    case "refcell.new":
      return [instr.value];
    case "refcell.get":
      return [instr.cell];
    case "refcell.set":
      return [instr.cell, instr.value];
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
      return instr.elements;
    case "forof.vec":
      return [instr.vec];
    case "coerce.to_externref":
      return [instr.value];
    case "iter.new":
      return [instr.iterable];
    case "iter.next":
      return [instr.iter];
    case "iter.done":
    case "iter.value":
      return [instr.resultObj];
    case "iter.return":
      return [instr.iter];
    case "forof.iter":
      return [instr.iterable];
    case "gen.push":
      return [instr.value];
    case "gen.yieldStar":
      return [instr.inner];
    case "gen.setReturn":
      return [instr.value];
    case "forof.string":
      return [instr.str];
    case "throw":
      return [instr.value];
    case "try":
      return [];
    // #2952 slice 2 — br.label carries no SSA operands (label is a control
    // identity, not a value); if.stmt evaluates only its cond at its own
    // level (arm-interior uses are reached via `collectUses(_, {deep:true})`).
    case "br.label":
      return [];
    case "if.stmt":
      return [instr.cond];
    // #2952 slice 4 — labeled.block has no operands of its own; switch
    // evaluates only its discriminant (clause-interior uses via deep walk).
    case "labeled.block":
      return [];
    case "switch":
      return [instr.disc];
    case "extern.new":
      return instr.args;
    case "extern.call":
      return [instr.receiver, ...instr.args];
    case "extern.prop":
      return [instr.receiver];
    case "extern.propSet":
      return [instr.receiver, instr.value];
    case "while.loop":
    case "for.loop":
      return [instr.condValue];
    case "await":
      return [instr.operand];
    case "async.return":
      return [instr.value];
    case "async.throw":
      return [instr.reason];
    // (#2856) early.return — the optional return value is a direct use.
    case "early.return":
      return instr.value !== null ? [instr.value] : [];
    default: {
      const _exhaustive: never = instr;
      void _exhaustive;
      return [];
    }
  }
}

/**
 * Collect the SSA-value uses of `instr`. Shallow by default (== `directUses`);
 * with `{ deep: true }` it also walks every nested buffer via
 * `forEachNestedBuffer`, surfacing buffer-interior uses too. The deep form is
 * what DCE needs so values referenced only inside a loop/if/for-of/try buffer
 * survive liveness — the exact bug (#1922) the per-kind ad-hoc walkers caused
 * for `while.loop`/`for.loop`.
 */
export function collectUses(instr: IrInstr, opts?: { readonly deep?: boolean }): readonly IrValueId[] {
  if (!opts?.deep) return directUses(instr);
  const out: IrValueId[] = [];
  const visit = (i: IrInstr): void => {
    for (const u of directUses(i)) out.push(u);
    forEachNestedBuffer(i, (buffer) => {
      for (const sub of buffer) visit(sub);
    });
  };
  visit(instr);
  return out;
}
