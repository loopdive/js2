// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBindingId, IrUnitId } from "../ir/identity.js";
import type { IrTypeOverrideMap } from "../ir/integration.js";
import { asVal, irVal, type IrType } from "../ir/nodes.js";
import { IrInvariantError } from "../ir/outcomes.js";
import type { IrLegacyUnitProjection, IrPlanningIdentityContext } from "../ir/planning-identity.js";
import { isExactDynamicStringReplaceNumberParser } from "../ir/dynamic-string-parser-shape.js";
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

declare module "../ir/integration.js" {
  interface IrIntegrationOptions {
    /** Source files participating in one aggregate IR integration. */
    readonly integrationSourceFiles?: readonly ts.SourceFile[];
    /** Withdraw every terminal when any member of the aggregate fails. */
    readonly atomicComponent?: boolean;
    /** Exact non-source bindings included in the component seal. */
    readonly preparedBindingIdsByTerminalUnitId?: ReadonlyMap<IrUnitId, ReadonlySet<IrBindingId>>;
  }
}

export function resolveIntegrationSourceFiles(
  representative: ts.SourceFile,
  configured: readonly ts.SourceFile[] | undefined,
): readonly ts.SourceFile[] {
  const sourceFiles = configured ?? [representative];
  if (sourceFiles.length === 0 || !sourceFiles.includes(representative)) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      "ir/integration: representative source file is not part of the integration source population",
    );
  }
  return sourceFiles;
}

export function collectIntegrationFunctionDeclarations(
  sourceFiles: readonly ts.SourceFile[],
): ReadonlyMap<string, ts.FunctionDeclaration> {
  const declarations = new Map<string, ts.FunctionDeclaration>();
  for (const sourceFile of sourceFiles) {
    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) declarations.set(statement.name.text, statement);
    }
  }
  return declarations;
}

export function makeMultiSourceOverrideResolvers(input: {
  readonly ctx: CodegenContext;
  readonly overrides: IrTypeOverrideMap | undefined;
  readonly identityContext: IrPlanningIdentityContext;
  readonly ownerProjection: IrLegacyUnitProjection;
  readonly declarationsByName: ReadonlyMap<string, ts.FunctionDeclaration>;
  readonly definedFunctionAt: (funcIdx: number) => { readonly typeIdx: number } | undefined;
}): {
  readonly implicitParamUsesNumericVecAbi: (parameter: ts.ParameterDeclaration) => boolean;
  readonly effectiveOverride: (
    name: string,
  ) => { readonly params: readonly IrType[]; readonly returnType: IrType | null } | undefined;
} {
  const implicitParamUsesNumericVecAbi = (parameter: ts.ParameterDeclaration): boolean => {
    if (parameter.type || !input.overrides || !ts.isFunctionDeclaration(parameter.parent)) return false;
    const declaration = parameter.parent;
    const index = declaration.parameters.indexOf(parameter);
    const unitId = input.identityContext.unitIdByDeclaration.get(declaration);
    const name = unitId ? input.ownerProjection.getByUnitId(unitId)?.legacyName : declaration.name?.text;
    const expected = index < 0 || !name ? undefined : input.overrides.get(name)?.params[index];
    const valueType = expected ? asVal(expected) : null;
    return (
      (valueType?.kind === "ref" || valueType?.kind === "ref_null") &&
      input.ctx.typeIdxToStructName.get(valueType.typeIdx) === "__vec_f64"
    );
  };
  const effectiveOverride = (name: string) => {
    const override = input.overrides?.get(name);
    const projected = input.ownerProjection.getByLegacyName(name);
    const declaration = projected
      ? input.identityContext.declarationByUnitId.get(projected.unitId)
      : input.declarationsByName.get(name);
    const functionDeclaration = declaration && ts.isFunctionDeclaration(declaration) ? declaration : undefined;
    const legacyFuncIdx = input.ctx.funcMap.get(name);
    const legacyFunction = legacyFuncIdx === undefined ? undefined : input.definedFunctionAt(legacyFuncIdx);
    const legacySignature = legacyFunction === undefined ? undefined : input.ctx.mod.types[legacyFunction.typeIdx];
    const legacySecondParam = legacySignature?.kind === "func" ? legacySignature.params[1] : undefined;
    if (
      !override ||
      !functionDeclaration ||
      override.params[1]?.kind !== "dynamic" ||
      legacySecondParam?.kind !== "i32" ||
      legacySecondParam.boolean !== true ||
      !isExactDynamicStringReplaceNumberParser(functionDeclaration)
    ) {
      return override;
    }
    const params = [...override.params];
    params[1] = irVal({ kind: "i32", boolean: true });
    return { params, returnType: override.returnType };
  };
  return { implicitParamUsesNumericVecAbi, effectiveOverride };
}
