// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { TemplateRawReadBinding } from "../runtime/wasmgc/values/object-get-arms.js";
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";

/**
 * Build the dynamic `strings.raw` arm for `__extern_get`.
 *
 * The property key is an arbitrary externref. Check its native-string brand
 * before flattening it; deepEqual's `value[Symbol.iterator]` probe is the
 * important non-string case. Only a native template-vector receiver may then
 * expose its extra `raw` field.
 */
export function captureTemplateRawReadBinding(
  ctx: CodegenContext,
  templateVecTypeIdx: number,
  strFlattenIdx: number | undefined,
  strEqualsIdx: number | undefined,
): TemplateRawReadBinding | undefined {
  if (templateVecTypeIdx < 0 || strFlattenIdx === undefined || strEqualsIdx === undefined) return undefined;
  const testStringType = ctx.anyStrTypeIdx;
  const castStringType = ctx.anyStrTypeIdx;
  const rawLiteral = [...nativeStringLiteralInstrs(ctx, "raw")];
  return {
    testStringType,
    castStringType,
    vectorType: templateVecTypeIdx,
    flatten: strFlattenIdx,
    equals: strEqualsIdx,
    rawLiteral,
  };
}
