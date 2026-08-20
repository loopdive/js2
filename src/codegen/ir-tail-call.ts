// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Tail-call optimization for IR-lowered function bodies.
 *
 * The legacy AST return path applies tail-call conversion in
 * `maybeEmitTailCall` (`src/codegen/statements/control-flow.ts`): a `return
 * f(...)` whose trailing instruction is a `call` / `call_ref` is rewritten to
 * `return_call` / `return_call_ref`, replacing the caller frame so deep
 * self/mutual recursion does not grow the Wasm stack (#602).
 *
 * The IR lowering (`src/ir/lower.ts`) emits a `return` terminator as
 * `<operands…>; return` and never performs this conversion — so any function the
 * IR claims (notably top-level recursive functions) lost the optimization, and
 * deep recursion overflowed the stack again (a regression vs. the legacy path,
 * where the same function NESTED inside another stays on the legacy path and
 * keeps the tail call).
 *
 * This pass restores parity by post-processing the assembled IR body. It runs in
 * the integration layer (`src/ir/integration.ts`) where the full module type
 * information is available, so it can apply the SAME guards as the legacy path:
 *
 *   - callee param count must equal the caller's param count (return_call needs
 *     exactly the callee's params on the stack — #822);
 *   - callee result type must match the caller's return type (#839);
 *   - never inside a `try` that has a catch/catch-all handler — return_call
 *     replaces the caller frame, so a throw from the callee would unwind past
 *     the enclosing catch and escape (#1972). We do NOT descend into `try`
 *     bodies/handlers at all (conservative: a tail call inside a finally-only
 *     try is also left alone, matching the legacy `tryCatchDepth` guard which is
 *     set for any try frame on the return path).
 *
 * A `call` / `call_ref` qualifies only when it is the instruction IMMEDIATELY
 * preceding a `return` (the value flows straight into the return), at any tail
 * position — top-level body or inside `if` / `block` / `loop` arms (a `return`
 * there is still a tail of the function).
 */
import type { CodegenContext } from "./context/types.js";
import type { Instr, ValType } from "../ir/types.js";
import { definedFuncAt, isImportFuncIdx } from "./func-space.js"; // (#1916 S2) positional-read chokepoint

/** Caller signature derived from its own funcType. */
interface CallerSig {
  paramCount: number;
  returnType: ValType | null;
}

function funcTypeOf(ctx: CodegenContext, typeIdx: number): { params: ValType[]; results: ValType[] } | null {
  const t = ctx.mod.types[typeIdx];
  if (!t || t.kind !== "func") return null;
  return { params: t.params, results: t.results };
}

/** The funcType index for a callee function index (import or defined). */
function calleeTypeIdx(ctx: CodegenContext, calleeIdx: number): number | undefined {
  if (isImportFuncIdx(ctx, calleeIdx)) {
    // NOTE (pre-existing, preserved for byte-identity — #1916 S3 review): this
    // indexes the FULL imports array by func-space index, which only lines up
    // while func imports precede non-func imports; a mismatch degrades to
    // undefined via the kind guard.
    const imp = ctx.mod.imports[calleeIdx];
    return imp?.desc.kind === "func" ? imp.desc.typeIdx : undefined;
  }
  return definedFuncAt(ctx, calleeIdx)?.typeIdx;
}

/** Mirror of the legacy return-type compatibility check (control-flow.ts). */
function resultsMatchCaller(calleeResults: ValType[], caller: CallerSig): boolean {
  if (caller.returnType === null) return calleeResults.length === 0;
  if (calleeResults.length !== 1) return false;
  const calleeRet = calleeResults[0]!;
  const callerRet = caller.returnType;
  if (calleeRet.kind === callerRet.kind) return true;
  // ref/ref_null are compatible for return purposes.
  if (
    (calleeRet.kind === "ref" || calleeRet.kind === "ref_null") &&
    (callerRet.kind === "ref" || callerRet.kind === "ref_null")
  ) {
    return true;
  }
  return false;
}

function callIsTailEligible(ctx: CodegenContext, instr: Instr, caller: CallerSig): boolean {
  if (instr.op === "call") {
    const tIdx = calleeTypeIdx(ctx, instr.funcIdx);
    if (tIdx === undefined) return false;
    const ft = funcTypeOf(ctx, tIdx);
    if (!ft) return false;
    if (ft.params.length !== caller.paramCount) return false;
    return resultsMatchCaller(ft.results, caller);
  }
  if (instr.op === "call_ref") {
    if (instr.typeIdx === undefined) return false;
    const ft = funcTypeOf(ctx, instr.typeIdx);
    if (!ft) return false;
    if (ft.params.length !== caller.paramCount) return false;
    return resultsMatchCaller(ft.results, caller);
  }
  return false;
}

/**
 * (#2707c) Rewrite the trailing tail call of one `if`-arm that sits in return
 * position — i.e. the `if` is immediately followed by `return`, so each arm's
 * value flows straight into that return.
 *
 * `return <?:>` / `return <a && b>` / `return <a || b>` lower to an
 * `(if (result T) (then …) (else …))` that PRODUCES the returned value, with a
 * single `return` AFTER the `if`. The tail call is then the last value-producing
 * instruction of an arm (e.g. `… call $f` in the `&&` RHS), NOT a `call`
 * immediately followed by `return` — so the adjacency rewrite in `convertBuffer`
 * never sees it. Here the arm's value-producing tail is one of:
 *   - a `call`/`call_ref` optionally followed by a single IR materialization
 *     `local.tee`/`local.set` (the IR tees the call result into a temp) — rewrite
 *     to `return_call`/`return_call_ref` and drop the now-dead materialization,
 *   - a nested `if` (a chained `?:` / `&&` / `||`) — recurse into its arms.
 * Any other trailing shape (a plain value, `f() + 1`, a non-eligible call) is
 * left untouched, so a non-tail call is never mis-promoted. `return_call` is a
 * stack-polymorphic terminator, so an arm that terminates this way still
 * satisfies the `if`'s declared result type even when the sibling arm produces a
 * value that flows to the outer `return`.
 */
function rewriteArmTrailingTailCall(ctx: CodegenContext, arm: Instr[], caller: CallerSig): void {
  if (arm.length === 0) return;
  let idx = arm.length - 1;
  const last = arm[idx]!;
  // Skip the IR's trailing call-result materialization, which moves the call's
  // single result into the arm's result value. Two shapes occur before the
  // peephole pass collapses them:
  //   `… call; local.set X; local.get X`  (store-then-reload the SAME local), or
  //   `… call; local.tee X`               (already collapsed / tee form).
  // The `local.set X; local.get X` pair is only a passthrough when both touch
  // the same local — otherwise the trailing `local.get` is an unrelated value
  // and the call is NOT in tail position.
  const prev = idx >= 1 ? arm[idx - 1]! : undefined;
  if (
    last.op === "local.get" &&
    prev &&
    prev.op === "local.set" &&
    (last as { index?: number }).index === (prev as { index?: number }).index
  ) {
    idx -= 2;
  } else if (last.op === "local.tee" || last.op === "local.set") {
    idx -= 1;
  }
  if (idx < 0) return;
  const target = arm[idx]!;
  if ((target.op === "call" || target.op === "call_ref") && callIsTailEligible(ctx, target, caller)) {
    if (target.op === "call") {
      arm[idx] = { op: "return_call", funcIdx: target.funcIdx };
    } else {
      arm[idx] = { op: "return_call_ref", typeIdx: target.typeIdx! };
    }
    // Drop any now-unreachable instruction(s) after the terminator (the
    // materialization tee/set, if present).
    arm.length = idx + 1;
  } else if (target.op === "if") {
    rewriteArmTrailingTailCall(ctx, target.then, caller);
    if (target.else) rewriteArmTrailingTailCall(ctx, target.else, caller);
  }
}

/**
 * Rewrite `<call>; return` → `<return_call>` in-place within one instruction
 * buffer, recursing into the tail arms of structured control flow. Returns the
 * (possibly shortened) buffer. `try` is intentionally NOT descended into.
 */
function convertBuffer(ctx: CodegenContext, body: Instr[], caller: CallerSig): Instr[] {
  const containsTryTable = (instrs: Instr[]): boolean => {
    for (const instr of instrs) {
      if (instr.op === "try_table") return true;
      if ((instr.op === "block" || instr.op === "loop") && containsTryTable(instr.body)) return true;
      if (instr.op === "if" && (containsTryTable(instr.then) || (instr.else && containsTryTable(instr.else)))) {
        return true;
      }
    }
    return false;
  };

  // Recurse first into nested control-flow arms (their trailing return is a
  // tail of the function too). Skip `try` — see header.
  for (const instr of body) {
    if (instr.op === "if") {
      instr.then = convertBuffer(ctx, instr.then, caller);
      if (instr.else) instr.else = convertBuffer(ctx, instr.else, caller);
    } else if ((instr.op === "block" || instr.op === "loop") && !containsTryTable(instr.body)) {
      instr.body = convertBuffer(ctx, instr.body, caller);
    }
    // `try`: left untouched (return_call inside a try-with-handler would let a
    // callee throw escape the catch — #1972).
  }

  // Local rewrite: any `call`/`call_ref` immediately followed by `return`, plus
  // (#2707c) any `if` immediately followed by `return` — the latter is a
  // `return <?:|&&|||>` whose value-producing arms are in tail position.
  const out: Instr[] = [];
  for (let i = 0; i < body.length; i++) {
    const cur = body[i]!;
    const next = body[i + 1];
    if (
      next &&
      next.op === "return" &&
      (cur.op === "call" || cur.op === "call_ref") &&
      callIsTailEligible(ctx, cur, caller)
    ) {
      if (cur.op === "call") {
        out.push({ op: "return_call", funcIdx: cur.funcIdx });
      } else {
        out.push({ op: "return_call_ref", typeIdx: cur.typeIdx! });
      }
      i++; // consume the following `return`
      continue;
    }
    if (cur.op === "if" && next && next.op === "return") {
      rewriteArmTrailingTailCall(ctx, cur.then, caller);
      if (cur.else) rewriteArmTrailingTailCall(ctx, cur.else, caller);
    }
    out.push(cur);
  }
  return out;
}

/**
 * Apply tail-call optimization to an IR-lowered function body in place.
 * `funcTypeIdx` is the lowered function's own type index. Returns the rewritten
 * body (a new top-level array; nested arms are mutated in place).
 */
export function applyIrTailCalls(ctx: CodegenContext, body: Instr[], funcTypeIdx: number): Instr[] {
  const ft = funcTypeOf(ctx, funcTypeIdx);
  if (!ft) return body;
  const caller: CallerSig = {
    paramCount: ft.params.length,
    returnType: ft.results.length > 0 ? ft.results[0]! : null,
  };
  return convertBuffer(ctx, body, caller);
}
