// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Stack-balancing fixup pass for Wasm function bodies.
 *
 * Wasm validation requires that all branches of structured control flow
 * (if/else, try/catch, block) leave the stack in a state matching the
 * block's declared type. This pass detects and fixes three classes of
 * mismatches:
 *
 * 1. "expected 0, found N" -- an empty-typed block where a branch leaves
 *    extra values on the stack. Fix: append `drop` instructions.
 *
 * 2. "expected N, found 0" -- a valued block where a branch doesn't
 *    produce a value (typically because it ends in unreachable code like
 *    return/throw/br but the validator still needs balance, OR because
 *    the branch genuinely fails to push a value). Fix: append `unreachable`
 *    (if the branch already has a terminator) or a default value push.
 *
 * 3. "type error in fallthru" -- a branch produces the right number of
 *    values but of the wrong type (e.g., ref instead of externref, or
 *    f64 instead of externref). Fix: insert type coercion instructions
 *    (extern.convert_any, any.convert_extern+ref.cast, etc.).
 *
 * The pass uses a lightweight stack-depth simulation that tracks net
 * pushes/pops through a linear instruction sequence, plus type inference
 * for the last value-producing instruction to detect type mismatches.
 */
import { coercionPlan } from "./coercion-plan.js";
import type { BlockType, FuncTypeDef, Instr, TypeDef, ValType, WasmFunction, WasmModule } from "../ir/types.js";
import { STABLE_FUNC_BASE, absoluteFuncIndexCached } from "../emit/resolve-layout.js"; // (#1916 S3)
import { walkInstructions } from "./walk-instructions.js";

/**
 * (#2934) Widen a packed i8/i16 STORAGE type to the i32 that actually lives on
 * the Wasm value stack. `array.get_u`/`array.get_s` (and `struct.get_s/_u`)
 * zero/sign-extend packed elements to i32 — the packed kind itself never exists
 * as a stack value. The type-stack simulation must model the widened type:
 * propagating the raw packed kind poisons downstream repairs (the struct.new
 * arg-coercion fixup materializes stack types into `$sn_tmp` temp locals, and a
 * local declared `i8` is invalid Wasm — "packed storage type is not valid in a
 * value position").
 */
function widenPackedToI32(t: ValType): ValType {
  return t.kind === "i8" || t.kind === "i16" ? { kind: "i32" } : t;
}

/** Sentinel: the instruction sequence is unreachable (after return/br/throw/unreachable). */
const UNREACHABLE = -999;

// #2090 — the stack-repair pass exists to fix *known* count/type mismatches by
// adding `drop`s or typed zero-defaults. But two arms below patched an
// UNKNOWN-typed missing slot with an invented `ref.null.extern` "safe default".
// That masks the producing codegen bug twice (once at the producer, once in the
// pass that should have flagged it) and ships a silent null. Report 04 §2a/§5
// concluded there is no legitimate trigger. We now record any such site and
// `stackBalance` converts it into a structured hard compile error instead of
// inventing a value. The collector is module-scoped (the recursive fix* helpers
// don't thread `mod`); `stackBalance` resets it per run and drains it at the end.
let inventedValueSites: { func: string; detail: string }[] = [];
let currentDiagFunc = "<unknown>";

// #1918 — Stack-balance fixup telemetry.
//
// Every fixup this pass applies is a *repair of the emitter's own output*: a
// masked codegen bug. Historically the per-function fixup count was summed,
// returned by `stackBalance`, and then discarded by both call sites
// (`src/codegen/index.ts`). Nothing reported, gated, or ratcheted it, so the
// safety net silently absorbed new emitter regressions — and some repairs are
// *lossy* (a wrong-typed/missing branch value patched with a `const` default
// becomes a silently-wrong runtime value).
//
// We now classify each leaf fixup by `FixupKind` and collect a located event
// per occurrence. `stackBalance` resets the collector per run and exposes it
// via `getFixupEvents()`; `src/codegen/index.ts` drains it into a per-compile
// summary and, under `JS2WASM_STRICT_BALANCE`, into compiler warnings (=1) or
// hard errors (=error). The `scripts/check-stack-balance.ts` corpus gate
// aggregates the kinds into `scripts/stack-balance-baseline.json` and fails CI
// when any bucket grows (ratchet mechanics mirror `check-ir-fallbacks.ts`).
export type FixupKind =
  // count repairs
  | "drop-excess" // branch left too many values; surplus dropped
  | "default-value-lossy" // branch left too few values; missing slot filled with a typed const/null default (LOSSY)
  // type repairs
  | "branch-type-coerce" // branch result coerced to the block type via the coercion table
  | "branch-type-cast" // branch result externref→ref/ref_null via any.convert_extern + ref.cast_null
  | "call-arg-coerce" // call argument coerced to the callee's declared param type
  | "struct-field-coerce" // struct.new field value coerced to the field's declared type
  | "local-set-coerce" // local.set/local.tee value coerced to the local's declared type
  // (#2140) NOT a repair — a detected-but-unbridgeable branch type mismatch.
  // The pass inserts nothing; the module WILL fail WebAssembly.validate. The
  // event makes the failure loud and located instead of an opaque validator
  // offset; hard compile error under JS2WASM_STRICT_BALANCE=error; corpus
  // baseline pins it at 0. Unconditional-throw promotion is the staged
  // follow-up (see plan/issues/2140-fixbranchtype-coerce-or-throw.md).
  | "branch-type-unfixable";

/** A single located fixup the pass applied while repairing emitter output. */
export interface FixupEvent {
  readonly kind: FixupKind;
  /** Name of the function (or `func#N`) the fixup was applied in. */
  readonly func: string;
  /** Human-readable detail (e.g. `f64 default for missing branch value`). */
  readonly detail: string;
  /** True for repairs that can change runtime semantics (currently the const-default arm). */
  readonly lossy: boolean;
}

let fixupEvents: FixupEvent[] = [];

/** Record a fixup the pass just applied, attributed to the current function. */
function recordFixup(kind: FixupKind, detail: string, lossy = false): void {
  fixupEvents.push({ kind, func: currentDiagFunc, detail, lossy });
}

/**
 * Events collected during the most recent `stackBalance(mod)` run (#1918).
 * Returns a copy so callers can't mutate the collector. `stackBalance` resets
 * it at the start of every run, so this reflects exactly one module's repairs.
 */
export function getFixupEvents(): FixupEvent[] {
  return fixupEvents.slice();
}

/** Aggregate fixup events into per-kind counts (#1918). Always includes every kind. */
export function summarizeFixups(events: readonly FixupEvent[]): Record<FixupKind, number> {
  const counts: Record<FixupKind, number> = {
    "drop-excess": 0,
    "default-value-lossy": 0,
    "branch-type-coerce": 0,
    "branch-type-cast": 0,
    "call-arg-coerce": 0,
    "struct-field-coerce": 0,
    "local-set-coerce": 0,
    "branch-type-unfixable": 0,
  };
  for (const e of events) counts[e.kind]++;
  return counts;
}

/** A strict-balance diagnostic ready to push onto a codegen error sink (#1918). */
export interface StrictBalanceDiagnostic {
  readonly message: string;
  readonly line: 0;
  readonly column: 0;
  readonly severity: "error" | "warning";
}

/**
 * Strict-balance mode (#1918). Controlled by `JS2WASM_STRICT_BALANCE`:
 *
 *   unset / "0" / "off"  — silent (default; preserves existing behaviour)
 *   "1" / "true" / "warn" — every fixup becomes a located severity-"warning"
 *   "error" / "strict"    — every fixup becomes a severity-"error" (fails the
 *                            compile); for CI experiments and new code that
 *                            should never need a repair.
 *
 * Returns the diagnostics to surface. The caller (`src/codegen/index.ts`,
 * which holds `ctx`) pushes them onto `ctx.errors` — strict errors then fail
 * the WasmGC compile through the existing `severity === "error"` gate, which
 * `mod.codegenErrors` does NOT reach on the WasmGC path (see #2090).
 */
export function strictBalanceDiagnostics(events: readonly FixupEvent[]): StrictBalanceDiagnostic[] {
  const mode = (process.env.JS2WASM_STRICT_BALANCE ?? "").toLowerCase();
  const enabled = mode === "1" || mode === "true" || mode === "warn" || mode === "error" || mode === "strict";
  if (!enabled || events.length === 0) return [];
  const severity: "error" | "warning" = mode === "error" || mode === "strict" ? "error" : "warning";
  return events.map((e) => {
    const body =
      `Stack-balance fixup [${e.kind}]${e.lossy ? " (LOSSY)" : ""} in function "${e.func}": ${e.detail}. ` +
      `This repairs an emitter bug; the producing codegen should emit a balanced, correctly-typed stack ` +
      `instead of relying on the stack-balance pass. (#1918)`;
    // For severity "error" prefix with "Codegen error:" so the compiler's
    // existing WasmGC success gate (compiler.ts: `message.startsWith("Codegen
    // error:")`) actually fails the compile. Warnings stay unprefixed so they
    // remain visible diagnostics without affecting `success`.
    return {
      message: severity === "error" ? `Codegen error: ${body}` : body,
      line: 0 as const,
      column: 0 as const,
      severity,
    };
  });
}

/**
 * Check if an instruction is a terminator (makes subsequent code unreachable).
 */
function isTerminator(op: string): boolean {
  return (
    op === "return" ||
    op === "return_call" ||
    op === "return_call_ref" ||
    op === "br" ||
    op === "throw" ||
    op === "rethrow" ||
    op === "unreachable"
  );
}

/**
 * Remove dead code after terminating instructions in a flat instruction body.
 * Recurses into structured blocks (if/block/loop/try).
 * Mutates the body array in place.
 * Returns the number of instructions removed.
 */
function eliminateDeadCode(body: Instr[]): number {
  let removed = 0;

  // First, recurse into structured blocks
  for (const instr of body) {
    if (instr.op === "if") {
      const ifInstr = instr as { op: "if"; then: Instr[]; else?: Instr[] };
      removed += eliminateDeadCode(ifInstr.then);
      if (ifInstr.else) removed += eliminateDeadCode(ifInstr.else);
    } else if (instr.op === "block" || instr.op === "loop" || instr.op === "try_table") {
      const blockInstr = instr as { op: string; body: Instr[] };
      removed += eliminateDeadCode(blockInstr.body);
    } else if (instr.op === "try") {
      const tryInstr = instr as {
        op: "try";
        body: Instr[];
        catches: Array<{ body: Instr[] }>;
        catchAll?: Instr[];
      };
      removed += eliminateDeadCode(tryInstr.body);
      for (const c of tryInstr.catches || []) {
        removed += eliminateDeadCode(c.body);
      }
      if (tryInstr.catchAll) removed += eliminateDeadCode(tryInstr.catchAll);
    }
  }

  // Then, truncate after terminators at this level
  for (let i = 0; i < body.length; i++) {
    if (isTerminator(body[i]!.op)) {
      const deadCount = body.length - (i + 1);
      if (deadCount > 0) {
        body.splice(i + 1, deadCount);
        removed += deadCount;
      }
      break;
    }
    // Don't look inside structured blocks for terminators at this level
    // (their internal terminators don't make the outer code unreachable)
  }

  return removed;
}

/**
 * Resolve a FuncTypeDef from the module's type table, handling sub/rec wrappers.
 */
export function resolveFuncType(types: TypeDef[], typeIdx: number): FuncTypeDef | null {
  const t = types[typeIdx];
  if (!t) return null;
  if (t.kind === "func") return t;
  if (t.kind === "rec") {
    // rec groups contain sub-types; look for the first func type
    for (const sub of t.types) {
      if (sub.kind === "sub" && sub.type.kind === "func") return sub.type;
      if ((sub as any).kind === "func") return sub as any;
    }
  }
  if ((t as any).kind === "sub" && (t as any).type?.kind === "func") {
    return (t as any).type;
  }
  return null;
}

function assertLocalRefsInRange(func: WasmFunction, ft: FuncTypeDef | null, stage: string): void {
  const limit = (ft?.params.length ?? 0) + func.locals.length;
  walkInstructions(func.body, (instr) => {
    if ((instr.op === "local.get" || instr.op === "local.set" || instr.op === "local.tee") && instr.index >= limit) {
      throw new Error(
        `stack-balance invariant (${stage}): '${func.name}' references local ${instr.index}, ` +
          `but only ${ft?.params.length ?? 0} params + ${func.locals.length} locals are declared ` +
          `(locals: ${func.locals.map((local, index) => `${(ft?.params.length ?? 0) + index}:${local.name}`).join(", ")}; ` +
          `body: ${JSON.stringify(func.body, (_key, value) => (typeof value === "bigint" ? `${value}n` : value))})`,
      );
    }
  });
}

/**
 * Compute the net stack delta for a single instruction.
 * Returns UNREACHABLE for terminators (return, br, throw, unreachable).
 *
 * For structured blocks (if, block, loop, try), returns the delta based
 * on blockType alone (the contents are validated recursively).
 */
function instrDelta(instr: Instr, types: TypeDef[], funcSigs: FuncSigInfo): number {
  const op = instr.op;

  // Terminators -- make subsequent code unreachable
  if (
    op === "return" ||
    op === "return_call" ||
    op === "return_call_ref" ||
    op === "br" ||
    op === "throw" ||
    op === "rethrow" ||
    op === "unreachable"
  ) {
    return UNREACHABLE;
  }

  // Push 1 value
  if (
    op === "i32.const" ||
    op === "i64.const" ||
    op === "f64.const" ||
    op === "f32.const" ||
    op === "v128.const" ||
    op === "local.get" ||
    op === "global.get" ||
    op === "ref.null" ||
    op === "ref.null.extern" ||
    op === "ref.null.eq" ||
    op === "ref.null.func" ||
    op === "ref.func" ||
    op === "memory.size"
  ) {
    return 1;
  }

  // Push 1, pop 1 (net 0)
  if (
    op === "local.tee" ||
    op === "ref.as_non_null" ||
    op === "ref.cast" ||
    op === "ref.cast_null" ||
    op === "ref.test" ||
    op === "ref.is_null" ||
    op === "i32.eqz" ||
    op === "i32.clz" ||
    op === "f64.neg" ||
    op === "f64.abs" ||
    op === "f64.floor" ||
    op === "f64.ceil" ||
    op === "f64.trunc" ||
    op === "f64.nearest" ||
    op === "f64.sqrt" ||
    op === "f64.convert_i32_s" ||
    op === "f64.convert_i32_u" ||
    op === "f64.convert_i64_s" ||
    op === "f64.promote_f32" ||
    op === "f32.demote_f64" ||
    op === "f64.reinterpret_i64" ||
    op === "i64.reinterpret_f64" ||
    op === "f32.reinterpret_i32" ||
    op === "i32.reinterpret_f32" ||
    op === "i32.trunc_sat_f64_s" ||
    op === "i32.trunc_sat_f64_u" ||
    op === "i32.trunc_f64_s" ||
    op === "i64.trunc_sat_f64_s" ||
    op === "i64.trunc_f64_s" ||
    op === "i64.extend_i32_s" ||
    op === "i64.extend_i32_u" ||
    op === "i32.wrap_i64" ||
    op === "extern.convert_any" ||
    op === "array.len" ||
    op === "memory.grow" ||
    op === "v128.not" ||
    op === "v128.any_true" ||
    op === "i8x16.splat" ||
    op === "i16x8.splat" ||
    op === "i32x4.splat" ||
    op === "i64x2.splat" ||
    op === "f32x4.splat" ||
    op === "f64x2.splat" ||
    op === "i8x16.all_true" ||
    op === "i8x16.bitmask" ||
    op === "i16x8.all_true" ||
    op === "i16x8.bitmask" ||
    op === "i32x4.all_true" ||
    op === "i32x4.bitmask" ||
    op === "nop"
  ) {
    return 0;
  }

  // Pop 1, push 0
  if (op === "drop" || op === "local.set" || op === "global.set") {
    return -1;
  }

  // Pop 2, push 1 (net -1)
  if (
    op === "i32.add" ||
    op === "i32.sub" ||
    op === "i32.mul" ||
    op === "i32.div_s" ||
    op === "i32.div_u" ||
    op === "i32.rem_s" ||
    op === "i32.rem_u" ||
    op === "i32.and" ||
    op === "i32.or" ||
    op === "i32.xor" ||
    op === "i32.shl" ||
    op === "i32.shr_s" ||
    op === "i32.shr_u" ||
    op === "i32.eq" ||
    op === "i32.ne" ||
    op === "i32.lt_s" ||
    op === "i32.le_s" ||
    op === "i32.gt_s" ||
    op === "i32.ge_s" ||
    op === "i32.lt_u" ||
    op === "i32.le_u" ||
    op === "i32.gt_u" ||
    op === "i32.ge_u" ||
    op === "i64.add" ||
    op === "i64.sub" ||
    op === "i64.mul" ||
    op === "i64.div_s" ||
    op === "i64.div_u" ||
    op === "i64.rem_s" ||
    op === "i64.rem_u" ||
    op === "i64.and" ||
    op === "i64.or" ||
    op === "i64.xor" ||
    op === "i64.shl" ||
    op === "i64.shr_s" ||
    op === "i64.shr_u" ||
    op === "i64.eq" ||
    op === "i64.ne" ||
    op === "i64.lt_s" ||
    op === "i64.lt_u" ||
    op === "i64.le_s" ||
    op === "i64.le_u" ||
    op === "i64.gt_s" ||
    op === "i64.gt_u" ||
    op === "i64.ge_s" ||
    op === "i64.ge_u" ||
    op === "f64.add" ||
    op === "f64.sub" ||
    op === "f64.mul" ||
    op === "f64.div" ||
    op === "f64.eq" ||
    op === "f64.ne" ||
    op === "f64.lt" ||
    op === "f64.le" ||
    op === "f64.gt" ||
    op === "f64.ge" ||
    op === "f64.copysign" ||
    op === "f64.min" ||
    op === "f64.max" ||
    op === "ref.eq"
  ) {
    return -1;
  }

  // Pop 1, push 0 (conditional branch)
  if (op === "br_if") return -1;

  // select: pop 3, push 1 (net -2)
  if (op === "select") return -2;

  // struct.new: pop N fields, push 1
  if (op === "struct.new") {
    const typeIdx = (instr as any).typeIdx;
    const t = types[typeIdx];
    if (t && t.kind === "struct") {
      return -t.fields.length + 1;
    }
    return 0; // fallback
  }

  // struct.get: pop 1, push 1 (net 0)
  if (op === "struct.get") return 0;

  // struct.set: pop 2, push 0 (net -2)
  if (op === "struct.set") return -2;

  // array.new: pop 2 (value + length), push 1 (net -1)
  if (op === "array.new") return -1;

  // array.new_default: pop 1 (length), push 1 (net 0)
  if (op === "array.new_default") return 0;

  // array.new_fixed: pop N elements, push 1
  if (op === "array.new_fixed") {
    return -((instr as any).length || 0) + 1;
  }

  // array.get/get_s/get_u: pop 2 (array + index), push 1 (net -1)
  if (op === "array.get" || op === "array.get_s" || op === "array.get_u") return -1;

  // array.set: pop 3 (array + index + value), push 0 (net -3)
  if (op === "array.set") return -3;

  // array.copy: pop 5, push 0
  if (op === "array.copy") return -5;

  // array.fill: pop 4, push 0
  if (op === "array.fill") return -4;

  // call: pop params, push results
  if (op === "call") {
    const funcIdx = (instr as any).funcIdx;
    const sig = funcSigs.get(funcIdx);
    if (sig) {
      return -sig.params + sig.results;
    }
    return 0; // fallback: assume balanced
  }

  // call_ref: pop params + 1 (funcref), push results
  if (op === "call_ref") {
    const typeIdx = (instr as any).typeIdx;
    const ft = resolveFuncType(types, typeIdx);
    if (ft) {
      return -(ft.params.length + 1) + ft.results.length;
    }
    return 0;
  }

  // call_indirect: pop params + 1 (table index), push results
  if (op === "call_indirect") {
    const typeIdx = (instr as any).typeIdx;
    const ft = resolveFuncType(types, typeIdx);
    if (ft) {
      return -(ft.params.length + 1) + ft.results.length;
    }
    return 0;
  }

  // Structured blocks: their external stack effect is determined by blockType
  if (op === "if" || op === "block" || op === "loop" || op === "try" || op === "try_table") {
    const bt = (instr as any).blockType as BlockType;
    if (!bt || bt.kind === "empty") {
      // if also pops the condition (1 value)
      return op === "if" ? -1 : 0;
    }
    if (bt.kind === "val") {
      return op === "if" ? 0 : 1; // if pops 1 (condition), pushes 1 (result)
    }
    if (bt.kind === "type") {
      const ft = resolveFuncType(types, bt.typeIdx);
      if (ft) {
        const netBlock = -ft.params.length + ft.results.length;
        return op === "if" ? netBlock - 1 : netBlock;
      }
    }
    return op === "if" ? -1 : 0;
  }

  // Memory loads: pop 1 (address), push 1 (value) -- net 0
  if (
    op.endsWith(".load") ||
    op.includes(".load8") ||
    op.includes(".load16") ||
    op.includes(".load32_zero") ||
    op.includes(".load64_zero") ||
    op.includes("_splat")
  ) {
    return 0;
  }

  // Memory stores: pop 2 (address + value) -- net -2
  if (op.endsWith(".store") || op.includes(".store8") || op.includes(".store16")) {
    return -2;
  }

  // SIMD binary ops: pop 2, push 1 (net -1)
  if (
    (op.startsWith("i8x16.") ||
      op.startsWith("i16x8.") ||
      op.startsWith("i32x4.") ||
      op.startsWith("i64x2.") ||
      op.startsWith("f32x4.") ||
      op.startsWith("f64x2.")) &&
    (op.includes(".add") ||
      op.includes(".sub") ||
      op.includes(".mul") ||
      op.includes(".div") ||
      op.includes(".eq") ||
      op.includes(".ne") ||
      op.includes(".lt") ||
      op.includes(".gt") ||
      op.includes(".min") ||
      op.includes(".max") ||
      op.includes(".shl") ||
      op.includes(".shr"))
  ) {
    return -1;
  }

  // SIMD extract_lane: pop 1, push 1 (net 0)
  if (op.includes("extract_lane")) return 0;

  // SIMD replace_lane: pop 2, push 1 (net -1)
  if (op.includes("replace_lane")) return -1;

  // SIMD shuffle: pop 2, push 1 (net -1)
  if (op === "i8x16.shuffle" || op === "i8x16.swizzle") return -1;

  // SIMD bitselect: pop 3, push 1 (net -2)
  if (op === "v128.bitselect") return -2;

  // SIMD v128 binary: pop 2, push 1 (net -1)
  if (op === "v128.and" || op === "v128.andnot" || op === "v128.or" || op === "v128.xor") {
    return -1;
  }

  // Unknown instruction -- assume balanced (conservative)
  return 0;
}

interface FuncSigInfo {
  get(funcIdx: number): { params: number; results: number; resultType?: string } | undefined;
}

/**
 * Compute the net stack delta for a linear sequence of instructions.
 * Returns UNREACHABLE if the sequence ends in unreachable code.
 */
function sequenceDelta(body: Instr[], types: TypeDef[], sigs: FuncSigInfo): number {
  let delta = 0;
  for (const instr of body) {
    const d = instrDelta(instr, types, sigs);
    if (d === UNREACHABLE) return UNREACHABLE;
    delta += d;
  }
  return delta;
}

/**
 * Get the expected stack delta for a block type.
 */
function blockTypeExpected(bt: BlockType, types: TypeDef[]): number {
  if (bt.kind === "empty") return 0;
  if (bt.kind === "val") return 1;
  if (bt.kind === "type") {
    const ft = resolveFuncType(types, bt.typeIdx);
    if (ft) return -ft.params.length + ft.results.length;
  }
  return 0;
}

/**
 * Infer the type category of the value produced by the last instruction in a sequence.
 * Returns "f64", "i32", "i64", "externref", "ref", "anyref", or null if unknown.
 */
function inferLastType(body: Instr[], types: TypeDef[], sigs: FuncSigInfo): string | null {
  // Walk backwards to find the last value-producing instruction
  for (let i = body.length - 1; i >= 0; i--) {
    const instr = body[i]!;
    const op = instr.op;

    // Skip drops, local.set, global.set (they consume but don't produce)
    if (op === "drop" || op === "local.set" || op === "global.set") continue;

    // f64 producers
    if (
      op === "f64.const" ||
      op === "f64.add" ||
      op === "f64.sub" ||
      op === "f64.mul" ||
      op === "f64.div" ||
      op === "f64.neg" ||
      op === "f64.abs" ||
      op === "f64.floor" ||
      op === "f64.ceil" ||
      op === "f64.trunc" ||
      op === "f64.nearest" ||
      op === "f64.sqrt" ||
      op === "f64.copysign" ||
      op === "f64.min" ||
      op === "f64.max" ||
      op === "f64.convert_i32_s" ||
      op === "f64.convert_i32_u" ||
      op === "f64.convert_i64_s" ||
      op === "f64.promote_f32" ||
      op === "f64.reinterpret_i64"
    ) {
      return "f64";
    }

    // i32 producers
    if (
      op === "i32.const" ||
      op === "i32.add" ||
      op === "i32.sub" ||
      op === "i32.mul" ||
      op === "i32.and" ||
      op === "i32.or" ||
      op === "i32.xor" ||
      op === "i32.eqz" ||
      op === "i32.eq" ||
      op === "i32.ne" ||
      op === "i32.lt_s" ||
      op === "i32.le_s" ||
      op === "i32.gt_s" ||
      op === "i32.ge_s" ||
      op === "i32.shl" ||
      op === "i32.shr_s" ||
      op === "i32.shr_u" ||
      op === "i32.trunc_sat_f64_s" ||
      op === "i32.trunc_f64_s" ||
      op === "ref.is_null" ||
      op === "ref.test" ||
      op === "ref.eq" ||
      op === "f64.eq" ||
      op === "f64.ne" ||
      op === "f64.lt" ||
      op === "f64.le" ||
      op === "f64.gt" ||
      op === "f64.ge" ||
      op === "i64.eq" ||
      op === "i64.ne" ||
      op === "i64.lt_s" ||
      op === "i64.lt_u" ||
      op === "i64.le_s" ||
      op === "i64.le_u" ||
      op === "i64.gt_s" ||
      op === "i64.gt_u" ||
      op === "i64.ge_s" ||
      op === "i64.ge_u"
    ) {
      return "i32";
    }

    // i64 producers
    if (
      op === "i64.const" ||
      op === "i64.add" ||
      op === "i64.sub" ||
      op === "i64.mul" ||
      op === "i64.div_s" ||
      op === "i64.div_u" ||
      op === "i64.rem_s" ||
      op === "i64.rem_u" ||
      op === "i64.and" ||
      op === "i64.or" ||
      op === "i64.xor" ||
      op === "i64.extend_i32_s" ||
      op === "i64.extend_i32_u" ||
      op === "i64.trunc_sat_f64_s" ||
      op === "i64.trunc_f64_s" ||
      op === "i64.shl" ||
      op === "i64.shr_s" ||
      op === "i64.shr_u" ||
      op === "i64.reinterpret_f64"
    ) {
      return "i64";
    }

    // externref producers
    if (op === "ref.null.extern" || op === "extern.convert_any") {
      return "externref";
    }

    // ref producers (GC refs) -- only include ops that ALWAYS produce ref types
    // Note: struct.get and array.get are excluded because they can return f64/i32/etc
    if (
      op === "struct.new" ||
      op === "array.new" ||
      op === "array.new_default" ||
      op === "array.new_fixed" ||
      op === "ref.cast" ||
      op === "ref.cast_null" ||
      op === "ref.as_non_null" ||
      op === "any.convert_extern"
    ) {
      return "ref";
    }

    // ref.null with typeIdx
    if (op === "ref.null") return "ref";
    if (op === "ref.null.eq") return "eqref";
    if (op === "ref.null.func" || op === "ref.func") return "funcref";

    // local.tee preserves type -- unknown without local type info
    if (op === "local.tee" || op === "local.get" || op === "global.get") return null;

    // call_ref: try to determine result from func type
    if (op === "call_ref") {
      const typeIdx = (instr as any).typeIdx;
      if (typeIdx !== undefined) {
        const ft = resolveFuncType(types, typeIdx);
        if (ft && ft.results.length === 1) {
          const rk = ft.results[0]!.kind;
          if (rk === "f64") return "f64";
          if (rk === "i32") return "i32";
          if (rk === "i64") return "i64";
          if (rk === "externref" || rk === "ref_extern") return "externref";
          if (rk === "ref" || rk === "ref_null") return "ref";
        }
      }
      return null;
    }

    // f32 producers
    if (op === "f32.const") return "f32";

    // select preserves operand type -- unknown without further analysis
    if (op === "select") return null;

    // call: check result type -- only trust high-confidence type categories
    if (op === "call") {
      const funcIdx = (instr as any).funcIdx;
      const sig = sigs.get(funcIdx);
      if (
        sig &&
        sig.resultType &&
        (sig.resultType === "f64" ||
          sig.resultType === "i32" ||
          sig.resultType === "i64" ||
          sig.resultType === "externref")
      ) {
        return sig.resultType;
      }
      return null;
    }

    // Structured blocks: result is their blockType
    if (op === "if" || op === "block" || op === "loop" || op === "try" || op === "try_table") {
      const bt = (instr as any).blockType as BlockType;
      if (bt?.kind === "val") {
        const t = bt.type;
        if (t.kind === "f64") return "f64";
        if (t.kind === "i32") return "i32";
        if (t.kind === "i64") return "i64";
        if (t.kind === "externref" || t.kind === "ref_extern") return "externref";
        if (t.kind === "ref" || t.kind === "ref_null") return "ref";
      }
      // (#1573) A VOID structured instruction (empty block type — e.g. a
      // null-guarded callback-capture writeback `if`) consumes its own
      // condition/operands and produces nothing; the real branch result is
      // BELOW it. Continuing the backward scan past it misreads an operand of
      // the block's condition (the writeback's internal `i32.eqz`) as the
      // branch result → "i32", and `fixBranchType` then splices a wrong
      // `f64.convert_i32_s + __box_number` over the real externref value
      // (ESLint `LazyLoadingRuleMap_new` validation failure). Stop and report
      // null so `fixBranchType` SKIPS rather than mis-coerces.
      return null;
    }

    // For anything else, we can't determine the type
    return null;
  }
  return null;
}

/**
 * Check if two type categories are compatible for Wasm validation.
 */
function typesCompatible(produced: string, expected: ValType): boolean {
  if (expected.kind === "externref" || expected.kind === "ref_extern") {
    return produced === "externref";
  }
  if (expected.kind === "f64") return produced === "f64";
  if (expected.kind === "i32") return produced === "i32";
  if (expected.kind === "i64") return produced === "i64";
  if (expected.kind === "f32") return produced === "f32";
  if (expected.kind === "ref" || expected.kind === "ref_null") {
    return produced === "ref" || produced === "eqref";
  }
  if (expected.kind === "anyref") {
    return produced === "ref" || produced === "externref" || produced === "anyref";
  }
  return true; // unknown - assume compatible
}

/**
 * Insert type coercion instructions at the end of a branch body to match the expected type.
 * Returns the number of fixups applied.
 */
/**
 * Map the `inferLastType` kind-name string to a synthetic ValType so the branch
 * fixup can consult the single `coercionPlan` table. `inferLastType` only knows
 * the kind (no struct typeIdx); the plan's scalar/box-unbox rows never need the
 * `from` typeIdx, so a placeholder (0) is safe for ref/ref_null `from`.
 */
function syntheticValType(kind: string): ValType | null {
  switch (kind) {
    case "i32":
    case "i64":
    case "f64":
    case "f32":
    case "externref":
    case "anyref":
    case "eqref":
    case "funcref":
      return { kind } as ValType;
    case "ref":
    case "ref_null":
      return { kind, typeIdx: 0 } as ValType;
    default:
      return null;
  }
}

function fixBranchType(
  body: Instr[],
  blockType: BlockType,
  types: TypeDef[],
  sigs: FuncSigInfo,
  boxNumberIdx: number | null,
  unboxNumberIdx: number | null,
): number {
  if (blockType.kind !== "val") return 0;
  const expectedType = blockType.type;

  const produced = inferLastType(body, types, sigs);
  if (!produced) return 0; // can't determine type - skip

  if (typesCompatible(produced, expectedType)) return 0; // types match

  // #1917 Step 0: route scalar / numeric / box-unbox conversions through the
  // single coercion table so a branch result is coerced IDENTICALLY to a call
  // argument or a local.set. Previously this function emitted lossy
  // `drop; f64.const 0` for externref→f64 and ref→f64 (the headline #1917
  // divergence) while the call-arg path correctly unboxed via __unbox_number.
  const fromVT = syntheticValType(produced);
  if (fromVT) {
    const plan = coercionPlan(fromVT, expectedType, { boxNumberIdx, unboxNumberIdx });
    if (plan) {
      body.push(...plan.instrs);
      // (#2140) Propagate the plan's lossiness — the lossy rows (funcref→
      // externref; any-hierarchy→numeric without an unbox helper) were being
      // mis-recorded as clean coercions, hiding them from the strict-mode
      // LOSSY marker and the audit trail.
      recordFixup(
        "branch-type-coerce",
        `coerced branch result ${produced} → ${expectedType.kind}`,
        plan.lossy === true,
      ); // #1918
      return 1;
    }
  }

  // ── rows that need the expected struct typeIdx (not coercionPlan rows) ──

  // externref → ref/ref_null: any.convert_extern + ref.cast_null
  // Uses ref.cast_null unconditionally — passes null through instead of trapping.
  // Downstream code has null guards, so null values are handled correctly.
  if ((expectedType.kind === "ref" || expectedType.kind === "ref_null") && produced === "externref") {
    body.push({ op: "any.convert_extern" });
    body.push({ op: "ref.cast_null", typeIdx: expectedType.typeIdx });
    recordFixup("branch-type-cast", `cast branch result externref → ${expectedType.kind} #${expectedType.typeIdx}`); // #1918
    return 1;
  }

  // (#2140 note) There is deliberately NO ref/eqref → concrete-ref cast arm
  // here: `typesCompatible` assumes ref/eqref are compatible with any expected
  // ref/ref_null (the kind-string inference carries no typeIdx to know
  // better), so such pairs never reach this function, and `inferLastType`
  // never yields "anyref" (any.convert_extern is classified "ref"). The
  // richer per-instruction contexts (call args / local.set), whose
  // `inferInstrType` DOES read local/global types, get the eqref/anyref
  // rows from the shared coercionPlan instead.

  // (#2140) Unfixable: the produced kind is KNOWN-incompatible with the block
  // type and no coercion row / cast arm bridges it (e.g. funcref→f64,
  // numeric→funcref). Leaving it silently meant the module failed
  // `WebAssembly.validate` later with an opaque offset-only error. Record the
  // located event (lossy — the module is about to be invalid): it surfaces in
  // the per-compile fixup summary, becomes a hard error under
  // `JS2WASM_STRICT_BALANCE=error`, and is ratcheted at 0 by the corpus gate.
  // Promotion to an unconditional compile error is the staged follow-up once
  // the corpus row + a CI test262 delta prove 0 occurrences (`inferLastType`
  // is heuristic; a mis-inference here is a no-op today but would be a
  // spurious compile failure under an unconditional throw).
  recordFixup(
    "branch-type-unfixable",
    `branch result ${produced} is incompatible with block type ${expectedType.kind}` +
      (expectedType.kind === "ref" || expectedType.kind === "ref_null" ? ` #${expectedType.typeIdx}` : "") +
      ` and no coercion bridges it (module will fail validation)`,
    true,
  );
  return 0;
}

/**
 * Fix a branch (instruction body) to match the expected stack delta.
 * Appends drop or default-value instructions as needed.
 * Also fixes type mismatches between branch result and block type.
 * Mutates the body array in place.
 * Returns the number of fixups applied.
 */
function fixBranch(
  body: Instr[],
  expected: number,
  types: TypeDef[],
  sigs: FuncSigInfo,
  blockType: BlockType,
  boxNumberIdx: number | null,
  unboxNumberIdx: number | null,
): number {
  const actual = sequenceDelta(body, types, sigs);
  if (actual === UNREACHABLE) return 0; // unreachable branch -- validator accepts anything

  let fixups = 0;

  if (actual > expected) {
    // Too many values -- add drops
    for (let i = 0; i < actual - expected; i++) {
      body.push({ op: "drop" });
      recordFixup("drop-excess", `dropped 1 surplus value (had ${actual}, block expects ${expected})`); // #1918
      fixups++;
    }
  } else if (actual < expected) {
    // Not enough values -- add default pushes (then unreachable if we can't determine the type)
    // For valued blocks, push a zero/default value for each missing slot
    for (let i = 0; i < expected - actual; i++) {
      if (blockType.kind === "val") {
        const t = blockType.type;
        switch (t.kind) {
          case "i32":
            body.push({ op: "i32.const", value: 0 });
            // #1918 — LOSSY: a missing branch value is filled with a typed
            // const default. If the producer was *supposed* to push a value,
            // this silently substitutes 0 at runtime. AC #3: warning-visible.
            recordFixup("default-value-lossy", "i32.const 0 default for a missing branch value", true);
            break;
          case "i64":
            body.push({ op: "i64.const", value: 0n });
            recordFixup("default-value-lossy", "i64.const 0 default for a missing branch value", true);
            break;
          case "f64":
            body.push({ op: "f64.const", value: 0 });
            recordFixup("default-value-lossy", "f64.const 0 default for a missing branch value", true);
            break;
          case "f32":
            body.push({ op: "f32.const", value: 0 });
            recordFixup("default-value-lossy", "f32.const 0 default for a missing branch value", true);
            break;
          case "externref":
            body.push({ op: "ref.null.extern" });
            recordFixup("default-value-lossy", "ref.null.extern default for a missing branch value", true);
            break;
          case "ref":
          case "ref_null":
            body.push({ op: "ref.null", typeIdx: t.typeIdx });
            recordFixup(
              "default-value-lossy",
              `ref.null (type #${t.typeIdx}) default for a missing branch value`,
              true,
            );
            break;
          default:
            // #2090 — unknown value type: we cannot pick a correct default, so
            // inventing one would mask a real producer bug. Record the site;
            // stackBalance turns it into a hard compile error. Still push a
            // placeholder so the rest of the pass can finish walking (the
            // compile fails via the recorded error regardless).
            inventedValueSites.push({
              func: currentDiagFunc,
              detail: `missing value of unknown valtype kind "${(t as { kind?: string }).kind ?? "?"}" in a val-typed block`,
            });
            body.push({ op: "ref.null.extern" });
            break;
        }
      } else {
        // #2090 — type-indexed block type: individual value types aren't
        // recoverable here, so a default is necessarily a guess. Record it as a
        // hard error rather than inventing a ref.null.extern (see above).
        inventedValueSites.push({
          func: currentDiagFunc,
          detail: "missing value in a type-indexed (multi-value) block whose element types are not recoverable",
        });
        body.push({ op: "ref.null.extern" });
      }
      fixups++;
    }
  }

  // After fixing count, also fix type mismatches if count is now correct
  if (actual === expected || fixups > 0) {
    // Re-check delta after fixups
    const newDelta = sequenceDelta(body, types, sigs);
    if (newDelta === expected && newDelta > 0) {
      fixups += fixBranchType(body, blockType, types, sigs, boxNumberIdx, unboxNumberIdx);
    }
  }

  return fixups;
}

/**
 * Get the number of values a catch clause pushes onto the stack
 * based on the tag's type signature.
 */
function getTagArity(tagIdx: number, tags: Array<{ typeIdx: number }>, types: TypeDef[]): number {
  const tag = tags[tagIdx];
  if (!tag) return 1; // fallback: assume 1 (externref)
  const ft = resolveFuncType(types, tag.typeIdx);
  if (ft) return ft.params.length;
  return 1; // fallback
}

/**
 * Recursively fix stack mismatches in a body of instructions.
 * Returns the total number of fixups applied.
 */
function fixBody(
  body: Instr[],
  types: TypeDef[],
  sigs: FuncSigInfo,
  tags: Array<{ typeIdx: number }>,
  boxNumberIdx: number | null,
  unboxNumberIdx: number | null,
): number {
  let fixups = 0;

  for (const instr of body) {
    if (instr.op === "if") {
      const ifInstr = instr as { op: "if"; blockType: BlockType; then: Instr[]; else?: Instr[] };
      const expected = blockTypeExpected(ifInstr.blockType, types);

      // Recurse into branches first
      fixups += fixBody(ifInstr.then, types, sigs, tags, boxNumberIdx, unboxNumberIdx);
      if (ifInstr.else) {
        fixups += fixBody(ifInstr.else, types, sigs, tags, boxNumberIdx, unboxNumberIdx);
      }

      // Fix then branch
      fixups += fixBranch(ifInstr.then, expected, types, sigs, ifInstr.blockType, boxNumberIdx, unboxNumberIdx);

      // Fix else branch (or create one if needed for valued blocks)
      if (ifInstr.else) {
        fixups += fixBranch(ifInstr.else, expected, types, sigs, ifInstr.blockType, boxNumberIdx, unboxNumberIdx);
      } else if (expected > 0) {
        // Valued block with no else -- need to add an else branch with default values
        ifInstr.else = [];
        fixups += fixBranch(ifInstr.else, expected, types, sigs, ifInstr.blockType, boxNumberIdx, unboxNumberIdx);
      }
    } else if (instr.op === "block" || instr.op === "loop" || instr.op === "try_table") {
      const blockInstr = instr as { op: string; blockType: BlockType; body: Instr[] };
      fixups += fixBody(blockInstr.body, types, sigs, tags, boxNumberIdx, unboxNumberIdx);

      const expected = blockTypeExpected(blockInstr.blockType, types);
      fixups += fixBranch(blockInstr.body, expected, types, sigs, blockInstr.blockType, boxNumberIdx, unboxNumberIdx);
    } else if (instr.op === "try") {
      const tryInstr = instr as {
        op: "try";
        blockType: BlockType;
        body: Instr[];
        catches: Array<{ tagIdx: number; body: Instr[] }>;
        catchAll?: Instr[];
      };
      const expected = blockTypeExpected(tryInstr.blockType, types);

      // Recurse into all branches
      fixups += fixBody(tryInstr.body, types, sigs, tags, boxNumberIdx, unboxNumberIdx);
      for (const c of tryInstr.catches || []) {
        fixups += fixBody(c.body, types, sigs, tags, boxNumberIdx, unboxNumberIdx);
      }
      if (tryInstr.catchAll) {
        fixups += fixBody(tryInstr.catchAll, types, sigs, tags, boxNumberIdx, unboxNumberIdx);
      }

      // Fix the do body
      fixups += fixBranch(tryInstr.body, expected, types, sigs, tryInstr.blockType, boxNumberIdx, unboxNumberIdx);

      // Fix catch bodies. Each catch clause pushes the tag's parameter values
      // onto the stack before the body executes.
      for (const c of tryInstr.catches || []) {
        const tagArity = getTagArity(c.tagIdx, tags, types);
        fixups += fixBranch(c.body, expected - tagArity, types, sigs, tryInstr.blockType, boxNumberIdx, unboxNumberIdx);
      }

      // Fix catch_all body (no values pushed by catch_all)
      if (tryInstr.catchAll) {
        fixups += fixBranch(tryInstr.catchAll, expected, types, sigs, tryInstr.blockType, boxNumberIdx, unboxNumberIdx);
      }
    }
  }

  return fixups;
}

/**
 * Build a map from function index to its signature (param count, result count).
 * Includes both imported and defined functions.
 */
/**
 * Map a ValType to a type category string for type inference.
 */
function valTypeCategory(vt: ValType): string | undefined {
  switch (vt.kind) {
    case "f64":
      return "f64";
    case "i32":
      return "i32";
    case "i64":
      return "i64";
    case "f32":
      return "f32";
    case "externref":
    case "ref_extern":
      return "externref";
    case "ref":
    case "ref_null":
      return "ref";
    case "funcref":
      return "funcref";
    case "eqref":
      return "eqref";
    case "anyref":
      return "anyref";
    default:
      return undefined;
  }
}

function buildFuncSigs(mod: WasmModule): FuncSigInfo {
  const map = new Map<number, { params: number; results: number; resultType?: string }>();

  // Imported functions come first
  let idx = 0;
  for (const imp of mod.imports) {
    if (imp.desc.kind === "func") {
      const ft = resolveFuncType(mod.types, imp.desc.typeIdx);
      if (ft) {
        const resultType = ft.results.length === 1 ? valTypeCategory(ft.results[0]!) : undefined;
        map.set(idx, { params: ft.params.length, results: ft.results.length, resultType });
      }
      idx++;
    }
  }

  // Then defined functions
  const numImports = idx;
  for (const func of mod.functions) {
    const ft = resolveFuncType(mod.types, func.typeIdx);
    assertLocalRefsInRange(func, ft, "entry");
    if (ft) {
      const resultType = ft.results.length === 1 ? valTypeCategory(ft.results[0]!) : undefined;
      map.set(idx, { params: ft.params.length, results: ft.results.length, resultType });
    }
    idx++;
  }

  // (#1916 S3) Register stable-regime ALIASES: a `call` immediate may carry a
  // stable handle (STABLE_FUNC_BASE + ordinal) instead of an absolute index.
  // Aliasing the same sig record under the handle key makes every
  // `sigs.get(funcIdx)` read site dual-regime with no per-site changes.
  for (let ordinal = 0; ordinal < mod.funcOrdinalToPosition.length; ordinal++) {
    const pos = mod.funcOrdinalToPosition[ordinal]!;
    if (Number.isNaN(pos)) continue; // minted, never pushed — resolution throws elsewhere
    const sig = map.get(numImports + pos);
    if (sig) map.set(STABLE_FUNC_BASE + ordinal, sig);
  }

  return map;
}

/**
 * Run stack-balancing fixups on all function bodies in a WasmModule.
 * Returns the total number of fixups applied.
 */
/**
 * Resolve full param types for a function by index.
 */
export function getFullParamTypes(mod: WasmModule, funcIdx: number, numImports: number): ValType[] | null {
  // (#1916 S3) normalize a possibly-stable handle to the absolute index first.
  funcIdx = absoluteFuncIndexCached(mod, numImports, funcIdx);
  if (funcIdx < numImports) {
    let importFuncCount = 0;
    for (const imp of mod.imports) {
      if (imp.desc.kind === "func") {
        if (importFuncCount === funcIdx) {
          const ft = resolveFuncType(mod.types, imp.desc.typeIdx);
          return ft ? ft.params : null;
        }
        importFuncCount++;
      }
    }
    return null;
  }
  const localIdx = funcIdx - numImports;
  const func = mod.functions[localIdx];
  if (!func) return null;
  const ft = resolveFuncType(mod.types, func.typeIdx);
  return ft ? ft.params : null;
}

/**
 * Infer the Wasm type produced by a single instruction, given local/param type info.
 * Returns the ValType or null if unknown.
 */
export function inferInstrType(
  instr: Instr,
  localTypes: ValType[],
  globalTypes: ValType[],
  types: TypeDef[],
  mod: WasmModule,
  numImports: number,
): ValType | null {
  const op = instr.op;
  if (op === "local.get" || op === "local.tee") {
    const idx = (instr as any).index as number;
    return localTypes[idx] ?? null;
  }
  if (op === "global.get") {
    const idx = (instr as any).index as number;
    return globalTypes[idx] ?? null;
  }
  if (
    op === "f64.const" ||
    op === "f64.add" ||
    op === "f64.sub" ||
    op === "f64.mul" ||
    op === "f64.div" ||
    op === "f64.neg" ||
    op === "f64.abs" ||
    op === "f64.floor" ||
    op === "f64.ceil" ||
    op === "f64.trunc" ||
    op === "f64.nearest" ||
    op === "f64.sqrt" ||
    op === "f64.copysign" ||
    op === "f64.min" ||
    op === "f64.max" ||
    op === "f64.convert_i32_s" ||
    op === "f64.convert_i32_u" ||
    op === "f64.convert_i64_s" ||
    op === "f64.promote_f32" ||
    op === "f64.reinterpret_i64"
  ) {
    return { kind: "f64" };
  }
  if (
    op === "i32.const" ||
    op === "i32.add" ||
    op === "i32.sub" ||
    op === "i32.mul" ||
    op === "i32.and" ||
    op === "i32.or" ||
    op === "i32.xor" ||
    op === "i32.eqz" ||
    op === "i32.eq" ||
    op === "i32.ne" ||
    op === "i32.lt_s" ||
    op === "i32.le_s" ||
    op === "i32.gt_s" ||
    op === "i32.ge_s" ||
    op === "i32.shl" ||
    op === "i32.shr_s" ||
    op === "i32.shr_u" ||
    op === "i32.trunc_sat_f64_s" ||
    op === "i32.trunc_f64_s" ||
    op === "i32.wrap_i64" ||
    op === "ref.is_null" ||
    op === "ref.test" ||
    op === "ref.eq" ||
    op === "f64.eq" ||
    op === "f64.ne" ||
    op === "f64.lt" ||
    op === "f64.le" ||
    op === "f64.gt" ||
    op === "f64.ge" ||
    op === "i64.eq" ||
    op === "i64.ne" ||
    op === "array.len"
  ) {
    return { kind: "i32" };
  }
  if (op === "i64.const" || op === "i64.extend_i32_s" || op === "i64.trunc_sat_f64_s" || op === "i64.reinterpret_f64") {
    return { kind: "i64" };
  }
  if (op === "ref.null.extern" || op === "extern.convert_any") {
    return { kind: "externref" };
  }
  if (op === "struct.new") {
    const typeIdx = (instr as any).typeIdx as number;
    return { kind: "ref", typeIdx };
  }
  if (op === "struct.get") {
    const typeIdx = (instr as any).typeIdx as number;
    const fieldIdx = (instr as any).fieldIdx as number;
    const td = types[typeIdx];
    if (td?.kind === "struct" && td.fields[fieldIdx]) {
      // Packed i8/i16 fields arrive on the stack widened to i32 (#2934).
      return widenPackedToI32(td.fields[fieldIdx]!.type);
    }
    return null;
  }
  if (op === "array.get" || op === "array.get_s" || op === "array.get_u") {
    const typeIdx = (instr as any).typeIdx as number;
    const td = types[typeIdx];
    // Packed i8/i16 elements arrive on the stack widened to i32 (#2934).
    if (td?.kind === "array") return widenPackedToI32(td.element);
    return null;
  }
  if (op === "ref.null") {
    const typeIdx = (instr as any).typeIdx as number;
    return { kind: "ref_null", typeIdx };
  }
  if (op === "ref.cast" || op === "ref.as_non_null") {
    const typeIdx = (instr as any).typeIdx as number;
    if (typeIdx !== undefined) return { kind: "ref", typeIdx };
    return null;
  }
  if (op === "ref.cast_null") {
    const typeIdx = (instr as any).typeIdx as number;
    return { kind: "ref_null", typeIdx };
  }
  if (op === "any.convert_extern") {
    return { kind: "anyref" } as ValType;
  }
  // Compound instructions (if/block/loop/try) produce a value based on blockType
  if (op === "if" || op === "block" || op === "loop" || op === "try" || op === "try_table") {
    const bt = (instr as any).blockType as BlockType | undefined;
    if (bt && bt.kind === "val") return bt.type;
    if (bt && bt.kind === "type") {
      const ft = resolveFuncType(types, bt.typeIdx);
      if (ft && ft.results.length === 1) return ft.results[0]!;
    }
    return null;
  }

  if (op === "call") {
    const funcIdx = absoluteFuncIndexCached(mod, numImports, (instr as any).funcIdx as number); // (#1916 S3)
    const pt = getFullParamTypes(mod, funcIdx, numImports);
    // Need result types, not params
    if (funcIdx < numImports) {
      let importFuncCount = 0;
      for (const imp of mod.imports) {
        if (imp.desc.kind === "func") {
          if (importFuncCount === funcIdx) {
            const ft = resolveFuncType(types, imp.desc.typeIdx);
            return ft && ft.results.length === 1 ? ft.results[0]! : null;
          }
          importFuncCount++;
        }
      }
    } else {
      const localFuncIdx = funcIdx - numImports;
      const func = mod.functions[localFuncIdx];
      if (func) {
        const ft = resolveFuncType(types, func.typeIdx);
        return ft && ft.results.length === 1 ? ft.results[0]! : null;
      }
    }
    return null;
  }
  return null;
}

/**
 * Check if a coercion is needed and generate the coercion instruction(s).
 * Returns an array of instructions to insert, or empty if no coercion needed.
 */
export function callArgCoercionInstrs(
  actual: ValType,
  expected: ValType,
  boxNumberIdx: number | null,
  unboxNumberIdx: number | null,
): Instr[] {
  // Same type — no coercion
  if (actual.kind === expected.kind) {
    if (
      (actual.kind === "ref" || actual.kind === "ref_null") &&
      (expected.kind === "ref" || expected.kind === "ref_null")
    ) {
      const actualIdx = (actual as any).typeIdx;
      const expectedIdx = (expected as any).typeIdx;
      if (actualIdx === expectedIdx) return [];
      // Different typeIdx (e.g. closure struct type shifted by addUnionImports) —
      // insert ref.cast_null to coerce to the expected ref type.
      // This is safe in call-argument context (callArgCoercionInstrs is only used there).
      if (expectedIdx !== undefined) {
        return [{ op: "ref.cast_null", typeIdx: expectedIdx }];
      }
    } else {
      return [];
    }
  }

  // Cross-kind ref ↔ ref_null: different nullability (ref vs ref_null)
  // In Wasm, (ref T) is a subtype of (ref null T), so same typeIdx needs no coercion.
  // Different typeIdx needs ref.cast_null to the expected type. (#822)
  if (
    (actual.kind === "ref" || actual.kind === "ref_null") &&
    (expected.kind === "ref" || expected.kind === "ref_null")
  ) {
    const actualIdx = (actual as any).typeIdx;
    const expectedIdx = (expected as any).typeIdx;
    if (actualIdx === expectedIdx) return []; // subtyping handles nullability
    if (expectedIdx !== undefined) {
      return [{ op: "ref.cast_null", typeIdx: expectedIdx }];
    }
  }

  // Both externref (possibly different kind strings: "externref" vs "ref_extern") — no coercion
  const actualIsExternref = actual.kind === "externref" || actual.kind === "ref_extern";
  const expectedIsExternref = expected.kind === "externref" || expected.kind === "ref_extern";
  if (actualIsExternref && expectedIsExternref) return [];

  // #1917 Step 0: scalar / numeric / box-unbox rows come from the single
  // coercion table so call-arg, branch, and local.set contexts agree exactly.
  const plan = coercionPlan(actual, expected, { boxNumberIdx, unboxNumberIdx });
  if (plan) return plan.instrs;

  // externref → ref/ref_null: any.convert_extern + ref.cast_null (needs typeIdx;
  // not a coercionPlan row because it requires the expected struct typeIdx).
  if (actualIsExternref && (expected.kind === "ref" || expected.kind === "ref_null")) {
    const typeIdx = (expected as any).typeIdx;
    if (typeIdx !== undefined) {
      return [{ op: "any.convert_extern" }, { op: "ref.cast_null", typeIdx }];
    }
  }

  return [];
}

/**
 * (#4415) Hoisted out of `fixCallArgTypesInBody`, where it was rebuilt on every
 * call. That function recurses into every `if` / `block` / `loop` / `try` of
 * every function body, so a ~90-element Set was being allocated and filled
 * thousands of times per compile. A CPU profile of 40 steady-state test262
 * compiles put `fixCallArgTypesInBody` at 4.8% self time — the largest
 * non-GC entry — with the garbage collector itself at 9.6%. The contents are
 * a compile-time constant; nothing here depends on the call.
 */
const SIMPLE_PRODUCERS: ReadonlySet<string> = new Set([
  "local.get",
  "global.get",
  "local.tee",
  "struct.new",
  "ref.null",
  "struct.get",
  "array.get",
  "array.get_s",
  "array.get_u",
  "call",
  "ref.cast",
  "ref.cast_null",
  "ref.as_non_null",
  "array.new_default",
  "array.new",
  "array.new_fixed",
  // f64/f32 constants — safe, never used as array/struct indices
  "f64.const",
  "f32.const",
  // Ref producers — safe, rarely used as sub-expression inputs
  "ref.null.extern",
  "ref.null.eq",
  "ref.null.func",
  "ref.func",
  // i32/i64 constants — safe when directly before call
  "i32.const",
  "i64.const",
  // i32 arithmetic/comparison — these produce i32 results
  "i32.add",
  "i32.sub",
  "i32.mul",
  "i32.div_s",
  "i32.div_u",
  "i32.rem_s",
  "i32.rem_u",
  "i32.and",
  "i32.or",
  "i32.xor",
  "i32.shl",
  "i32.shr_s",
  "i32.shr_u",
  "i32.eq",
  "i32.ne",
  "i32.lt_s",
  "i32.le_s",
  "i32.gt_s",
  "i32.ge_s",
  "i32.lt_u",
  "i32.le_u",
  "i32.gt_u",
  "i32.ge_u",
  "i32.eqz",
  "i32.clz",
  "i32.wrap_i64",
  "i32.trunc_sat_f64_s",
  "i32.trunc_sat_f64_u",
  "i32.trunc_f64_s",
  // i64 arithmetic — these produce i64 results
  "i64.add",
  "i64.sub",
  "i64.mul",
  "i64.div_s",
  "i64.rem_s",
  "i64.and",
  "i64.or",
  "i64.xor",
  "i64.shl",
  "i64.shr_s",
  "i64.shr_u",
  "i64.eq",
  "i64.ne",
  "i64.lt_s",
  "i64.le_s",
  "i64.gt_s",
  "i64.ge_s",
  "i64.eqz",
  "i64.extend_i32_s",
  "i64.extend_i32_u",
  "i64.trunc_sat_f64_s",
  "i64.trunc_f64_s",
  // f64 arithmetic — these produce f64 results
  "f64.add",
  "f64.sub",
  "f64.mul",
  "f64.div",
  "f64.neg",
  "f64.abs",
  "f64.floor",
  "f64.ceil",
  "f64.trunc",
  "f64.nearest",
  "f64.sqrt",
  "f64.copysign",
  "f64.min",
  "f64.max",
  "f64.convert_i32_s",
  "f64.convert_i32_u",
  "f64.convert_i64_s",
  "f64.promote_f32",
  "f64.reinterpret_i64",
  "i64.reinterpret_f64",
  "f64.eq",
  "f64.ne",
  "f64.lt",
  "f64.le",
  "f64.gt",
  "f64.ge",
  // Other type-producing ops
  "ref.is_null",
  "ref.test",
  "ref.eq",
  "array.len",
  "any.convert_extern",
  "extern.convert_any",
]);

/**
 * Fix call argument type mismatches in a function body.
 * Walks through the instruction stream and for each call/return_call,
 * checks argument types against expected parameter types and inserts
 * coercion instructions where needed.
 *
 * Only handles the common case where the argument-producing instruction
 * is directly before the call (single-value, no interleaving control flow).
 * For the last argument (top of stack before call), this is always the case
 * in linear instruction streams.
 */
function fixCallArgTypesInBody(
  body: Instr[],
  localTypes: ValType[],
  globalTypes: ValType[],
  types: TypeDef[],
  mod: WasmModule,
  numImports: number,
  sigs: FuncSigInfo,
  boxNumberIdx: number | null,
  unboxNumberIdx: number | null,
): number {
  let fixups = 0;

  // Process nested blocks recursively first
  for (const instr of body) {
    if (instr.op === "if") {
      const ifInstr = instr as any;
      if (ifInstr.then)
        fixups += fixCallArgTypesInBody(
          ifInstr.then,
          localTypes,
          globalTypes,
          types,
          mod,
          numImports,
          sigs,
          boxNumberIdx,
          unboxNumberIdx,
        );
      if (ifInstr.else)
        fixups += fixCallArgTypesInBody(
          ifInstr.else,
          localTypes,
          globalTypes,
          types,
          mod,
          numImports,
          sigs,
          boxNumberIdx,
          unboxNumberIdx,
        );
    } else if (instr.op === "block" || instr.op === "loop" || instr.op === "try_table") {
      const blockInstr = instr as any;
      if (blockInstr.body)
        fixups += fixCallArgTypesInBody(
          blockInstr.body,
          localTypes,
          globalTypes,
          types,
          mod,
          numImports,
          sigs,
          boxNumberIdx,
          unboxNumberIdx,
        );
    } else if (instr.op === "try") {
      const tryInstr = instr as any;
      if (tryInstr.body)
        fixups += fixCallArgTypesInBody(
          tryInstr.body,
          localTypes,
          globalTypes,
          types,
          mod,
          numImports,
          sigs,
          boxNumberIdx,
          unboxNumberIdx,
        );
      if (tryInstr.catches) {
        for (const c of tryInstr.catches) {
          if (c.body)
            fixups += fixCallArgTypesInBody(
              c.body,
              localTypes,
              globalTypes,
              types,
              mod,
              numImports,
              sigs,
              boxNumberIdx,
              unboxNumberIdx,
            );
        }
      }
      if (tryInstr.catchAll)
        fixups += fixCallArgTypesInBody(
          tryInstr.catchAll,
          localTypes,
          globalTypes,
          types,
          mod,
          numImports,
          sigs,
          boxNumberIdx,
          unboxNumberIdx,
        );
    }
  }

  // Fix call argument type mismatches.
  // Conservative approach: only fix SIMPLE patterns where a value-producing
  // instruction directly precedes the call instruction and produces a type
  // that doesn't match. We walk backward through instructions, tracking
  // stack depth, and only insert coercions for simple value producers
  // (local.get, global.get, struct.new, ref.null, local.tee, call).
  // Complex cases (nested blocks, if expressions) are skipped to avoid
  // breaking stack balance.

  for (let ci = 0; ci < body.length; ci++) {
    const callInstr = body[ci]!;
    const isCall = callInstr.op === "call" || callInstr.op === "return_call";
    const isCallRef = callInstr.op === "call_ref";
    if (!isCall && !isCallRef) continue;

    let expectedParams: ValType[] | null;
    if (isCallRef) {
      // call_ref uses a type index to determine the signature
      const typeIdx = (callInstr as any).typeIdx as number;
      const ft = resolveFuncType(types, typeIdx);
      expectedParams = ft ? ft.params : null;
    } else {
      const funcIdx = (callInstr as any).funcIdx as number;
      expectedParams = getFullParamTypes(mod, funcIdx, numImports);
    }
    if (!expectedParams || expectedParams.length === 0) continue;

    const paramCount = expectedParams.length;
    // For call_ref, the funcref is on top of the params stack — skip it
    let argOffset = isCallRef ? -1 : 0;
    let pos = ci - 1;
    const insertions: Array<{ afterPos: number; instrs: Instr[] }> = [];
    // Track insert positions already queued, so a chain of delta-0 producers
    // feeding a single call argument (e.g. `local.get; any.convert_extern;
    // ref.cast; struct.get` for a native-Error `.name` read) does not queue
    // the SAME externref→GC-ref coercion once per link. Without this, the
    // backward walk re-coerces the one value 4× and the 2nd `any.convert_extern`
    // receives an already-cast `(ref null $AnyString)` operand → invalid Wasm
    // (#1797). The forward pass-through scan (below) collapses each chain to a
    // single `insertPos`, so deduping by that position is exact.
    const queuedInsertPositions = new Set<number>();
    // Track whether we've traversed through a sub-expression consumer.
    // When this is true, the backward walk's argOffset may conflate
    // sub-expression inputs with call arguments, so we restrict coercions
    // to only the proven-safe ref→externref pattern.
    let inSubExpr = false;

    while (pos >= 0 && argOffset < paramCount) {
      const instr = body[pos]!;
      const op = instr.op;

      // Stop at control flow boundaries — don't try to trace through
      // blocks, ifs, loops, or try statements
      if (
        op === "if" ||
        op === "block" ||
        op === "loop" ||
        op === "try" ||
        op === "try_table" ||
        op === "end" ||
        op === "br" ||
        op === "br_if" ||
        op === "br_table" ||
        op === "return" ||
        op === "throw" ||
        op === "unreachable" ||
        op === "return_call" ||
        op === "return_call_ref"
      ) {
        break;
      }

      const delta = instrDelta(instr, types, sigs);
      if (delta === UNREACHABLE) break;

      // Determine if this instruction produces a value we can coerce.
      // "simple producers" with delta >= 1 are the straightforward case.
      // But ops like i32.xor (pop 2, push 1, net -1) also produce a value
      // that becomes a call argument — we handle those too.
      const producesValue =
        SIMPLE_PRODUCERS.has(op) && inferInstrType(instr, localTypes, globalTypes, types, mod, numImports) !== null;

      if (producesValue && argOffset >= 0) {
        // Check if there are pass-through transformers between this
        // instruction and the call/next producer.
        let effectiveType = inferInstrType(instr, localTypes, globalTypes, types, mod, numImports);
        let insertPos = pos;

        for (let t = pos + 1; t < ci; t++) {
          const tInstr = body[t]!;
          const tDelta = instrDelta(tInstr, types, sigs);
          if (tDelta !== 0) break;
          const tType = inferInstrType(tInstr, localTypes, globalTypes, types, mod, numImports);
          if (tType) effectiveType = tType;
          insertPos = t;
        }

        const paramIdx = paramCount - 1 - argOffset;
        const expectedType = expectedParams[paramIdx]!;

        if (effectiveType && expectedType) {
          const coercion = callArgCoercionInstrs(effectiveType, expectedType, boxNumberIdx, unboxNumberIdx);
          if (coercion.length > 0) {
            // When inSubExpr is true, the backward walk has traversed past
            // an intermediate call — the producer is an argument to that
            // intermediate call, NOT the target call. Applying coercion here
            // would corrupt the intermediate call's arguments.
            // Previously, ref→externref (extern.convert_any) was exempted as
            // "safe", but this is wrong when the intermediate call expects a
            // GC ref type, not externref (#963).
            if (!inSubExpr && !queuedInsertPositions.has(insertPos)) {
              queuedInsertPositions.add(insertPos);
              insertions.push({ afterPos: insertPos, instrs: coercion });
            }
          }
        }
      }

      // Update argOffset and sub-expression tracking
      if (delta >= 1) {
        argOffset += delta;
      } else if (delta < 0) {
        // For ops that produce a value (like i32.xor: pop 2, push 1),
        // count 1 toward arguments, then account for consumed inputs
        if (producesValue) {
          argOffset += 1; // the produced value is a call argument
          // The remaining -(delta - (-1)) = delta + 1 consumed values
          // come from the stack (sub-expression inputs)
          if (delta < -1) {
            // This is wrong — delta already accounts for net.
            // For pop 2 push 1: delta = -1. We counted +1 for the arg,
            // so we need to also go -2 for consumed inputs = net -1.
            // But argOffset += delta already does net, and we added +1 for
            // the arg. So: argOffset += 1 + delta = 1 + (-1) = 0 for i32.xor.
            // Wait, that's wrong too. Let me think again...
            //
            // Actually: the op contributes 1 value to args (already counted)
            // and consumes (1-delta) inputs from the stack below.
            // For i32.xor: consumes 2 from below, net delta = -1.
            // We want argOffset to go back by 2 (consumed inputs reduce
            // what's available for further call args).
            // argOffset += delta works for non-producing ops.
            // For producing ops: argOffset += 1 (arg) + delta_consumed
            // where delta_consumed = -(consumed) = delta - 1 (since delta = push - pop)
            // So: argOffset += 1 + (delta - 1) = delta. Same as before!
          }
          // Actually argOffset += delta already gives the right net effect:
          // it accounts for 1 push and N pops. We already handled the push
          // (coercion check above), so we just need the net:
          argOffset += delta - 1; // subtract the 1 we already accounted for
        } else {
          argOffset += delta;
        }
        inSubExpr = true;
        if (argOffset < (isCallRef ? -1 : 0)) break;
      }
      // delta === 0: pass-through (ref.as_non_null, extern.convert_any, etc.)
      pos--;
    }

    // (#3910) Apply HIGHEST position first — any other order shifts the
    // not-yet-applied ones. The old loop drained back-to-front under "reverse
    // order (so positions don't shift)", which assumed an ASCENDING build order;
    // the producer scan above walks BACKWARD, so back-to-front WAS ascending and
    // every call with 2+ mismatched args stacked its 2nd coercion on the 1st arg.
    // Trace: plan/issues/3910-regex-plus-string-constants-global-get.md.
    if (insertions.length > 0) {
      insertions.sort((a, b) => b.afterPos - a.afterPos);
      for (const { afterPos, instrs } of insertions) {
        body.splice(afterPos + 1, 0, ...instrs);
        recordFixup("call-arg-coerce", `coerced a call argument (${instrs.length} instr(s))`); // #1918
        ci += instrs.length;
        fixups += instrs.length;
      }
    }
  }

  // struct.new field coercion is handled by fixStructNewFieldCoercion
  // (forward type-stack simulation), called separately from stackBalance.

  return fixups;
}

/**
 * Forward type-stack simulation for struct.new field coercion.
 *
 * Walks the instruction stream forward, maintaining a type stack.
 * When a struct.new is encountered, compares the actual types on the
 * stack with the expected field types. If coercion is needed, saves
 * all field values to temp locals, applies coercions, and re-pushes.
 *
 * This replaces the fragile backward walk which miscalculated positions
 * for compound instructions (if/block/loop/try).
 */
function fixStructNewFieldCoercion(
  func: WasmFunction,
  types: TypeDef[],
  mod: WasmModule,
  numImports: number,
  sigs: FuncSigInfo,
  localTypes: ValType[],
  globalTypes: ValType[],
  boxNumberIdx: number | null,
  unboxNumberIdx: number | null,
): number {
  let fixups = 0;

  function processBody(body: Instr[]): void {
    // First recurse into nested blocks
    for (const instr of body) {
      if (instr.op === "if") {
        const ifInstr = instr as any;
        if (ifInstr.then) processBody(ifInstr.then);
        if (ifInstr.else) processBody(ifInstr.else);
      } else if (instr.op === "block" || instr.op === "loop" || instr.op === "try_table") {
        const blockInstr = instr as any;
        if (blockInstr.body) processBody(blockInstr.body);
      } else if (instr.op === "try") {
        const tryInstr = instr as any;
        if (tryInstr.body) processBody(tryInstr.body);
        if (tryInstr.catches) {
          for (const c of tryInstr.catches) {
            if (c.body) processBody(c.body);
          }
        }
        if (tryInstr.catchAll) processBody(tryInstr.catchAll);
      }
    }

    // Forward type-stack simulation
    const typeStack: (ValType | null)[] = []; // null = unknown type

    for (let ci = 0; ci < body.length; ci++) {
      const instr = body[ci]!;
      const op = instr.op;

      if (op === "struct.new") {
        const typeIdx = (instr as any).typeIdx as number;
        const typeDef = types[typeIdx];
        if (typeDef?.kind === "struct") {
          const fields = typeDef.fields as Array<{ type: ValType }>;
          const numFields = fields.length;

          if (numFields > 0 && typeStack.length >= numFields) {
            // Check if any field needs coercion
            const fieldTypes: (ValType | null)[] = [];
            for (let fi = 0; fi < numFields; fi++) {
              fieldTypes.push(typeStack[typeStack.length - numFields + fi] ?? null);
            }

            let needsCoercion = false;
            const coercions: Instr[][] = [];
            for (let fi = 0; fi < numFields; fi++) {
              const actual = fieldTypes[fi];
              const expected = fields[fi]!.type;
              if (actual) {
                const c = callArgCoercionInstrs(actual, expected, boxNumberIdx, unboxNumberIdx);
                coercions.push(c);
                if (c.length > 0) needsCoercion = true;
              } else {
                coercions.push([]);
              }
            }

            if (needsCoercion) {
              // Save all N field values to temp locals, coerce, re-push.
              // Allocate temp locals with actual types from the stack.
              const tempLocals: number[] = [];
              const paramCount = resolveFuncType(types, func.typeIdx)?.params.length ?? 0;
              for (let fi = 0; fi < numFields; fi++) {
                // Widen defensively: the declared-field-type fallback can be a
                // packed i8/i16, which is invalid as a local type (#2934).
                const actualType = widenPackedToI32(fieldTypes[fi] ?? fields[fi]!.type);
                const localIdx = paramCount + func.locals.length;
                func.locals.push({ name: `$sn_tmp_${localIdx}`, type: actualType });
                // Update localTypes for future inference
                localTypes.push(actualType);
                tempLocals.push(localIdx);
              }

              // Build the replacement instructions:
              // 1. Save top N values to temps (reverse order: last field = top of stack saved first)
              const saveInstrs: Instr[] = [];
              for (let fi = numFields - 1; fi >= 0; fi--) {
                saveInstrs.push({ op: "local.set", index: tempLocals[fi]! });
              }
              // 2. Re-push each value with coercion
              const restoreInstrs: Instr[] = [];
              for (let fi = 0; fi < numFields; fi++) {
                restoreInstrs.push({ op: "local.get", index: tempLocals[fi]! });
                for (const c of coercions[fi]!) {
                  restoreInstrs.push(c);
                }
              }

              // Insert save+restore before the struct.new
              const insertedInstrs = [...saveInstrs, ...restoreInstrs];
              body.splice(ci, 0, ...insertedInstrs);
              recordFixup("struct-field-coerce", `coerced ${numFields} struct.new field value(s)`); // #1918
              ci += insertedInstrs.length; // skip past inserted + struct.new
              fixups += insertedInstrs.length;
            }
          }

          // Pop N values from type stack, push 1 ref
          for (let i = 0; i < (typeDef.fields as any[]).length; i++) typeStack.pop();
          typeStack.push({ kind: "ref", typeIdx } as ValType);
        }
        continue;
      }

      // Update type stack for other instructions
      updateTypeStack(typeStack, instr, types, sigs, localTypes, globalTypes, mod, numImports);
    }
  }

  processBody(func.body);
  return fixups;
}

/**
 * Update the type stack for a single instruction (forward simulation).
 * Pushes/pops type entries based on the instruction's semantics.
 * Pushes null for unknown types.
 */
function updateTypeStack(
  stack: (ValType | null)[],
  instr: Instr,
  types: TypeDef[],
  sigs: FuncSigInfo,
  localTypes: ValType[],
  globalTypes: ValType[],
  mod: WasmModule,
  numImports: number,
): void {
  const op = instr.op;

  // Terminators: clear the stack (unreachable code follows)
  if (
    op === "return" ||
    op === "return_call" ||
    op === "return_call_ref" ||
    op === "br" ||
    op === "throw" ||
    op === "rethrow" ||
    op === "unreachable"
  ) {
    stack.length = 0;
    return;
  }

  // Push-only: push 1 value, consume 0
  if (op === "local.get") {
    const idx = (instr as any).index as number;
    stack.push(localTypes[idx] ?? null);
    return;
  }
  if (op === "global.get") {
    const idx = (instr as any).index as number;
    stack.push(globalTypes[idx] ?? null);
    return;
  }
  if (op === "f64.const") {
    stack.push({ kind: "f64" });
    return;
  }
  if (op === "f32.const") {
    stack.push({ kind: "f32" } as ValType);
    return;
  }
  if (op === "i32.const") {
    stack.push({ kind: "i32" });
    return;
  }
  if (op === "i64.const") {
    stack.push({ kind: "i64" });
    return;
  }
  if (op === "ref.null") {
    const typeIdx = (instr as any).typeIdx as number;
    stack.push({ kind: "ref_null", typeIdx } as ValType);
    return;
  }
  if (op === "ref.null.extern") {
    stack.push({ kind: "externref" } as ValType);
    return;
  }
  if (op === "ref.null.eq") {
    stack.push({ kind: "eqref" } as ValType);
    return;
  }
  if (op === "ref.null.func") {
    stack.push({ kind: "funcref" } as ValType);
    return;
  }
  if (op === "ref.func") {
    stack.push({ kind: "funcref" } as ValType);
    return;
  }
  if (op === "v128.const") {
    stack.push(null);
    return;
  } // v128 type, push unknown
  if (op === "memory.size") {
    stack.push({ kind: "i32" });
    return;
  }

  // Pop 1, push 0
  if (op === "drop" || op === "local.set" || op === "global.set") {
    stack.pop();
    return;
  }

  // Pop 1, push 1 (type-changing or type-preserving)
  if (op === "local.tee") {
    // NOT a pass-through: wasm types a tee's result as the LOCAL's declared
    // type (it is set-then-get), which may be a SUPERTYPE of the value that
    // went in — storing a $NativeString through an $AnyString-typed local
    // re-reads as $AnyString. Keeping the incoming type here made the
    // struct.new fixup type its save-temp too narrowly and emit a local.set
    // the engine rejects (acorn UMD, __closure_0:
    // "local.set[0] expected (ref null 7), found local.tee of (ref null 6)").
    const idx = (instr as any).index as number;
    stack.pop();
    stack.push(localTypes[idx] ?? null);
    return;
  }
  if (op === "extern.convert_any") {
    stack.pop();
    stack.push({ kind: "externref" } as ValType);
    return;
  }
  if (op === "any.convert_extern") {
    stack.pop();
    stack.push({ kind: "anyref" } as ValType);
    return;
  }
  if (op === "ref.cast" || op === "ref.as_non_null") {
    stack.pop();
    const typeIdx = (instr as any).typeIdx as number;
    if (typeIdx !== undefined) {
      stack.push({ kind: "ref", typeIdx } as ValType);
    } else {
      stack.push(null);
    }
    return;
  }
  if (op === "ref.cast_null") {
    stack.pop();
    const typeIdx = (instr as any).typeIdx as number;
    stack.push({ kind: "ref_null", typeIdx } as ValType);
    return;
  }
  if (
    op === "ref.is_null" ||
    op === "ref.test" ||
    op === "i32.eqz" ||
    op === "i32.clz" ||
    op === "i32.wrap_i64" ||
    op === "i32.trunc_sat_f64_s" ||
    op === "i32.trunc_sat_f64_u" ||
    op === "i32.trunc_f64_s" ||
    op === "array.len"
  ) {
    stack.pop();
    stack.push({ kind: "i32" });
    return;
  }
  if (
    op === "f64.neg" ||
    op === "f64.abs" ||
    op === "f64.floor" ||
    op === "f64.ceil" ||
    op === "f64.trunc" ||
    op === "f64.nearest" ||
    op === "f64.sqrt" ||
    op === "f64.convert_i32_s" ||
    op === "f64.convert_i32_u" ||
    op === "f64.convert_i64_s" ||
    op === "f64.promote_f32" ||
    op === "f64.reinterpret_i64"
  ) {
    stack.pop();
    stack.push({ kind: "f64" });
    return;
  }
  if (op === "f32.demote_f64") {
    stack.pop();
    stack.push({ kind: "f32" } as ValType);
    return;
  }
  if (
    op === "i64.extend_i32_s" ||
    op === "i64.extend_i32_u" ||
    op === "i64.trunc_sat_f64_s" ||
    op === "i64.trunc_f64_s" ||
    op === "i64.reinterpret_f64"
  ) {
    stack.pop();
    stack.push({ kind: "i64" });
    return;
  }

  // Pop 2, push 1
  if (
    op === "i32.add" ||
    op === "i32.sub" ||
    op === "i32.mul" ||
    op === "i32.div_s" ||
    op === "i32.div_u" ||
    op === "i32.rem_s" ||
    op === "i32.rem_u" ||
    op === "i32.and" ||
    op === "i32.or" ||
    op === "i32.xor" ||
    op === "i32.shl" ||
    op === "i32.shr_s" ||
    op === "i32.shr_u" ||
    op === "i32.eq" ||
    op === "i32.ne" ||
    op === "i32.lt_s" ||
    op === "i32.le_s" ||
    op === "i32.gt_s" ||
    op === "i32.ge_s" ||
    op === "i32.lt_u" ||
    op === "i32.le_u" ||
    op === "i32.gt_u" ||
    op === "i32.ge_u" ||
    op === "ref.eq" ||
    op === "f64.eq" ||
    op === "f64.ne" ||
    op === "f64.lt" ||
    op === "f64.le" ||
    op === "f64.gt" ||
    op === "f64.ge" ||
    op === "i64.eq" ||
    op === "i64.ne"
  ) {
    stack.pop();
    stack.pop();
    stack.push({ kind: "i32" });
    return;
  }
  if (
    op === "i64.add" ||
    op === "i64.sub" ||
    op === "i64.mul" ||
    op === "i64.div_s" ||
    op === "i64.rem_s" ||
    op === "i64.and" ||
    op === "i64.or" ||
    op === "i64.xor" ||
    op === "i64.shl" ||
    op === "i64.shr_s" ||
    op === "i64.shr_u" ||
    op === "i64.lt_s" ||
    op === "i64.le_s" ||
    op === "i64.gt_s" ||
    op === "i64.ge_s"
  ) {
    stack.pop();
    stack.pop();
    stack.push({ kind: "i64" });
    return;
  }
  if (
    op === "f64.add" ||
    op === "f64.sub" ||
    op === "f64.mul" ||
    op === "f64.div" ||
    op === "f64.copysign" ||
    op === "f64.min" ||
    op === "f64.max"
  ) {
    stack.pop();
    stack.pop();
    stack.push({ kind: "f64" });
    return;
  }

  // select: pop 3, push 1 (type of first operand)
  if (op === "select") {
    stack.pop(); // condition
    stack.pop(); // val2
    const val1 = stack.pop() ?? null;
    stack.push(val1);
    return;
  }

  // struct.get: pop 1 (struct ref), push 1 (field type)
  if (op === "struct.get") {
    stack.pop();
    const typeIdx = (instr as any).typeIdx as number;
    const fieldIdx = (instr as any).fieldIdx as number;
    const td = types[typeIdx];
    if (td?.kind === "struct" && (td as any).fields[fieldIdx]) {
      // Packed i8/i16 fields arrive on the stack widened to i32 (#2934).
      stack.push(widenPackedToI32((td as any).fields[fieldIdx].type));
    } else {
      stack.push(null);
    }
    return;
  }

  // struct.set: pop 2 (struct ref + value), push 0
  if (op === "struct.set") {
    stack.pop();
    stack.pop();
    return;
  }

  // array.get/get_s/get_u: pop 2 (array + index), push 1 (element type)
  if (op === "array.get" || op === "array.get_s" || op === "array.get_u") {
    stack.pop();
    stack.pop();
    const typeIdx = (instr as any).typeIdx as number;
    const td = types[typeIdx];
    if (td?.kind === "array") {
      // Packed i8/i16 elements arrive on the stack widened to i32 (#2934).
      stack.push(widenPackedToI32(td.element));
    } else {
      stack.push(null);
    }
    return;
  }

  // array.set: pop 3
  if (op === "array.set") {
    stack.pop();
    stack.pop();
    stack.pop();
    return;
  }

  // array.new: pop 2, push 1
  if (op === "array.new") {
    stack.pop();
    stack.pop();
    const typeIdx = (instr as any).typeIdx as number;
    stack.push({ kind: "ref", typeIdx } as ValType);
    return;
  }

  // array.new_default: pop 1, push 1
  if (op === "array.new_default") {
    stack.pop();
    const typeIdx = (instr as any).typeIdx as number;
    stack.push({ kind: "ref", typeIdx } as ValType);
    return;
  }

  // array.new_fixed: pop N, push 1
  if (op === "array.new_fixed") {
    const len = (instr as any).length || 0;
    for (let i = 0; i < len; i++) stack.pop();
    const typeIdx = (instr as any).typeIdx as number;
    stack.push({ kind: "ref", typeIdx } as ValType);
    return;
  }

  // array.copy: pop 5, array.fill: pop 4
  if (op === "array.copy") {
    for (let i = 0; i < 5; i++) stack.pop();
    return;
  }
  if (op === "array.fill") {
    for (let i = 0; i < 4; i++) stack.pop();
    return;
  }

  // call: pop params, push results
  if (op === "call") {
    const funcIdx = absoluteFuncIndexCached(mod, numImports, (instr as any).funcIdx as number); // (#1916 S3)
    const sig = sigs.get(funcIdx);
    if (sig) {
      for (let i = 0; i < sig.params; i++) stack.pop();
      if (sig.results > 0) {
        // Try to get actual result type from function signature
        const fIdx = funcIdx - numImports;
        const fn = fIdx >= 0 ? mod.functions[fIdx] : undefined;
        const ft = fn ? resolveFuncType(types, fn.typeIdx) : null;
        if (ft && ft.results.length > 0) {
          for (const r of ft.results) stack.push(r);
        } else {
          // Check import function signatures
          let importFuncIdx = 0;
          let foundImport = false;
          for (const imp of mod.imports) {
            if (imp.desc.kind === "func") {
              if (importFuncIdx === funcIdx) {
                const impFt = resolveFuncType(types, imp.desc.typeIdx);
                if (impFt && impFt.results.length > 0) {
                  for (const r of impFt.results) stack.push(r);
                  foundImport = true;
                }
                break;
              }
              importFuncIdx++;
            }
          }
          if (!foundImport) {
            for (let i = 0; i < sig.results; i++) stack.push(null);
          }
        }
      }
    } else {
      stack.push(null); // unknown
    }
    return;
  }

  // call_ref: pop params + funcref, push results
  if (op === "call_ref") {
    const typeIdx = (instr as any).typeIdx as number;
    const ft = resolveFuncType(types, typeIdx);
    if (ft) {
      stack.pop(); // funcref
      for (let i = 0; i < ft.params.length; i++) stack.pop();
      for (const r of ft.results) stack.push(r);
    } else {
      stack.push(null);
    }
    return;
  }

  // br_if: pop 1 (condition)
  if (op === "br_if") {
    stack.pop();
    return;
  }

  // Structured blocks: external effect based on blockType
  if (op === "if" || op === "block" || op === "loop" || op === "try" || op === "try_table") {
    const bt = (instr as any).blockType as BlockType | undefined;
    if (op === "if") stack.pop(); // condition

    // Process nested bodies recursively (already done above in processBody)
    // For the type stack, just account for the block's net result
    if (!bt || bt.kind === "empty") {
      // no result
    } else if (bt.kind === "val") {
      stack.push(bt.type);
    } else if (bt.kind === "type") {
      const ft = resolveFuncType(types, bt.typeIdx);
      if (ft) {
        for (let i = 0; i < ft.params.length; i++) stack.pop();
        for (const r of ft.results) stack.push(r);
      } else {
        stack.push(null);
      }
    }
    return;
  }

  // For all other instructions, use instrDelta and push null for unknown types
  const delta = instrDelta(instr, types, sigs);
  if (delta === UNREACHABLE) {
    stack.length = 0;
    return;
  }
  if (delta < 0) {
    for (let i = 0; i < -delta; i++) stack.pop();
  } else if (delta > 0) {
    for (let i = 0; i < delta; i++) stack.push(null);
  }
  // delta === 0: pass-through, no stack change
}

export function stackBalance(mod: WasmModule): number {
  const sigs = buildFuncSigs(mod);
  const tags = mod.tags || [];
  let totalFixups = 0;

  // #2090 — reset the invented-value collector for this run.
  inventedValueSites = [];
  // #1918 — reset the fixup-telemetry collector for this run.
  fixupEvents = [];

  // Count import functions.
  let numImports = 0;
  for (const imp of mod.imports) {
    if (imp.desc.kind === "func") numImports++;
  }
  // (#2140) Resolve the box/unbox helper indices. The helpers may be env
  // imports (JS-host lane) OR DEFINED functions (standalone/WASI — the
  // Wasm-native UNION helpers, see late-imports.ts). The previous import-only
  // scan left them null in the host-less lane, so every coercionPlan
  // box/unbox row silently degraded to its fall-through (no coerce) or lossy
  // arm exactly where no host could absorb the damage. Imports win on the
  // impossible-in-practice duplicate; defined idx = numImports + position.
  // (Single name-literal per helper — the #2108 drift gate counts quoted
  // coercion-vocabulary occurrences per file.)
  const findFuncByName = (helperName: string): number | null => {
    let importIdx = 0;
    for (const imp of mod.imports) {
      if (imp.desc.kind === "func") {
        if (imp.name === helperName) return importIdx;
        importIdx++;
      }
    }
    for (let i = 0; i < mod.functions.length; i++) {
      if (mod.functions[i]!.name === helperName) return numImports + i;
    }
    return null;
  };
  const boxNumberIdx: number | null = findFuncByName("__box_number");
  const unboxNumberIdx: number | null = findFuncByName("__unbox_number");

  // Build global types array
  const globalTypes: ValType[] = [];
  for (const imp of mod.imports) {
    if (imp.desc.kind === "global") {
      globalTypes.push(imp.desc.type);
    }
  }
  for (const g of mod.globals) {
    globalTypes.push(g.type);
  }

  for (let fi = 0; fi < mod.functions.length; fi++) {
    const func = mod.functions[fi]!;
    // #2090 — attribute any invented-value site to this function in diagnostics.
    currentDiagFunc = func.name || `func#${numImports + fi}`;
    // Build local types array (params + locals)
    const ft = resolveFuncType(mod.types, func.typeIdx);
    const localTypes: ValType[] = [];
    if (ft) {
      for (const p of ft.params) localTypes.push(p);
    }
    for (const l of func.locals) localTypes.push(l.type);

    // Eliminate dead code after terminators (throw/return/br/unreachable)
    // V8 tracks stack values even in unreachable code, so dead code that pushes
    // values causes "expected N elements on the stack for fallthru" errors.
    eliminateDeadCode(func.body);

    // Fix local.set type mismatches (e.g., f64 → externref, ref → externref)
    totalFixups += fixLocalSetCoercion(
      func.body,
      localTypes,
      globalTypes,
      mod.types,
      mod,
      numImports,
      sigs,
      boxNumberIdx,
      unboxNumberIdx,
    );

    // Fix call argument type mismatches before other fixups
    totalFixups += fixCallArgTypesInBody(
      func.body,
      localTypes,
      globalTypes,
      mod.types,
      mod,
      numImports,
      sigs,
      boxNumberIdx,
      unboxNumberIdx,
    );

    // Fix struct.new field type mismatches (forward type-stack simulation)
    totalFixups += fixStructNewFieldCoercion(
      func,
      mod.types,
      mod,
      numImports,
      sigs,
      localTypes,
      globalTypes,
      boxNumberIdx,
      unboxNumberIdx,
    );

    // Fix nested structured blocks
    totalFixups += fixBody(func.body, mod.types, sigs, tags, boxNumberIdx, unboxNumberIdx);

    // Fix function-level body: the body must produce exactly as many values
    // as the function's result type declares.
    if (ft) {
      const expectedResults = ft.results.length;
      // Build a synthetic block type for the function body
      const funcBlockType: BlockType =
        expectedResults === 0
          ? { kind: "empty" }
          : expectedResults === 1
            ? { kind: "val", type: ft.results[0]! }
            : { kind: "type", typeIdx: func.typeIdx };
      totalFixups += fixBranch(
        func.body,
        expectedResults,
        mod.types,
        sigs,
        funcBlockType,
        boxNumberIdx,
        unboxNumberIdx,
      );
    }
    assertLocalRefsInRange(func, ft, "exit");
  }

  // #2090 — drain the invented-value collector into structured compile errors.
  // Any entry means the repair pass hit a missing slot of unrecoverable type:
  // a real producing-codegen bug that must NOT ship as a silent null. We fail
  // the compile here instead. Report 04 §5 Phase 1 concluded there is no
  // legitimate trigger, so in practice this list is empty for every module the
  // equivalence suite + playground examples compile.
  if (inventedValueSites.length > 0) {
    if (!mod.codegenErrors) mod.codegenErrors = [];
    for (const site of inventedValueSites) {
      mod.codegenErrors.push({
        message:
          `stack-balance (#2090): cannot supply a missing stack value in function "${site.func}" — ` +
          `${site.detail}. The repair pass refuses to invent a value here because doing so would ` +
          `mask a producing codegen bug as a silent null. This is a compiler defect at the value ` +
          `producer; report the failing input.`,
        line: 0,
        column: 0,
      });
    }
    inventedValueSites = [];
  }

  return totalFixups;
}

/**
 * Return whether a reference stack value is already assignable to a local via
 * Wasm GC's declared struct-subtype relation.
 *
 * `closure.new` produces the concrete closure struct while IR locals use the
 * shared closure root. A concrete non-null closure is valid in that wider
 * local without a cast; treating the different type indices as a mismatch
 * makes stack-balance report (and insert) a false `local-set-coerce` repair.
 */
function isDeclaredRefSubtypeAssignable(actual: ValType, expected: ValType, types: TypeDef[]): boolean {
  if (actual.kind !== "ref" && actual.kind !== "ref_null") return false;
  if (expected.kind !== "ref" && expected.kind !== "ref_null") return false;

  // A nullable value cannot flow into a non-null local without a check.
  if (actual.kind === "ref_null" && expected.kind === "ref") return false;

  let current = actual.typeIdx;
  for (let depth = 0; depth < 64; depth++) {
    if (current === expected.typeIdx) return true;
    const def = types[current];
    if (!def || def.kind !== "struct") return false;
    const parent = def.superTypeIdx;
    if (parent === undefined || parent < 0) return false;
    current = parent;
  }
  return false;
}

/**
 * Fix local.set type mismatches in a function body.
 *
 * Walks the instruction stream looking for local.set/local.tee instructions.
 * For each one, infers the type of the value on the stack (by looking at
 * the preceding instruction) and compares it with the local's declared type.
 * If they don't match, inserts coercion instructions.
 *
 * This catches cases where the codegen emits bare local.set without
 * emitCoercedLocalSet (e.g., in destructuring, closures, for-of).
 */
function fixLocalSetCoercion(
  body: Instr[],
  localTypes: ValType[],
  globalTypes: ValType[],
  types: TypeDef[],
  mod: WasmModule,
  numImports: number,
  sigs: FuncSigInfo,
  boxNumberIdx: number | null,
  unboxNumberIdx: number | null,
): number {
  let fixups = 0;

  // Recurse into nested blocks first
  for (const instr of body) {
    if (instr.op === "if") {
      const ifInstr = instr as any;
      if (ifInstr.then)
        fixups += fixLocalSetCoercion(
          ifInstr.then,
          localTypes,
          globalTypes,
          types,
          mod,
          numImports,
          sigs,
          boxNumberIdx,
          unboxNumberIdx,
        );
      if (ifInstr.else)
        fixups += fixLocalSetCoercion(
          ifInstr.else,
          localTypes,
          globalTypes,
          types,
          mod,
          numImports,
          sigs,
          boxNumberIdx,
          unboxNumberIdx,
        );
    } else if (instr.op === "block" || instr.op === "loop" || instr.op === "try_table") {
      const blockInstr = instr as any;
      if (blockInstr.body)
        fixups += fixLocalSetCoercion(
          blockInstr.body,
          localTypes,
          globalTypes,
          types,
          mod,
          numImports,
          sigs,
          boxNumberIdx,
          unboxNumberIdx,
        );
    } else if (instr.op === "try") {
      const tryInstr = instr as any;
      if (tryInstr.body)
        fixups += fixLocalSetCoercion(
          tryInstr.body,
          localTypes,
          globalTypes,
          types,
          mod,
          numImports,
          sigs,
          boxNumberIdx,
          unboxNumberIdx,
        );
      if (tryInstr.catches) {
        for (const c of tryInstr.catches) {
          if (c.body)
            fixups += fixLocalSetCoercion(
              c.body,
              localTypes,
              globalTypes,
              types,
              mod,
              numImports,
              sigs,
              boxNumberIdx,
              unboxNumberIdx,
            );
        }
      }
      if (tryInstr.catchAll)
        fixups += fixLocalSetCoercion(
          tryInstr.catchAll,
          localTypes,
          globalTypes,
          types,
          mod,
          numImports,
          sigs,
          boxNumberIdx,
          unboxNumberIdx,
        );
    }
  }

  // Now fix local.set/local.tee mismatches in this body
  for (let i = 0; i < body.length; i++) {
    const instr = body[i]!;
    if (instr.op !== "local.set" && instr.op !== "local.tee") continue;

    const localIdx = (instr as any).index as number;
    const localType = localTypes[localIdx];
    if (!localType) continue;

    // Infer the type of the value on the stack by looking at the preceding instruction
    if (i === 0) continue;
    const prev = body[i - 1]!;
    const stackType = inferInstrType(prev, localTypes, globalTypes, types, mod, numImports);
    if (!stackType) continue;

    // A declared struct subtype is already valid in a wider ref local. In
    // particular, concrete closure structs flow into the canonical closure
    // root used by IR locals without needing a repair cast.
    if (isDeclaredRefSubtypeAssignable(stackType, localType, types)) continue;

    // Check if coercion is needed
    const coercion = callArgCoercionInstrs(stackType, localType, boxNumberIdx, unboxNumberIdx);
    if (coercion.length > 0) {
      // Insert coercion instructions before the local.set
      body.splice(i, 0, ...coercion);
      recordFixup("local-set-coerce", `coerced ${instr.op} value ${stackType.kind} → ${localType.kind}`); // #1918
      i += coercion.length;
      fixups += coercion.length;
    }
  }

  return fixups;
}
