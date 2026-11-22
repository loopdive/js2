// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// The body producer of `prepareIrProgramSources`: one terminal unit (a function declaration or a script's module-init)
// lowered from its AST and legalized, against the program-wide plans the producer prepared before any body.

import { ts } from "../ts-api.js";
import { sourceBooleanAnyResult, assertSourceBooleanAnyReturns } from "../frontend/boolean-return-boundary.js";
import { checkerAny, checkerScalar, type ProgramDynamicContracts } from "./source-dynamic-contracts.js";
import type { TypeOracle } from "../checker/oracle.js";
import type { AllocSiteRegistry } from "./analysis/alloc-registry.js";
import { lowerFunctionAstToIr, type IrFromAstResolver, type IrFunctionSourceMapContext } from "./from-ast.js";
import type { IrUnitId } from "../shared/contracts/ir-identity.js";
import type { IrUnitInventory } from "../shared/contracts/ir-unit-inventory.js";
import type { buildIrPlanningIdentityContext } from "./planning-identity.js";
import { makeModuleInitSynthetic } from "./module-init.js";
import type { IrModuleBindingIdentity } from "./module-bindings.js";
import type { IrDirectCallLoweringPlan, ModuleBindingGlobal } from "./ast-lowering-plans.js";
import type { PreparedIrFunction as IrFunction } from "./runtime/contracts/prepared.js";
import type { IrType } from "./core/types.js";
import { demoteToLegacy } from "./outcomes.js";
import type { AbortBodies } from "./abort-bodies.js";
import { PreparedIrProgramInvariantError } from "./program/errors.js";
import type { RuntimeManifestPolicy } from "../runtime/contracts/provider-policy.js";
import type { FunctionValueGlobal } from "./function-declaration-values.js";
import type { SourceClosureInvocationPlan } from "./source-closure-invocation.js";
import { prepareOrdinaryObjectAccessResolver } from "../frontend/builtins/prepare-ordinary-object-access.js";
import { prepareConversionResolvers } from "../frontend/builtins/prepare-number-conversion.js";
import { prepareObjectCreateResolver } from "../frontend/builtins/prepare-object-create.js";
import { prepareNativeStringOutputResolver } from "../frontend/builtins/prepare-string-output.js";
import type { NativeAsyncSourceFamilies } from "./program-native-async-source.js";
import type { IrPromiseDelayLoweringPlan, IrPromiseDelayLoweringPlans } from "./promise-delay-lowering.js";

type TerminalUnit = IrUnitInventory["terminalUnits"][number];

/** What the producer prepared before any body. */
export interface SourceUnitLowering {
  readonly input: {
    readonly checker: ts.TypeChecker;
    readonly oracle?: TypeOracle;
    readonly policy: RuntimeManifestPolicy;
    readonly sourceFiles: readonly ts.SourceFile[];
  };
  readonly identity: ReturnType<typeof buildIrPlanningIdentityContext>;
  readonly allocations: AllocSiteRegistry;
  readonly dynamicContracts: ProgramDynamicContracts;
  readonly signatures: ReadonlyMap<IrUnitId, { readonly params: readonly IrType[] }>;
  readonly bodyResults: ReadonlyMap<IrUnitId, IrType | null>;
  readonly globals: readonly {
    readonly binding: ModuleBindingGlobal;
    readonly identity: IrModuleBindingIdentity | FunctionValueGlobal["identity"];
  }[];
  readonly globalByDeclaration: ReadonlyMap<ts.Declaration, SourceUnitLowering["globals"][number]>;
  readonly postStartupUnits: ReadonlySet<IrUnitId>;
  readonly exportedUnits: ReadonlySet<IrUnitId>;
  readonly closureInvocations: ReadonlyMap<ts.CallExpression, SourceClosureInvocationPlan>;
  readonly closureCallableParameters: ReadonlySet<ts.Node | undefined>;
  readonly functionValues: ReturnType<NonNullable<IrFromAstResolver["moduleInitFunctionValues"]>>;
  readonly directCalls: ReadonlyMap<ts.CallExpression, IrDirectCallLoweringPlan>;
  readonly nativeFamily: NativeAsyncSourceFamilies | undefined;
  readonly nativeStringValues: boolean;
  readonly nativeStringOutput: boolean;
  /** The native Promise-delay plans by source, when that projection is selected. */
  readonly promiseDelaysBySource: ReadonlyMap<ts.SourceFile, IrPromiseDelayLoweringPlans> | undefined;
  readonly certifiedDelays: ReadonlyMap<IrUnitId, IrPromiseDelayLoweringPlan>;
  /** The source-map context of a unit's body, when a source map is captured. */
  readonly sourceMap: ((unit: TerminalUnit) => IrFunctionSourceMapContext) | undefined;
  /** (#7354 U) The `unlowerableBodies` policy, when switched on. */
  readonly abortBodies: AbortBodies | undefined;
}

type LoweredSourceUnit = {
  readonly lowered: ReturnType<typeof lowerFunctionAstToIr>;
  readonly functions: readonly IrFunction[];
};

/** `unit`'s body lowered from its AST, and its functions legalized. */
export function lowerSourceUnit(lowering: SourceUnitLowering, unit: TerminalUnit): LoweredSourceUnit {
  const { identity, nativeFamily } = lowering;
  const family = nativeFamily?.functions.get(unit.id);
  if (family) nativeFamily!.assertCurrent(unit.id);
  // A native async family's or a certified Promise-delay's frame is planned around the bodies it holds.
  const abortBodies = family || lowering.certifiedDelays.has(unit.id) ? undefined : lowering.abortBodies;
  if (!abortBodies) return lowerUnitOnce(lowering, unit, family, undefined);
  // A script's module-init has no declaration: a refusal no function inside it owns stays the program's.
  const result = abortBodies.lower(lowering.allocations, identity.declarationByUnitId.get(unit.id), () =>
    lowerUnitOnce(lowering, unit, family, abortBodies),
  );
  abortBodies.report(result.functions, (id) => identity.declarationByUnitId.get(id));
  return result;
}

function lowerUnitOnce(
  lowering: SourceUnitLowering,
  unit: TerminalUnit,
  family: ReturnType<NativeAsyncSourceFamilies["functions"]["get"]>,
  abortBodies: AbortBodies | undefined,
): LoweredSourceUnit {
  const { input, identity, dynamicContracts } = lowering;
  const resolveBinding = (node: ts.Identifier, writeValue?: ts.Expression): ModuleBindingGlobal | undefined => {
    let symbol = input.checker.getSymbolAtLocation(node);
    if (!symbol) return undefined;
    const imported = (symbol.flags & ts.SymbolFlags.Alias) !== 0;
    if (imported) symbol = input.checker.getAliasedSymbol(symbol);
    const declaration = symbol.valueDeclaration;
    const global = declaration ? lowering.globalByDeclaration.get(declaration) : undefined;
    if (!global) return undefined;
    if (writeValue && (imported || !global.identity.mutable))
      demoteToLegacy("type-resolution-unsupported", `write to immutable module binding ${node.text}`);
    return {
      ...global.binding,
      ownerUnitId: unit.id,
      ...(lowering.postStartupUnits.has(unit.id) ? { omitTdzReadCheck: true as const } : {}),
    };
  };
  const resolver: IrFromAstResolver = {
    sourceClosureInvocation: (expression) => lowering.closureInvocations.get(expression),
    sourceClosureCallableParameter: (node) => lowering.closureCallableParameters.has(node),
    resolveModuleBinding: resolveBinding,
    moduleInitFunctionValues: () => lowering.functionValues,
    preparedAsyncAwaitSite: (awaitExpression) => {
      const host = input.policy.backend === "wasmgc" && input.policy.target === "host";
      const resultType =
        (host ? checkerAny(input.checker, awaitExpression) : undefined) ??
        checkerScalar(input.checker, awaitExpression);
      const operandType = (host ? checkerAny(input.checker, awaitExpression.expression) : undefined) ??
        checkerScalar(input.checker, awaitExpression.expression) ?? {
          kind: "val" as const,
          val: { kind: "externref" as const },
        };
      return resultType ? { resultType, operandType } : null;
    },
    ...family?.resolver,
    ...dynamicContracts.resolver,
    ...(abortBodies ? { abortedBody: (fn) => abortBodies.has(fn) } : {}),
  };
  const source = identity.sourceFileBySourceId.get(unit.sourceId)!;
  const moduleInit = unit.kind === "module-init";
  const declaration = moduleInit
    ? makeModuleInitSynthetic(identity.moduleInitPopulationBySourceFile.get(source) ?? [])
    : identity.declarationByUnitId.get(unit.id)!;
  if (!ts.isFunctionDeclaration(declaration))
    demoteToLegacy("type-resolution-unsupported", `missing declaration producer for ${unit.kind}`);
  const sourceRoots = moduleInit ? (identity.moduleInitPopulationBySourceFile.get(source) ?? []) : declaration;
  Object.assign(resolver, prepareSourceBuiltinResolvers(input, sourceRoots, dynamicContracts.carries));
  const signature = lowering.signatures.get(unit.id);
  const lowered = lowerFunctionAstToIr(declaration, {
    booleanReturnBoundary: sourceBooleanAnyResult(input.checker, declaration) ? declaration : undefined,
    ownerUnitId: unit.id,
    ...(lowering.sourceMap === undefined ? {} : { sourceMap: lowering.sourceMap(unit) }),
    funcName: unit.displayName,
    exported: lowering.exportedUnits.has(unit.id),
    ...dynamicContracts.codeStrictness(moduleInit ? source : declaration),
    identityContext: identity,
    checker: input.checker,
    oracle: input.oracle,
    allocRegistry: lowering.allocations,
    directCalls: lowering.directCalls,
    resolver:
      lowering.nativeStringOutput && !family
        ? { ...resolver, ...prepareNativeStringOutputResolver(input.checker, declaration) }
        : resolver,
    ...(lowering.nativeStringValues ? { stringNumericCoercion: "number-boundary" as const } : {}),
    numericThrow: "number-boundary",
    unselected: true,
    ...(lowering.promiseDelaysBySource ? { promiseDelays: lowering.promiseDelaysBySource.get(source) } : {}),
    ...(family ? { logicalVectorTypes: family.logicalVectorTypes } : {}),
    ...(moduleInit
      ? {
          moduleInitUnit: true,
          returnTypeOverride: null,
          moduleBindings: new Map(
            lowering.globals
              .filter((global) => global.identity.sourceId === unit.sourceId)
              .map((global) => [global.binding.globalName, { ...global.binding, ownerUnitId: unit.id }]),
          ),
        }
      : { paramTypeOverrides: signature!.params, returnTypeOverride: lowering.bodyResults.get(unit.id)! }),
    numericLocalScalarForDecl: (declaration) =>
      checkerScalar(input.checker, declaration)?.kind === "val" &&
      (input.checker.getTypeAtLocation(declaration).flags & ts.TypeFlags.NumberLike) !== 0
        ? "number"
        : undefined,
  });
  assertSourceBooleanAnyReturns(input.checker, declaration, lowered.main);
  if (
    lowering.certifiedDelays.has(unit.id) &&
    (lowered.lifted.length !== 0 || lowered.liftedUnitProvenance.length !== 0)
  )
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      `certified native Promise-delay ${unit.id} fabricated support bodies or provenance`,
    );
  const functions = dynamicContracts.legalize(sourceRoots, [lowered.main, ...lowered.lifted], {
    declarationOf: (id) => identity.declarationByUnitId.get(id),
    aborted: (fn) => abortBodies?.has(fn) === true,
  });
  return { lowered, functions };
}

/** Combine source-owned call/read plans; no physical provider is selected here. */
function prepareSourceBuiltinResolvers(
  input: SourceUnitLowering["input"],
  roots: ts.FunctionDeclaration | readonly ts.Statement[],
  carries: (expression: ts.Expression) => boolean,
) {
  return {
    ...prepareConversionResolvers(input.checker, input.sourceFiles, roots),
    ...prepareOrdinaryObjectAccessResolver(input.checker, input.sourceFiles, roots, carries),
    ...(input.policy.target === "standalone" && input.policy.backend === "wasmgc"
      ? prepareObjectCreateResolver(input.checker, input.sourceFiles, roots)
      : {}),
  };
}
