// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3931) IR front-end port of legacy's #2682 canonical char-read-loop
 * recogniser (`src/codegen/statements/loops.ts`'s
 * `detectCanonicalCharReadLoop` + `src/codegen/string-ops.ts`'s
 * `matchHoistedCharRead`).
 *
 * ## Why this exists
 *
 * #2682 recognises the canonical string-read hot loop
 *
 * ```ts
 * for (let i = <int ≥ 0>; i < recv.length; i++)   // … recv.charCodeAt(i) …
 * ```
 *
 * and hoists the loop-invariant flatten + `.data`/`.off` descriptor into
 * locals emitted ONCE before the loop, so each body read is a bare
 * `array.get_u` with no bounds/NaN branch. It lives on the LEGACY AST path,
 * and the IR overlay has since taken ownership of those function bodies —
 * measured on the pre-#3907 base branch, the hoist was already dead for
 * `nativeStrings` alone, `target: "standalone"` and `target: "wasi"`, and
 * survived only in `fast + nativeStrings` because that mode's (unsound) i32
 * grounding kept the IR selector out. #3907 removed the grounding, so the
 * last pocket closed. Standalone and wasi had been missing it all along.
 *
 * ## What is proven, and why the OOB branch may be dropped
 *
 * Exactly legacy's proof, discharged by exactly legacy's predicates (all
 * re-used from `codegen/statements/loop-analysis.ts`, so the two front-ends
 * cannot drift):
 *
 *   - `i` is a `detectI32LoopVar` counter with a **non-negative** integer
 *     literal init;
 *   - the step **strictly increases** `i` (`i++` / `++i` / `i += <k>0>`);
 *   - the condition is exactly `i < recv.length` (strict `<`, index on the
 *     left, `recv` a statically string-typed identifier);
 *   - the body never assigns `i`/`recv`, never SHADOWS either name, and
 *     contains no nested function/class that could capture and reassign them;
 *   - the body actually contains at least one `recv.charCodeAt(i)`.
 *
 * ⇒ `0 <= i < recv.length` at every body point, so `recv.charCodeAt(i)` can
 * never be out of range: its §22.1.3.3 NaN result is dead code, and a direct
 * unguarded code-unit read is byte-identical to the guarded one. That is what
 * licenses BOTH halves of the optimisation — dropping the guard, and treating
 * the read as a genuine int32-range LEAF for `ir/i32-pure-bitwise.ts` (a
 * charCodeAt result is a u16, always int32-range), which is what collapses
 * `(h * 31 + recv.charCodeAt(i)) | 0` from the f64 ToInt32 bit-decomposition
 * dance to native `i32.mul`/`i32.add`.
 *
 * Everything here is a pure AST query plus a small record; the emission side
 * (preheader hoist + read sites) lives in `ir/from-ast.ts`, and the
 * backend-specific helper names / ValTypes come from the resolver's
 * `charReadPlan()` (implemented in `ir/integration.ts`) — from-ast reads no
 * `nativeStrings`, per the #2955 discipline.
 */
import { ts } from "../ts-api.js";
import {
  bodyHasMatchingCharRead,
  detectI32LoopVar,
  isIncreasingStep,
  loopBodyMutatesStringReadInvariants,
} from "./analysis/loop-shape.js";

/** The recognised shape — receiver + induction variable of a canonical loop. */
export interface CanonicalCharReadLoop {
  readonly recvName: string;
  readonly indexName: string;
  /** The receiver identifier as it appears in the loop condition. */
  readonly recvIdent: ts.Identifier;
}

/**
 * An INSTALLED proof for the loop currently being lowered: the read sites in
 * its body may skip the bounds/NaN guard. `hoist` is present when the backend
 * has a flattenable string descriptor to hoist (native strings); host-string
 * mode has nothing to flatten and carries `trustedFuncName` instead.
 */
export interface CharReadProof {
  readonly recvName: string;
  readonly indexName: string;
  /** Native-strings: the flattened receiver, parked ONCE in the preheader. */
  readonly hoist: {
    /** Slot (string-carrier typed) holding the flattened receiver. */
    readonly flatSlot: number;
    /** `(flat, i32) -> i32` unguarded code-unit read helper. */
    readonly readFuncName: string;
  } | null;
  /** Host-strings: `(recv, i32) -> i32` unguarded code-unit read helper. */
  readonly trustedFuncName: string | null;
  /**
   * (#4517) i32 slot holding `recv.length`, hoisted into the preheader by the
   * same invariance proof as `hoist`, so `lowerForStatement` can emit the loop
   * CONDITION as `i32.lt_s(i, len)`. `null` means "not available" — the caller
   * then keeps the generic condition lowering, unchanged.
   */
  readonly lenSlot: number | null;
}

/** Proof map for the loop body currently being lowered, keyed by receiver NAME. */
export type ProvenCharReads = ReadonlyMap<string, CharReadProof>;

/**
 * The AST half of the recogniser: does `stmt` match the canonical shape?
 * Emits nothing and allocates nothing — the caller decides whether a backend
 * plan is available before installing anything.
 *
 * `isStringTyped` is supplied by the caller so this module never touches a
 * checker or an oracle directly (from-ast passes an `oracle.typeFactOf`-backed
 * probe). A caller with no type information must pass a predicate that returns
 * `false`, which refuses the optimisation — fail closed, never miscompile.
 */
export function detectCanonicalCharReadLoopShape(
  stmt: ts.ForStatement,
  isStringTyped: (id: ts.Identifier) => boolean,
): CanonicalCharReadLoop | null {
  // Induction var: same `detectI32LoopVar` shape the i32-promotion uses, plus
  // the strictly-increasing-from-non-negative constraints it lacks.
  const i32Loop = detectI32LoopVar(stmt);
  if (!i32Loop) return null;
  const indexName = i32Loop.name;
  if (i32Loop.initValue < 0) return null; // i must start >= 0
  if (!isIncreasingStep(stmt.incrementor, indexName)) return null;

  // Condition must be exactly `i < recv.length` (strict <, index on the left).
  const cond = stmt.condition;
  if (!cond || !ts.isBinaryExpression(cond)) return null;
  if (cond.operatorToken.kind !== ts.SyntaxKind.LessThanToken) return null;
  if (!ts.isIdentifier(cond.left) || cond.left.text !== indexName) return null;
  if (!ts.isPropertyAccessExpression(cond.right) || cond.right.name.text !== "length") return null;
  if (!ts.isIdentifier(cond.right.expression)) return null;
  const recvIdent = cond.right.expression;
  const recvName = recvIdent.text;
  if (recvName === indexName) return null;

  // recv must be a string — not any/union/array (a `.length` alone proves
  // nothing; an array's `charCodeAt` does not exist, but `any` would compile).
  if (!isStringTyped(recvIdent)) return null;

  // Loop-invariance + induction-in-bounds: no mutation/shadowing of recv/i,
  // no nested function or class that could capture and reassign either.
  if (loopBodyMutatesStringReadInvariants(stmt.statement, indexName, recvName)) return null;

  // Only worth installing if the body actually reads `recv.charCodeAt(i)`.
  if (!bodyHasMatchingCharRead(stmt.statement, recvName, indexName)) return null;

  return { recvName, indexName, recvIdent };
}

/**
 * (#3931, mirrors legacy `matchHoistedCharRead`) If `expr` is
 * `recv.charCodeAt(i)` for an ACTIVE proof — the same receiver name and the
 * SAME induction identifier — return that proof, else `null`.
 *
 * The match is deliberately exact: `recv.charCodeAt(i + 1)`, a literal index,
 * or a different receiver keeps the guarded lowering, because the dropped OOB
 * branch is only sound for the proven induction variable itself. Keying on
 * identifier TEXT is sound because the recogniser rejects any body that
 * shadows either name.
 */
export function matchProvenCharRead(expr: ts.Expression, proofs: ProvenCharReads | undefined): CharReadProof | null {
  if (!proofs || proofs.size === 0) return null;
  if (!ts.isCallExpression(expr)) return null;
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "charCodeAt") return null;
  if (!ts.isIdentifier(callee.expression)) return null;
  const entry = proofs.get(callee.expression.text);
  if (!entry) return null;
  if (expr.arguments.length !== 1) return null;
  const arg = expr.arguments[0]!;
  if (!ts.isIdentifier(arg) || arg.text !== entry.indexName) return null;
  return entry;
}
