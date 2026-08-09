// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { flatStringType } from "./native-strings.js";
import { emitFlattenWithInlineFlatFastPath } from "./string-materialize.js";

interface StaticNeedleIndexOfInputs {
  ctx: CodegenContext;
  fctx: FunctionContext;
  expr: ts.CallExpression;
  receiverOverridePresent: boolean;
  emit: readonly [
    compileReceiverToLocal: (name: string) => number,
    compileStringValueToLocal: (value: ts.Expression | undefined, fallback: string, name: string) => number,
    compileIntegerValueToLocal: (value: ts.Expression | undefined, fallback: number, name: string) => number,
  ];
}

/**
 * Resolve only a literal or an immutable chain of `const` aliases to one exact
 * string. This is deliberately narrower than the table-value oracle: an
 * element access can enumerate possible values, but cannot prove which value a
 * dynamic index produces. Fixed-needle search needs one exact value.
 */
function staticConstStringLiteralAlias(
  ctx: CodegenContext,
  expression: ts.Expression,
  seen = new Set<ts.Node>(),
): string | undefined {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  if (ts.isStringLiteralLike(current)) return current.text;
  if (!ts.isIdentifier(current)) return undefined;
  if (seen.has(current)) return undefined;
  seen.add(current);
  const initializer = ctx.oracle.constInitializerOf(current);
  return initializer ? staticConstStringLiteralAlias(ctx, initializer, seen) : undefined;
}

/**
 * Inline `indexOf` for a short, compile-time-proven needle. V8's optimized
 * string search embeds constant code units and removes the generic inner
 * needle loop. For 2..8 UTF-16 code units, emitting the same fixed compare
 * shape is small enough to win without unbounded code growth.
 *
 * Evaluation order is unchanged: receiver, search value, then position are
 * each evaluated exactly once. Reading the search descriptor keeps TDZ/null
 * traps observable even though the proven code units drive the scan. Dynamic
 * values, mutable aliases, tables, long needles, and reflective receivers
 * retain the generic helper path.
 */
export function tryEmitStaticNeedleIndexOf(inputs: StaticNeedleIndexOfInputs): boolean {
  const { ctx, fctx, expr, receiverOverridePresent } = inputs;
  const [compileReceiverToLocal, compileStringValueToLocal, compileIntegerValueToLocal] = inputs.emit;
  if (receiverOverridePresent || expr.arguments.length < 1 || expr.arguments.length > 2) return false;
  if (typeof process !== "undefined" && process.env.JS2WASM_NATIVE_CONST_NEEDLE_INDEXOF === "0") return false;
  const needle = staticConstStringLiteralAlias(ctx, expr.arguments[0]!);
  if (needle === undefined || needle.length < 2 || needle.length > 8) return false;

  const receiverLocal = compileReceiverToLocal("__str_indexOf_const_recv");
  const searchLocal = compileStringValueToLocal(expr.arguments[0], "undefined", "__str_indexOf_const_search");
  const fromLocal = compileIntegerValueToLocal(expr.arguments[1], 0, "__str_indexOf_const_from");

  // Preserve the proven alias read (and its possible null/TDZ trap) even
  // though the scan embeds its immutable code units.
  fctx.body.push({ op: "local.get", index: searchLocal });
  fctx.body.push({ op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "drop" });

  const flatLocal = allocLocal(fctx, `__str_indexOf_const_flat_${fctx.locals.length}`, flatStringType(ctx));
  const lenLocal = allocLocal(fctx, `__str_indexOf_const_len_${fctx.locals.length}`, { kind: "i32" });
  const dataLocal = allocLocal(fctx, `__str_indexOf_const_data_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ctx.nativeStrDataTypeIdx,
  });
  const offLocal = allocLocal(fctx, `__str_indexOf_const_off_${fctx.locals.length}`, { kind: "i32" });
  const lastLocal = allocLocal(fctx, `__str_indexOf_const_last_${fctx.locals.length}`, { kind: "i32" });
  const indexLocal = allocLocal(fctx, `__str_indexOf_const_i_${fctx.locals.length}`, { kind: "i32" });
  const resultLocal = allocLocal(fctx, `__str_indexOf_const_result_${fctx.locals.length}`, { kind: "i32" });

  fctx.body.push({ op: "local.get", index: receiverLocal });
  emitFlattenWithInlineFlatFastPath(ctx, fctx, ctx.nativeStrHelpers.get("__str_flatten")!);
  fctx.body.push({ op: "local.set", index: flatLocal });

  fctx.body.push({ op: "local.get", index: flatLocal });
  fctx.body.push({ op: "struct.get", typeIdx: ctx.nativeStrTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenLocal });
  fctx.body.push({ op: "local.get", index: flatLocal });
  fctx.body.push({ op: "struct.get", typeIdx: ctx.nativeStrTypeIdx, fieldIdx: 2 });
  fctx.body.push({ op: "local.set", index: dataLocal });
  fctx.body.push({ op: "local.get", index: flatLocal });
  fctx.body.push({ op: "struct.get", typeIdx: ctx.nativeStrTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: offLocal });

  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.const", value: needle.length });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: lastLocal });

  // i = max(ToIntegerOrInfinity(fromIndex), 0)
  fctx.body.push({ op: "local.get", index: fromLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.get", index: fromLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.gt_s" });
  fctx.body.push({ op: "select" });
  fctx.body.push({ op: "local.set", index: indexLocal });
  fctx.body.push({ op: "i32.const", value: -1 });
  fctx.body.push({ op: "local.set", index: resultLocal });

  const comparisons: Instr[] = [];
  for (let offset = 0; offset < needle.length; offset++) {
    comparisons.push(
      { op: "local.get", index: dataLocal },
      { op: "local.get", index: offLocal },
      { op: "local.get", index: indexLocal },
      { op: "i32.add" },
    );
    if (offset !== 0) comparisons.push({ op: "i32.const", value: offset }, { op: "i32.add" });
    comparisons.push(
      { op: "array.get_u", typeIdx: ctx.nativeStrDataTypeIdx },
      { op: "i32.const", value: needle.charCodeAt(offset) },
      { op: "i32.ne" },
      { op: "br_if", depth: 0 },
    );
  }
  comparisons.push(
    { op: "local.get", index: indexLocal },
    { op: "local.set", index: resultLocal },
    { op: "br", depth: 2 },
  );

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          { op: "local.get", index: indexLocal },
          { op: "local.get", index: lastLocal },
          { op: "i32.gt_s" },
          { op: "br_if", depth: 1 },
          { op: "block", blockType: { kind: "empty" }, body: comparisons },
          { op: "local.get", index: indexLocal },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: indexLocal },
          { op: "br", depth: 0 },
        ],
      },
    ],
  });
  fctx.body.push({ op: "local.get", index: resultLocal });
  return true;
}
