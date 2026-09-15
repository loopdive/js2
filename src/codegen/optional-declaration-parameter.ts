// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { nativeTypeOfDeclaration } from "./native-type-annotations.js";

/** Shared declaration/body-wrapper ABI for an optional scalar without a default. */
export function preserveOptionalDeclarationParameter(
  ctx: CodegenContext,
  parameter: ts.ParameterDeclaration,
  type: ValType,
): ValType {
  const jsdocType = ts.getJSDocType(parameter);
  const optional =
    parameter.questionToken !== undefined ||
    (parameter.type !== undefined &&
      ts.isUnionTypeNode(parameter.type) &&
      parameter.type.types.some((type) => type.kind === ts.SyntaxKind.UndefinedKeyword)) ||
    (jsdocType !== undefined && ts.isJSDocOptionalType(jsdocType)) ||
    ts.getJSDocParameterTags(parameter).some((tag) => tag.isBracketed === true);
  return parameter.initializer === undefined &&
    optional &&
    (type.kind === "f64" || (type.kind === "i32" && type.boolean === true)) &&
    nativeTypeOfDeclaration(ctx.oracle, parameter) === null
    ? { kind: "externref" }
    : type;
}
