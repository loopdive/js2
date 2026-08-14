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
import { ts } from "../ts-api.js";
import { isStringType } from "../checker/type-mapper.js";
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";
import { nativeStringLiteralInstrs } from "./native-string-literals.js"; // (#4394) null-carrier ToString

const MIN_BATCHED_CONCAT_ARITY = 3;
const MAX_BATCHED_CONCAT_ARITY = 8;
const FLAT_CONCAT_LIMIT = 64;

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

  // Params: operand0..operandN-1.
  // Locals: totalLen(N), output(N+1), offset(N+2).
  const totalLenLocal = arity;
  const outputLocal = arity + 1;
  const offsetLocal = arity + 2;
  const body: Instr[] = [];
  // (#4394) Null-carrier ToString guard. A statically-string-typed operand can
  // carry the null $AnyString sentinel at runtime — the JS `undefined` of a
  // missing property/param that flowed through a string-typed slot (the #3548
  // carrier convention; e.g. `expectedErrorConstructor.name` in the test262
  // asyncHelpers, JSDoc-typed `string`). The length sum below would trap on it
  // ("dereferencing a null pointer in __str_concat_N"). §7.1.17 ToString of
  // that carrier is "undefined", so substitute exactly that — never the empty
  // string, which would silently corrupt the concatenation.
  for (let index = 0; index < arity; index++) {
    body.push(
      { op: "local.get", index },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [...nativeStringLiteralInstrs(ctx, "undefined"), { op: "local.set", index }],
      },
    );
  }
  body.push({ op: "i32.const", value: 0 });
  for (let index = 0; index < arity; index++) {
    body.push({ op: "local.get", index }, { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 }, { op: "i32.add" });
  }
  body.push(
    { op: "local.tee", index: totalLenLocal },
    { op: "i32.const", value: FLAT_CONCAT_LIMIT },
    { op: "i32.lt_u" },
  );

  const flatArm: Instr[] = [];
  for (let index = 0; index < arity; index++) {
    flatArm.push(
      { op: "local.get", index },
      { op: "ref.test", typeIdx: strTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index },
          { op: "call", funcIdx: flattenIdx },
          { op: "local.set", index },
        ],
      },
    );
  }
  flatArm.push(
    { op: "local.get", index: totalLenLocal },
    { op: "array.new_default", typeIdx: strDataTypeIdx },
    { op: "local.set", index: outputLocal },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: offsetLocal },
  );
  for (let index = 0; index < arity; index++) {
    flatArm.push(
      { op: "local.get", index: outputLocal },
      { op: "ref.as_non_null" },
      { op: "local.get", index: offsetLocal },
      { op: "local.get", index },
      { op: "ref.cast", typeIdx: strTypeIdx },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.get", index },
      { op: "ref.cast", typeIdx: strTypeIdx },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.get", index },
      { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 },
      { op: "array.copy", dstTypeIdx: strDataTypeIdx, srcTypeIdx: strDataTypeIdx },
    );
    if (index + 1 < arity) {
      flatArm.push(
        { op: "local.get", index: offsetLocal },
        { op: "local.get", index },
        { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 },
        { op: "i32.add" },
        { op: "local.set", index: offsetLocal },
      );
    }
  }
  flatArm.push(
    { op: "local.get", index: totalLenLocal },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: outputLocal },
    { op: "ref.as_non_null" },
    { op: "struct.new", typeIdx: strTypeIdx },
  );

  // Preserve the exact existing left-associated concat/rope behaviour for
  // longer results. Only the short-string allocation path changes.
  const pairwiseArm: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: concatIdx },
  ];
  for (let index = 2; index < arity; index++) {
    pairwiseArm.push({ op: "local.get", index }, { op: "call", funcIdx: concatIdx });
  }

  body.push({
    op: "if",
    blockType: { kind: "val", type: strRef },
    then: flatArm,
    else: pairwiseArm,
  });

  pushDefinedFunc(ctx, funcIdx, {
    name: helperName,
    typeIdx,
    locals: [
      { name: "totalLen", type: { kind: "i32" } },
      { name: "output", type: { kind: "ref_null", typeIdx: strDataTypeIdx } },
      { name: "offset", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}
