// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Eval-specific ArgumentListEvaluation support (#5157).
 *
 * `%eval%` consumes only the first expanded argument, but it still has to
 * evaluate the complete argument list in source order before PerformEval.
 * This uses the existing strict native spread provider rather than the shared
 * delayed-store builder: eval must snapshot every expanded value before the
 * next syntactic argument can mutate the spread source.
 */
import { ts } from "../../ts-api.js";
import type { Instr } from "../../ir/types.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { ensureNativeStrictSpreadRuntime } from "../iterator-native.js";
import { hasSpreadArgument } from "../spread-arg-list.js";
import { coerceType, compileExpression, flushLateImportShifts } from "../shared.js";
import { emitUndefined } from "./late-imports.js";

/** The first value produced by a complete eval argument list. */
export interface EvalArgumentList {
  /** `undefined` when the expanded list contains no values. */
  sourceLocal: number;
}

/**
 * Stage eval's first argument value and evaluate every later argument before
 * the caller publishes its provider snapshot. Standalone callers opt into the
 * strict spread provider; the reified host route retains its existing ordinary
 * argument lowering because it does not link that provider.
 */
export function buildEvalArgumentList(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
  tag: string,
  expandStandaloneSpreads: boolean,
): EvalArgumentList | undefined {
  if (args.length === 0) return undefined;
  if (expandStandaloneSpreads && hasSpreadArgument(args)) {
    return buildEvalSpreadArgumentList(ctx, fctx, args, tag);
  }

  const sourceLocal = allocLocal(fctx, `__${tag}_source_${fctx.locals.length}`, { kind: "externref" });
  const sourceType = compileExpression(ctx, fctx, args[0]!);
  if (sourceType === null) {
    emitUndefined(ctx, fctx);
  } else if (sourceType.kind !== "externref") {
    coerceType(ctx, fctx, sourceType, { kind: "externref" });
  }
  fctx.body.push({ op: "local.set", index: sourceLocal });
  for (let i = 1; i < args.length; i++) {
    const extraType = compileExpression(ctx, fctx, args[i]!);
    if (extraType !== null) fctx.body.push({ op: "drop" });
  }
  return { sourceLocal };
}

/**
 * Evaluate a spread-containing eval argument list exactly once.
 *
 * The returned source local starts as `undefined`, which is the value
 * PerformEval receives for an empty ArgumentListEvaluation. Each spread is
 * fully iterated before the next syntactic argument is evaluated, so later
 * expressions cannot alter which value becomes eval's source. The strict
 * provider owns GetIterator/IteratorNext dispatch for the carrier it receives;
 * its outstanding tuple and Array-iterator-override limitations are tracked
 * separately in the #5157 issue record rather than hidden here.
 */
export function buildEvalSpreadArgumentList(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
  tag: string,
): EvalArgumentList | undefined {
  // The standalone strict provider is registered before any user expression
  // can be emitted. A caller that cannot use it may safely take another path
  // without replaying argument effects.
  if (!ctx.standalone || ensureNativeStrictSpreadRuntime(ctx) === undefined) {
    return undefined;
  }
  if (ctx.funcMap.get("__iterator_strict") === undefined || ctx.funcMap.get("__iterator_next_strict") === undefined) {
    return undefined;
  }
  flushLateImportShifts(ctx, fctx);

  const sourceLocal = allocLocal(fctx, `__${tag}_source_${fctx.locals.length}`, { kind: "externref" });
  const sawFirstLocal = allocLocal(fctx, `__${tag}_first_${fctx.locals.length}`, { kind: "i32" });
  const valueLocal = allocLocal(fctx, `__${tag}_value_${fctx.locals.length}`, { kind: "externref" });
  const iterableLocal = allocLocal(fctx, `__${tag}_iterable_${fctx.locals.length}`, { kind: "externref" });
  const iteratorLocal = allocLocal(fctx, `__${tag}_iterator_${fctx.locals.length}`, { kind: "externref" });
  const doneLocal = allocLocal(fctx, `__${tag}_done_${fctx.locals.length}`, { kind: "i32" });
  emitUndefined(ctx, fctx);
  fctx.body.push(
    { op: "local.set", index: sourceLocal },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: sawFirstLocal },
  );

  const captureValueInstrs = (): Instr[] => [
    { op: "local.get", index: sawFirstLocal },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: valueLocal },
        { op: "local.set", index: sourceLocal },
        { op: "i32.const", value: 1 },
        { op: "local.set", index: sawFirstLocal },
      ],
      else: [],
    },
  ];

  const compileValue = (expr: ts.Expression): void => {
    const valueType = compileExpression(ctx, fctx, expr);
    if (valueType === null) emitUndefined(ctx, fctx);
    else if (valueType.kind !== "externref") coerceType(ctx, fctx, valueType, { kind: "externref" });
  };

  for (const arg of args) {
    if (!ts.isSpreadElement(arg)) {
      compileValue(arg);
      fctx.body.push({ op: "local.set", index: valueLocal });
      fctx.body.push(...captureValueInstrs());
      continue;
    }

    compileValue(arg.expression);
    fctx.body.push({ op: "local.set", index: iterableLocal });
    // An argument may register late imports. Re-read the strict provider by
    // name after the shift before emitting the iterator calls.
    flushLateImportShifts(ctx, fctx);
    const iteratorIdx = ctx.funcMap.get("__iterator_strict");
    const nextIdx = ctx.funcMap.get("__iterator_next_strict");
    if (iteratorIdx === undefined || nextIdx === undefined) {
      throw new Error("strict native iterator provider disappeared after preflight");
    }
    fctx.body.push(
      { op: "local.get", index: iterableLocal },
      { op: "call", funcIdx: iteratorIdx },
      { op: "local.set", index: iteratorLocal },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: iteratorLocal },
              { op: "call", funcIdx: nextIdx },
              { op: "local.set", index: valueLocal },
              { op: "local.set", index: doneLocal },
              { op: "local.get", index: doneLocal },
              { op: "br_if", depth: 1 },
              ...captureValueInstrs(),
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
    );
  }

  return { sourceLocal };
}
