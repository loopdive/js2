// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3638) Receiver normalisation for the reflective `<builtinMethod>.call/apply`
// lowering (`emitReflectiveNativeProtoClosureCall`, expressions/calls.ts).
//
// THE DEFECT THIS MODULE EXISTS TO CLOSE
// --------------------------------------
// That lowering ends with an UNCONDITIONAL `ref.cast (ref $selfCarrier)` of the
// receiver value. The cast is only sound when the receiver's RUNTIME VALUE is
// the native-method wrapper struct — but the gate that selects the lowering
// proves something strictly weaker: that the receiver's STATIC TYPE is a
// builtin-prototype `MethodSignature`. Two different receiver SYNTAXES share
// that static type and lower to different runtime values:
//
//   Array.prototype.fill.call(o, 1)  →  the identity-stable
//                                       `__builtinfn_singleton_*` wrapper ✔
//   [].fill.call(o, 1) / a.fill.call →  the dynamic instance member read
//                                       `__extern_get(vec, "fill")`, which
//                                       yields NULL today ✘
//
// A non-null `ref.cast` on null traps `illegal cast`. A trap is UNCATCHABLE: it
// aborts the module, so an enclosing `try`/`catch` — and test262's
// `assert.throws` — can never observe it. On the JS-host lane the same program
// raises a catchable `TypeError` ("Cannot read properties of null"), so the trap
// is also a lane divergence.
//
// This is the same shape as #3610's "reusable generalisation": an unconditional
// `ref.cast` justified by a static type that no longer describes the runtime
// value. #3610 fixed the receiver-brand instances of it; this is the residual
// `illegal_cast [in __closure_# ← __closure_# ← __call_fn_method_# ←
// __apply_closure]` bucket #3620's census left explicitly unowned.
//
// THE FIX
// -------
// §23.1.3 says `a.fill` IS `Array.prototype.fill` — the SAME function object,
// reached through the prototype chain. So the instance shape resolves to the
// SAME per-(brand, member) singleton the `.prototype` shape reads, with the
// base evaluated only for its side effects. The two syntaxes then behave
// observationally identically instead of one of them trapping, and the
// already-working shapes keep their byte-identical lowering.
//
// Deliberately NOT done here: minting a fresh `ref.func` + `struct.new` per
// call site. That was tried before (see the comment history in calls.ts) and
// tripped a wrapper-struct type-idx consistency check at finalize, because the
// probe and the final wrapper in `ensureStandaloneNativeMethodClosure` register
// distinct struct types. `pushBuiltinFnSingletonValueInstrs` is the mechanism
// that already solved that — one lazily-initialised module global per wrapper
// type — so identity is preserved (`a.fill === Array.prototype.fill`) instead
// of merely "a callable is produced".

import { ts } from "../ts-api.js";
import { pushBuiltinFnSingletonValueInstrs } from "./builtin-fn-meta.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { compileExpression } from "./expressions.js";

/** The `{ type, funcIdx }` handle `ensureStandaloneNativeMethodClosure` returns. */
type NativeMethodClosure = { type: { kind: "ref"; typeIdx: number }; funcIdx: number };

/** Strip parens / `as`-casts / non-null assertions without changing the value. */
function unwrapTransparent(e: ts.Expression): ts.Expression {
  let cur = e;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isTypeAssertionExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/**
 * True when `receiver` is an **instance** member read of a builtin prototype
 * method — `[].fill`, `a.slice`, `this.join` — rather than the
 * `<Ident>.prototype.<member>` value read.
 *
 * Anything that is not a property access (an identifier holding a value-read
 * closure, a call result, …) returns false and keeps the pre-existing
 * receiver-compiling path, so this only ever widens the set of shapes that
 * reach a wrapper — it never takes one away.
 */
export function isInstanceMemberProtoRead(receiver: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(receiver)) return false;
  const base = unwrapTransparent(receiver.expression);
  return !(ts.isPropertyAccessExpression(base) && base.name.text === "prototype");
}

/**
 * Conservative purity test for the BASE of an instance member read.
 *
 * When true the base is not compiled at all — its value is discarded anyway,
 * and compiling a bare `[]` in expression position can itself FAIL ("empty
 * array literal needs a vec-typed hint to infer element type"), which would
 * turn a runtime trap into a compile error. When false the base IS compiled and
 * dropped, so observable side effects still happen in source order. Anything it
 * cannot prove returns false, i.e. the base is evaluated.
 */
export function isSideEffectFreeReceiverBase(expr: ts.Expression): boolean {
  const e = unwrapTransparent(expr);
  if (ts.isIdentifier(e) || e.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isNumericLiteral(e)) return true;
  if (
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isArrayLiteralExpression(e)) return e.elements.every((el) => isSideEffectFreeReceiverBase(el));
  return false;
}

/**
 * Push the reflective call's receiver so the caller's
 * `ref.cast (ref selfTypeIdx)` is sound.
 *
 * - Instance member read → evaluate the base for side effects (when it can have
 *   any), discard it, and push the identity-stable singleton for the member.
 * - Every other shape → the pre-existing path: compile the receiver and
 *   `any.convert_extern` when it is externref. Byte-identical to before.
 *
 * Leaves exactly one value on the stack, ready for the caller's `ref.cast`.
 */
export function pushReflectiveCallReceiver(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
  closure: NativeMethodClosure,
): void {
  if (isInstanceMemberProtoRead(receiver)) {
    const base = (receiver as ts.PropertyAccessExpression).expression;
    if (!isSideEffectFreeReceiverBase(base)) {
      const baseType = compileExpression(ctx, fctx, base);
      if (baseType !== null) fctx.body.push({ op: "drop" });
    }
    fctx.body.push(...pushBuiltinFnSingletonValueInstrs(ctx, closure));
    return;
  }
  const recvType = compileExpression(ctx, fctx, receiver);
  if (recvType && recvType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
  }
}
