// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1917 Step 0 — single ValType coercion table.
 *
 * Four independently-maintained coercion matrices coexisted in the WasmGC
 * backend and **disagreed semantically** about the same `(from, to)` pair:
 *
 *   - `coercionInstrs`          (type-coercion.ts)   — ref→f64 = `drop; f64.const NaN`
 *   - `callArgCoercionInstrs`   (stack-balance.ts)   — externref→f64 = `__unbox_number`
 *   - `fixBranchType`           (stack-balance.ts)   — externref→f64 = LOSSY `drop; f64.const 0`
 *   - `coerceType`              (type-coercion.ts)   — the big ToPrimitive matrix (not Step 0)
 *
 * So the runtime value a coercion produced depended on *which syntactic context*
 * triggered it (call argument vs branch result vs local.set). Worst: the
 * stack-balancer's `fixBranchType` silently dropped the operand and pushed a
 * zero/null where the call-arg path correctly unboxed — turning a representation
 * fixup into a data-loss bug.
 *
 * This module is the single source of truth for the **scalar / numeric /
 * box-unbox** rows that those matrices share. It is a **pure** function over
 * `(from, to)` plus the box/unbox helper funcIdxs (the only context the
 * stack-balancer can supply post-hoc), returning the exact instruction
 * sequence. Each consumer delegates to it and keeps only the rows it owns that
 * need an `fctx` (guarded ref.cast temporaries) or `ctx` (AnyValue→extern
 * helper, late-import registration), which this table deliberately does NOT
 * cover (it returns `null` → caller falls through to its existing handling).
 *
 * Steps 1+ (the JS-semantic `emitToString`/`emitToPrimitive`/`emitStrictEq`/…
 * engine) build on top of this and land after value-rep P0 (#2072/#2080); see
 * plan/log/analysis-2026-06/03-coercion-engine-spec.md.
 */
import type { Instr, ValType } from "../ir/types.js";

/** Box/unbox helper funcIdxs the numeric box-unbox rows need (null = unavailable). */
export interface CoercionHelpers {
  boxNumberIdx: number | null;
  unboxNumberIdx: number | null;
}

export interface CoercionPlan {
  instrs: Instr[];
  /**
   * True when the sequence cannot preserve the value (drops it and pushes a
   * placeholder). A lossy plan in a branch/local fixup masks an upstream
   * emitter bug; #1918 will surface these as diagnostics. Today only the
   * genuine "no representation bridge exists" rows are lossy.
   */
  lossy?: boolean;
}

/** Normalize the sub-i32 storage kinds to i32 for coercion purposes. */
function normKind(k: ValType["kind"]): ValType["kind"] {
  return k === "i8" || k === "i16" ? "i32" : k;
}

function isExternKind(k: ValType["kind"]): boolean {
  return k === "externref" || k === "ref_extern";
}

/**
 * The canonical scalar / numeric / box-unbox coercion table.
 *
 * Returns the instruction sequence to convert a value of ValType `from` (top of
 * stack) to ValType `to`, or `null` when this pair is **not** a row this table
 * owns — i.e. it needs an `fctx` temporary (guarded ref.cast: externref/eqref/
 * anyref → ref/ref_null) or `ctx` (AnyValue→externref helper). Callers fall
 * back to their own handling for `null`.
 *
 * Same-kind pairs return `{ instrs: [] }` (no-op) so callers can treat a
 * non-null result as "handled".
 */
export function coercionPlan(from: ValType, to: ValType, helpers: CoercionHelpers): CoercionPlan | null {
  const fromK = normKind(from.kind);
  const toK = normKind(to.kind);
  const { boxNumberIdx, unboxNumberIdx } = helpers;

  // Same effective kind: no representation change. (ref/ref_null typeIdx
  // mismatches are NOT handled here — that is the caller's ref-cast concern.)
  if (fromK === toK) {
    if (fromK === "ref" || fromK === "ref_null") return null;
    if (isExternKind(from.kind) && isExternKind(to.kind)) return { instrs: [] };
    return { instrs: [] };
  }

  // Both externref-ish (externref ↔ ref_extern spelling): no-op.
  if (isExternKind(from.kind) && isExternKind(to.kind)) return { instrs: [] };

  // ── numeric ↔ numeric (lossless arithmetic conversions) ──
  if (fromK === "i32" && toK === "f64") return { instrs: [{ op: "f64.convert_i32_s" }] };
  if (fromK === "f64" && toK === "i32") return { instrs: [{ op: "i32.trunc_sat_f64_s" } as Instr] };
  if (fromK === "i64" && toK === "f64") return { instrs: [{ op: "f64.convert_i64_s" }] };
  if (fromK === "f64" && toK === "i64") return { instrs: [{ op: "i64.trunc_sat_f64_s" } as Instr] };
  if (fromK === "i32" && toK === "i64") return { instrs: [{ op: "i64.extend_i32_s" }] };
  if (fromK === "i64" && toK === "i32") return { instrs: [{ op: "i32.wrap_i64" }] };

  // ── number → externref (box) ──
  if (fromK === "f64" && isExternKind(to.kind)) {
    if (boxNumberIdx === null) return null;
    return { instrs: [{ op: "call", funcIdx: boxNumberIdx }] };
  }
  if (fromK === "i32" && isExternKind(to.kind)) {
    if (boxNumberIdx === null) return null;
    return { instrs: [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxNumberIdx }] };
  }
  if (fromK === "i64" && isExternKind(to.kind)) {
    if (boxNumberIdx === null) return null;
    return { instrs: [{ op: "f64.convert_i64_s" }, { op: "call", funcIdx: boxNumberIdx }] };
  }

  // ── externref → number (unbox) ──
  if (isExternKind(from.kind) && toK === "f64") {
    if (unboxNumberIdx === null) return null;
    return { instrs: [{ op: "call", funcIdx: unboxNumberIdx }] };
  }
  if (isExternKind(from.kind) && toK === "i32") {
    if (unboxNumberIdx === null) return null;
    return { instrs: [{ op: "call", funcIdx: unboxNumberIdx }, { op: "i32.trunc_sat_f64_s" } as Instr] };
  }
  if (isExternKind(from.kind) && toK === "i64") {
    if (unboxNumberIdx === null) return null;
    return { instrs: [{ op: "call", funcIdx: unboxNumberIdx }, { op: "i64.trunc_sat_f64_s" } as Instr] };
  }

  // ── ref/ref_null → number: extern.convert_any then unbox ──
  // (A GC ref carrying a boxed number — e.g. an AnyValue/$box_number struct
  // reached the externref world. extern.convert_any re-enters the extern side
  // so __unbox_number can read it. This is what callArgCoercionInstrs does;
  // fixBranchType previously dropped to 0/NaN here — the #1917 divergence.)
  if ((from.kind === "ref" || from.kind === "ref_null") && toK === "f64") {
    if (unboxNumberIdx === null) {
      // No unbox helper available — genuinely cannot bridge; lossy NaN
      // (ToNumber(object-without-valueOf) is NaN per §7.1.4).
      return { instrs: [{ op: "drop" }, { op: "f64.const", value: NaN }], lossy: true };
    }
    return { instrs: [{ op: "extern.convert_any" } as Instr, { op: "call", funcIdx: unboxNumberIdx }] };
  }
  if ((from.kind === "ref" || from.kind === "ref_null") && toK === "i32") {
    if (unboxNumberIdx === null) {
      return { instrs: [{ op: "drop" }, { op: "i32.const", value: 0 }], lossy: true };
    }
    return {
      instrs: [
        { op: "extern.convert_any" } as Instr,
        { op: "call", funcIdx: unboxNumberIdx },
        { op: "i32.trunc_sat_f64_s" } as Instr,
      ],
    };
  }

  // ── ref/ref_null/eqref/anyref → externref: extern.convert_any (lossless) ──
  // NOTE: the AnyValue-in-standalone variant needs `ensureAnyToExternHelper`
  // (ctx) and is intentionally NOT covered here — `coercionInstrs` keeps that
  // arm and only delegates the plain extern.convert_any case.
  if (
    (from.kind === "ref" || from.kind === "ref_null" || from.kind === "eqref" || from.kind === "anyref") &&
    isExternKind(to.kind)
  ) {
    return { instrs: [{ op: "extern.convert_any" } as Instr] };
  }

  // ── externref → anyref/eqref: any.convert_extern ──
  if (isExternKind(from.kind) && (toK === "anyref" || toK === "eqref")) {
    return { instrs: [{ op: "any.convert_extern" } as Instr] };
  }

  // ── ref_null → ref (same typeIdx handled by caller); only nullability drop ──
  // Not a representation change; leave to the caller (needs typeIdx equality
  // check). Return null.

  // ── funcref → externref: separate hierarchy, no bridge → lossy null ──
  if (from.kind === "funcref" && isExternKind(to.kind)) {
    return { instrs: [{ op: "drop" }, { op: "ref.null.extern" }], lossy: true };
  }
  // funcref → anyref: separate hierarchies; no-op fallback (matches coercionInstrs).
  if (from.kind === "funcref" && toK === "anyref") {
    return { instrs: [] };
  }

  // Not a row this table owns (guarded ref.cast / AnyValue helper / etc.).
  return null;
}
