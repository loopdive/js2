// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";
import { lowerFunctionAstToIr, type IrFromAstResolver } from "../../ir/from-ast.js";
import { collectIrDirectCallLoweringPlans, type IrDirectCallTarget } from "../../ir/ast-lowering-plans.js";
import type { AllocSiteRegistry } from "../../ir/alloc-registry.js";
import type { IrFunction } from "../../ir/core/nodes.js";
import { irTypeEquals } from "../../ir/core/types.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import { irBindingKey } from "../../ir/declared-types.js";
import { constantFold } from "../../ir/passes/constant-fold.js";
import { deadCode } from "../../ir/passes/dead-code.js";
import { simplifyCFG } from "../../ir/passes/simplify-cfg.js";
import { verifyIrFunction } from "../../ir/verify.js";
import type { SelfHostedFuncDef } from "./contracts.js";

export interface SelfHostedIrBuildInput {
  readonly definition: SelfHostedFuncDef;
  readonly ownerUnitId: IrUnitId;
  readonly callees: ReadonlyMap<string, IrDirectCallTarget>;
  readonly resolver?: IrFromAstResolver;
  readonly allocRegistry?: AllocSiteRegistry;
}

/** Canonical parse/lower/verify/hygiene kernel; no cache or physical context. */
export function buildSelfHostedIrBody(input: SelfHostedIrBuildInput): IrFunction {
  const def = input.definition;
  const unitId = input.ownerUnitId;
  const sourceFile = ts.createSourceFile(
    `stdlib/${def.name}.ts`,
    def.source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const fnDecl = sourceFile.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === def.name,
  );
  if (!fnDecl) {
    throw new Error(`stdlib-selfhost: source for ${def.name} has no matching function declaration`);
  }
  if (fnDecl.parameters.length !== def.paramTypes.length) {
    throw new Error(
      `stdlib-selfhost: ${def.name} declares ${fnDecl.parameters.length} params but paramTypes has ${def.paramTypes.length}`,
    );
  }

  const supplied = [...input.callees];
  const expected = [...def.calleeTypes];
  if (
    supplied.length !== expected.length ||
    expected.some(([name, signature], index) => {
      const entry = supplied[index];
      return (
        entry === undefined ||
        entry[0] !== name ||
        entry[1].signature.params.length !== signature.params.length ||
        signature.params.some((type, ordinal) => !irTypeEquals(type, entry[1].signature.params[ordinal]!)) ||
        (signature.returnType === null
          ? entry[1].signature.returnType !== null
          : entry[1].signature.returnType === null ||
            !irTypeEquals(signature.returnType, entry[1].signature.returnType))
      );
    })
  )
    throw new Error(`stdlib-selfhost: callee declarations disagree for ${def.name}`);

  const { main, lifted } = lowerFunctionAstToIr(fnDecl, {
    ownerUnitId: unitId,
    funcName: def.name,
    exported: false,
    calleeTypes: def.calleeTypes,
    directCalls: collectIrDirectCallLoweringPlans(fnDecl, unitId, input.callees),
    paramTypeOverrides: def.paramTypes,
    returnTypeOverride: def.returnType,
    resolver: input.resolver,
    allocRegistry: input.allocRegistry,
  });
  if (lifted.length > 0) {
    throw new Error(`stdlib-selfhost: ${def.name} unexpectedly produced ${lifted.length} lifted functions`);
  }

  const declarations = {
    declaredSignatures: new Map(
      [...input.callees.values()].map(({ target, signature }) => {
        const key = irBindingKey(target.binding);
        if (key === null) throw new Error(`stdlib-selfhost: invalid callee binding for ${def.name}`);
        return [key, { params: signature.params, result: signature.returnType }] as const;
      }),
    ),
  };
  const buildErrors = verifyIrFunction(main, undefined, declarations);
  if (buildErrors.length > 0) {
    throw new Error(`stdlib-selfhost: IR verify failed for ${def.name}: ${buildErrors[0]!.message}`);
  }

  // Same hygiene pipeline integration.ts runs (constantFold → deadCode →
  // simplifyCFG to fixpoint; each pass returns the same reference when it
  // makes no change).
  let ir = main;
  for (let iter = 0; iter < 10; iter++) {
    const next = simplifyCFG(deadCode(constantFold(ir)));
    if (next === ir) break;
    ir = next;
  }

  const postErrors = verifyIrFunction(ir, undefined, declarations);
  if (postErrors.length > 0) {
    throw new Error(`stdlib-selfhost: post-pass IR verify failed for ${def.name}: ${postErrors[0]!.message}`);
  }

  return ir;
}
