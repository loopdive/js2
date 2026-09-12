// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// extern-arg-marshal.ts — the ONE place that marshals externref arguments into
// a compiled function's declared parameter types, and its result back.
//
// Extracted verbatim from `closed-method-dispatch.ts` (#5383 S2g) when a second
// finalize-time caller appeared: `standalone-class-construct.ts`'s per-class
// `construct` trampoline has exactly the same job as a method dispatcher's
// entry arm — take values that arrive as externref, hand them to a function
// whose formals are `f64`/`i32`/struct refs, box what comes back. Keeping one
// copy is what makes a fix to the #5380 omitted-argument sentinel (a defaulted
// `f64` formal must still run its default for a PRESENT-but-`undefined`
// argument) reach both callers instead of one.
//
// Behaviour is unchanged from the code this replaces; the extraction is
// byte-neutral (proved by a sha256 A/B over 6 modules × 2 targets in #5383's
// S2g notes).

import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";

/** Coerce helper funcIdxs, read once per fill pass (registered at reserve). */
export type CoerceIdxs = {
  boxNumIdx?: number;
  /** (#5241) `__box_boolean` — a boolean-returning method's `i32` result. */
  boxBoolIdx?: number;
  unboxNumIdx?: number;
  unboxBoolIdx?: number;
  undefinedIdx?: number;
  /**
   * (#5380) Lazy accessor for `__unbox_number_or_omitted` — see
   * {@link ensureUnboxNumberOrOmitted}. A THUNK, not an index: the helper is
   * minted only when an arm actually has a defaulted f64 formal, so a module
   * without one emits exactly the bytes it did before.
   */
  unboxNumOrOmitted?: () => number | undefined;
};

/**
 * (#5380) Mint (once) `__unbox_number_or_omitted(externref) -> f64`: the plain
 * numeric unbox, except that an explicit host `undefined` becomes the
 * omitted-argument sNaN sentinel the callee's parameter prologue recognises.
 *
 * `f(undefined)` must run `f`'s default (§10.2.11 / FunctionDeclarationInstan-
 * tiation), and an f64 formal has no other way to carry "absent": a plain
 * unboxing `undefined` numerically yields a quiet NaN, indistinguishable from a real
 * `NaN` argument. The MISSING-argument arm of `buildEntryArm` already pushes
 * this sentinel; this is the same value for an argument that is present but
 * undefined.
 *
 * A helper FUNCTION rather than inline instructions because the arm's argument
 * may be produced by `__extern_get_idx` — evaluating it twice (once to test,
 * once to unbox) would both cost and, for an accessor-backed element, observe
 * the read twice. Returns `undefined` when either primitive is unavailable, so
 * the caller keeps its previous bytes.
 */
function ensureUnboxNumberOrOmitted(ctx: CodegenContext, unboxIdx: number | undefined): number | undefined {
  const existing = ctx.funcMap.get("__unbox_number_or_omitted");
  if (existing !== undefined) return existing;
  const isUndefIdx = ctx.funcMap.get("__extern_is_undefined");
  if (unboxIdx === undefined || isUndefIdx === undefined) return undefined;
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }], "$__unbox_number_or_omitted_type");
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.mod.functions.push({
    name: "__unbox_number_or_omitted",
    typeIdx,
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: isUndefIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "f64" } },
        then: [{ op: "i64.const", value: 0x7ff00000deadc0den }, { op: "f64.reinterpret_i64" }],
        else: [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: unboxIdx },
        ],
      },
    ],
    exported: false,
  } as WasmFunction);
  ctx.funcMap.set("__unbox_number_or_omitted", funcIdx);
  return funcIdx;
}

/**
 * Read the coercion helper indices for a FILL pass.
 *
 * Exported so every finalize-time caller that marshals externref arguments into
 * a compiled function's declared parameter types reads the SAME set — the
 * alternative is a second hand-rolled unbox/box helper-index table
 * drifting away from this one.
 */
export function buildCoerceIdxs(ctx: CodegenContext): CoerceIdxs {
  const ci: CoerceIdxs = {
    boxNumIdx: ctx.funcMap.get("__box_number"),
    boxBoolIdx: ctx.funcMap.get("__box_boolean"),
    unboxNumIdx: ctx.funcMap.get("__unbox_number"),
    unboxBoolIdx: ctx.funcMap.get("__unbox_boolean"),
    undefinedIdx: ctx.funcMap.get("__get_undefined"),
    unboxNumOrOmitted: () => ensureUnboxNumberOrOmitted(ctx, ci.unboxNumIdx),
  };
  return ci;
}

/**
 * Coerce the externref value ALREADY ON THE STACK to the declared param type
 * `want`. `optionalHere` selects the #5380 sentinel-preserving unboxer for a
 * DEFAULTED f64 formal (a present-but-`undefined` argument must still run the
 * default), so a non-optional formal keeps its previous bytes exactly.
 */
export function externArgCoercionInstrs(ci: CoerceIdxs, want: ValType, optionalHere: boolean): Instr[] {
  const { unboxNumIdx, unboxBoolIdx } = ci;
  const out: Instr[] = [];
  if (want.kind === "f64") {
    const omittedAwareIdx = optionalHere ? ci.unboxNumOrOmitted?.() : undefined;
    if (omittedAwareIdx !== undefined) out.push({ op: "call", funcIdx: omittedAwareIdx });
    else if (unboxNumIdx !== undefined) out.push({ op: "call", funcIdx: unboxNumIdx });
    else out.push({ op: "drop" }, { op: "f64.const", value: 0 });
  } else if (want.kind === "i32") {
    if ((want as { boolean?: true }).boolean && unboxBoolIdx !== undefined) {
      out.push({ op: "call", funcIdx: unboxBoolIdx });
    } else if (unboxNumIdx !== undefined) {
      out.push({ op: "call", funcIdx: unboxNumIdx });
      out.push({ op: "i32.trunc_sat_f64_s" });
    } else {
      out.push({ op: "drop" }, { op: "i32.const", value: 0 });
    }
  } else if (want.kind === "ref" || want.kind === "ref_null") {
    out.push({ op: "any.convert_extern" });
    out.push({ op: "ref.cast", typeIdx: (want as { typeIdx: number }).typeIdx });
  }
  // externref param: already externref — no coercion.
  return out;
}

/** Box a call RESULT already on the stack back to externref. */
export function resultBoxingInstrs(ci: CoerceIdxs, resultType: ValType): Instr[] {
  const { boxNumIdx, boxBoolIdx } = ci;
  const out: Instr[] = [];
  if (resultType.kind === "ref" || resultType.kind === "ref_null") {
    out.push({ op: "extern.convert_any" });
  } else if (resultType.kind === "f64") {
    if (boxNumIdx !== undefined) out.push({ op: "call", funcIdx: boxNumIdx });
    else out.push({ op: "drop" }, { op: "ref.null.extern" });
  } else if (resultType.kind === "i32") {
    // (#5241) A BOOLEAN return also lowers to `i32`, and the ValType carries
    // the `boolean` marker the ARGUMENT coercion above already honours. Boxing
    // it as a number answered `1`/`0` where the same call on a TYPED receiver
    // answered `true`/`false` — measured on a plain class,
    // `String(inst.bigger(0))` → `"1"` through this dispatcher, `"true"`
    // direct. Pre-existing; it became reachable for more names once #5241
    // stopped the extern-class hijack from consuming those calls first.
    if ((resultType as { boolean?: true }).boolean && boxBoolIdx !== undefined) {
      out.push({ op: "call", funcIdx: boxBoolIdx });
    } else {
      out.push({ op: "f64.convert_i32_s" });
      if (boxNumIdx !== undefined) out.push({ op: "call", funcIdx: boxNumIdx });
      else out.push({ op: "drop" }, { op: "ref.null.extern" });
    }
  }
  // externref result: no coercion.
  return out;
}
