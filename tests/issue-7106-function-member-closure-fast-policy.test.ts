// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it, vi } from "vitest";
import { ts } from "../src/ts-api.js";
import { analyzeSource } from "../src/checker/index.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { makeIrIdentityImportedFunctionResolver } from "../src/ir/imported-functions.js";
import { createEmptyModule } from "../src/ir/types.js";
import { irVal } from "../src/ir/nodes.js";
import { irTypeBindingKey } from "../src/ir/abi-bindings.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { computeClosureWrapperSig } from "../src/codegen/closures.js";
import { resolveIrDynamicCarrierType } from "../src/codegen/any-helpers.js";
import { makeIrFunctionMemberClosures } from "../src/codegen/function-member-closure-planning.js";

// Exact 169-byte guest from the separate failed FAST baseline/candidate A/B.
// This file tests the producer boundary; it does not execute that guest or
// claim the inherited legacy FAST illegal-cast is fixed.
const SOURCE = `function subject(): number { return 0; }
      export function run(): number { subject.equal = function (a, b) { return a === b; }; return subject.equal(1, 1) ? 1 : 0; }`;
const OPTIONS_ORIGIN = {
  target: "standalone",
  skipSemanticDiagnostics: true,
  trackIrOutcomes: true,
  deferTopLevelInit: true,
} as const;
function boundProducer(fast: boolean) {
  const ast = analyzeSource(SOURCE, "issue-7106-fast-member-rhs-policy.ts");
  expect(ast.program.getTypeChecker()).toBe(ast.checker);
  expect(ast.program.getSourceFile(ast.sourceFile.fileName)).toBe(ast.sourceFile);
  const identity = buildIrPlanningIdentityContext(
    buildIrUnitInventory([ast.sourceFile], { entrySource: ast.sourceFile }),
  );
  const run = ast.sourceFile.statements.find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "run",
  );
  const first = run?.body?.statements[0];
  if (
    !first ||
    !ts.isExpressionStatement(first) ||
    !ts.isBinaryExpression(first.expression) ||
    !ts.isFunctionExpression(first.expression.right)
  )
    throw new Error("exact RHS source fixture lost");
  const rhs = first.expression.right;
  const sourceUnitId = identity.unitIdByDeclaration.get(rhs);
  const ownerUnitId = identity.unitIdByDeclaration.get(run!);
  expect(sourceUnitId).toBeDefined();
  expect(ownerUnitId).toBeDefined();
  expect(identity.unitByUnitId.get(sourceUnitId!)?.terminalOwnerId).toBe(ownerUnitId);
  // Same target/options origin, normalized through the real context constructor.
  // No synthetic physical signature, fake carrier, source annotation or plan.
  const ctx = createCodegenContext(createEmptyModule(), ast.checker, { ...OPTIONS_ORIGIN, fast });
  expect(ctx.fast).toBe(fast);
  const resolver = makeIrIdentityImportedFunctionResolver(ast.checker, [ast.sourceFile], identity);
  const computeSignature = vi.fn((expression: ts.FunctionExpression) => computeClosureWrapperSig(ctx, expression));
  const dynamicCarrierIsExternref = vi.fn(() => resolveIrDynamicCarrierType(ctx).kind === "externref");
  const producer = makeIrFunctionMemberClosures(ctx, identity, resolver, {
    computeSignature,
    dynamicCarrierIsExternref,
    valueType: irVal,
    typeBindingKey: irTypeBindingKey,
  });
  return { producer, rhs, sourceUnitId, ownerUnitId, computeSignature, dynamicCarrierIsExternref };
}

it("refuses the authentic FAST source RHS before canonical signature/carrier services", () => {
  const actual = boundProducer(true);
  expect(actual.producer.resolve(actual.rhs)).toBeUndefined();
  // Repeating the same refusal cannot install a cached accepted plan.
  expect(actual.producer.resolve(actual.rhs)).toBeUndefined();
  expect(actual.computeSignature).not.toHaveBeenCalled();
  expect(actual.dynamicCarrierIsExternref).not.toHaveBeenCalled();
});

it("accepts the identical source as a current genuine externref producer positive", () => {
  const actual = boundProducer(false);
  const plan = actual.producer.resolve(actual.rhs);
  expect(plan).toBeDefined();
  if (!plan) throw new Error("genuine non-FAST positive was not planned");
  expect(plan.expression).toBe(actual.rhs);
  expect(plan.sourceUnitId).toBe(actual.sourceUnitId);
  expect(plan.ownerUnitId).toBe(actual.ownerUnitId);
  expect(plan.signature.params).toEqual([
    { kind: "val", val: { kind: "externref" } },
    { kind: "val", val: { kind: "externref" } },
  ]);
  expect(plan.signature.returnType).toEqual({ kind: "val", val: { kind: "i32", boolean: true } });
  expect(plan.isCurrent()).toBe(true);
  expect(actual.producer.resolve(actual.rhs)).toBe(plan);
  expect(actual.computeSignature).toHaveBeenCalled();
  expect(actual.dynamicCarrierIsExternref).toHaveBeenCalled();
});
