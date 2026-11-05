// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";
import { hostFreeEnvironment, type CodegenContext } from "../context/types.js";
import { legacyParamSlotIsExternref } from "../fnctor-typed-instances.js";

/** The physical slot, not an any annotation alone, proves the dynamic ABI. */
export function parameterHasDynamicExternrefAbi(
  ctx: CodegenContext,
  parameter: ts.ParameterDeclaration,
  isJsDocProjection: (parameter: ts.ParameterDeclaration) => boolean,
): boolean {
  return (
    (isJsDocProjection(parameter) ||
      (!ctx.fast && hostFreeEnvironment(ctx) && parameter.type?.kind === ts.SyntaxKind.AnyKeyword)) &&
    legacyParamSlotIsExternref(ctx, parameter)
  );
}

/** Native dynamic selection and prepared signatures share one carrier policy. */
export function nativeDynamicExternrefAvailable(ctx: CodegenContext): boolean {
  return !ctx.fast && (ctx.standalone || ctx.wasi) && hostFreeEnvironment(ctx);
}

export function nativeDynamicSelectionOptions(ctx: CodegenContext) {
  const available = nativeDynamicExternrefAvailable(ctx);
  return { nativeDynamicInBuildable: available, nativeDynamicExternrefBuildable: available };
}
