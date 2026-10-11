// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Argument evaluation order for the in-place native vec built-ins (#6787).
 *
 * §13.3.6.1 (EvaluateCall) evaluates the receiver and EVERY argument before the
 * built-in runs, and `push` / `unshift` / `splice` / `fill` / `copyWithin` read
 * the receiver's `length` inside the built-in. The native lowerings snapshot
 * `length` and the backing array into locals first, so an argument compiled
 * after that snapshot runs against stale state: `a.push(f())` where `f` pushes
 * onto `a` lost `f`'s element, and `b.push(b.pop()!)` re-appended into the slot
 * the pop had just vacated.
 *
 * `planCallArgs` puts the argument evaluation back in front of the snapshot
 * without slowing the common case:
 *
 *   - every argument side-effect free (a literal, an identifier, `this`) → no
 *     argument can touch the receiver, nothing is emitted up front, and each
 *     argument still compiles at its use site — `a.push(x)` is byte-identical;
 *   - otherwise EVERY argument is evaluated now, left to right, into a temp
 *     local, and its use site reads that local. The side-effect-free ones are
 *     spilled too, so a TDZ `ReferenceError` keeps its source position relative
 *     to the effectful arguments.
 *
 * A stored element VALUE is compiled against its element-type hint (storing it
 * runs no user code). An INDEX operand is converted with ToIntegerOrInfinity
 * AFTER `length` is read, and for an object operand that conversion calls
 * `valueOf` — so such an operand is evaluated at its natural type now and only
 * converted at the use site. A primitive operand converts without running user
 * code and is evaluated with its use-site hint directly.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { compileExpression, unpackedElemType } from "./shared.js";
import { coerceType, defaultValueInstrs } from "./type-coercion.js";

/** Per-argument use-site emitters; each pushes exactly one value. */
export interface CallArgPlan {
  /** Push value argument `i`, compiled against its element-type hint. */
  value(i: number): void;
  /** Push index operand `i` converted to the plan's index type. */
  index(i: number): void;
}

/** Conservative: true only when evaluating `expr` can run no code at all. */
function isEffectFreeArg(expr: ts.Expression): boolean {
  let e = expr;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isTypeAssertionExpression(e)
  ) {
    e = e.expression;
  }
  if (ts.isIdentifier(e) || ts.isNumericLiteral(e) || ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
    return true;
  }
  switch (e.kind) {
    case ts.SyntaxKind.ThisKeyword:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
      return true;
  }
  if (ts.isPrefixUnaryExpression(e)) {
    const op = e.operator;
    return (op === ts.SyntaxKind.MinusToken || op === ts.SyntaxKind.PlusToken) && ts.isNumericLiteral(e.operand);
  }
  return ts.isVoidExpression(e) && isEffectFreeArg(e.expression);
}

/** A primitive operand's ToNumber runs no user code, so it may be converted early. */
function convertsWithoutUserCode(ctx: CodegenContext, expr: ts.Expression): boolean {
  const tag = ctx.oracle.staticJsTypeOf(expr);
  return tag === "number" || tag === "string" || tag === "boolean" || tag === "undefined";
}

/**
 * Must the arguments be evaluated before the receiver's `length` snapshot?
 * False only when no argument can run code. Callers decide this BEFORE the
 * receiver is compiled so they can park it in its local (`local.set`, not
 * `local.tee`) and keep the operand stack empty while the arguments run.
 */
export function callArgsNeedEarlyEvaluation(args: readonly ts.Expression[]): boolean {
  return !args.every(isEffectFreeArg);
}

/**
 * Plan the evaluation of `args` for an in-place vec built-in. With `early`
 * (see `callArgsNeedEarlyEvaluation`) every argument is evaluated here, so call
 * it AFTER the receiver is compiled and null-guarded and BEFORE `length`/`data`
 * are read. `valueHint(i)` returns the element-type hint of a stored value
 * argument, or `undefined` for an index operand.
 */
export function planCallArgs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
  early: boolean,
  valueHint: (i: number) => ValType | undefined,
  indexType: ValType,
): CallArgPlan {
  if (!early) {
    return {
      value: (i) => void compileExpression(ctx, fctx, args[i]!, valueHint(i)),
      index: (i) => void compileExpression(ctx, fctx, args[i]!, indexType),
    };
  }
  const slots = args.map((arg, i) => {
    const hint = valueHint(i) ?? (convertsWithoutUserCode(ctx, arg) ? indexType : undefined);
    const produced = compileExpression(ctx, fctx, arg, hint);
    // No value (a void-typed operand): a value slot holds the element default,
    // an index slot holds NaN — ToIntegerOrInfinity(undefined) is 0 either way.
    let type: ValType = produced ?? (hint ? unpackedElemType(hint) : { kind: "f64" });
    if (!produced) {
      fctx.body.push(...(hint ? defaultValueInstrs(type) : [{ op: "f64.const" as const, value: Number.NaN }]));
    }
    if (type.kind === "i8" || type.kind === "i16") type = { kind: "i32" };
    const local = allocLocal(fctx, `__argord_${i}_${fctx.locals.length}`, type);
    fctx.body.push({ op: "local.set", index: local });
    return { local, type };
  });
  return {
    value: (i) => void fctx.body.push({ op: "local.get", index: slots[i]!.local }),
    index: (i) => {
      const slot = slots[i]!;
      fctx.body.push({ op: "local.get", index: slot.local });
      if (slot.type.kind !== indexType.kind) coerceType(ctx, fctx, slot.type, indexType);
    },
  };
}
