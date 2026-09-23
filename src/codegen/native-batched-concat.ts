// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Small fixed-arity native-string concat helpers.
 *
 * A source chain such as `"foo-" + value + "-" + index` otherwise becomes
 * three calls to `__str_concat`. For short strings, every one of those calls
 * allocates a new exact-size backing array and recopies the complete prefix.
 * The helpers below preserve the pairwise rope path for results >= 64 code
 * units, but materialize short chains with one allocation and one copy per
 * operand.
 */
import type { Instr, ValType } from "../ir/types.js";
import { buildStringBatchedConcatDefinition } from "../runtime/wasmgc/values/string-concat-bodies.js";
import { ts } from "../ts-api.js";
import { isStringType } from "../checker/type-mapper.js";
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";
import { nativeStringLiteralInstrs } from "./native-string-literals.js"; // (#4394) null-carrier ToString
import { STRING_CONCAT_MANY_NATIVE_ARITY } from "../ir/runtime-manifest.js";

// (#3526 F2-S6) The bound is the NATIVE provider row's, imported rather than
// copied. It used to live here as two literals, with a third copy of the max
// hand-written into the IR pass's call site; the manifest row is now the one
// authority and both readers derive from it.
const MIN_BATCHED_CONCAT_ARITY = STRING_CONCAT_MANY_NATIVE_ARITY.min;
const MAX_BATCHED_CONCAT_ARITY = STRING_CONCAT_MANY_NATIVE_ARITY.max;

/** Flatten only `+` subtrees whose TypeScript result is already a string. */
export function collectConcatOperands(ctx: CodegenContext, expression: ts.Expression): ts.Expression[] {
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    isStringType(ctx.checker.getTypeAtLocation(expression))
  ) {
    return [...collectConcatOperands(ctx, expression.left), ...collectConcatOperands(ctx, expression.right)];
  }
  return [expression];
}

/** Register and return `__str_concat_<arity>`, or decline unsupported arities. */
export function ensureNativeBatchedConcat(ctx: CodegenContext, arity: number): number | undefined {
  if (arity < MIN_BATCHED_CONCAT_ARITY || arity > MAX_BATCHED_CONCAT_ARITY) return undefined;

  const helperName = `__str_concat_${arity}`;
  const existing = ctx.nativeStrHelpers.get(helperName);
  if (existing !== undefined) return existing;

  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const concatIdx = ctx.nativeStrHelpers.get("__str_concat");
  if (
    strTypeIdx < 0 ||
    strDataTypeIdx < 0 ||
    anyStrTypeIdx < 0 ||
    flattenIdx === undefined ||
    concatIdx === undefined
  ) {
    return undefined;
  }

  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const typeIdx = addFuncType(
    ctx,
    Array.from({ length: arity }, () => strRef),
    [strRef],
  );
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeStrHelpers.set(helperName, funcIdx);

  // Preserve each null guard's literal production after registration, in operand order.
  const undefinedLiterals: Instr[][] = [];
  for (let index = 0; index < arity; index++) undefinedLiterals.push(nativeStringLiteralInstrs(ctx, "undefined"));
  const definition = buildStringBatchedConcatDefinition({ strTypeIdx, strDataTypeIdx, anyStrTypeIdx }, arity, {
    flattenIdx,
    concatIdx,
    undefinedLiterals,
  });
  pushDefinedFunc(ctx, funcIdx, {
    name: helperName,
    typeIdx,
    locals: definition.locals,
    body: definition.body,
    exported: false,
  });
  return funcIdx;
}
