// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { createEmptyModule } from "../src/ir/types.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { buildIrOverlayIdentityMaps, planIrOverlayByIdentity } from "../src/codegen/ir-overlay-identity.js";
import { collectPreparedTopLevelFunctionValueTargetUnitIds } from "../src/codegen/ir-prepared-free-functions.js";
import { identifierIsRuntimeFunctionValueReference } from "../src/codegen/ir-overlay-safety.js";

// This is a genuine bound Program/checker/inventory. No oracle stubs, forged
// unit IDs, fabricated allocator objects or TypeNode injection are used.
function fixture(body: string) {
  const fileName = "/__issue7106_apply_demand.ts";
  const source = `function fn() {}\n${body}`;
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    name === fileName
      ? ts.createSourceFile(name, source, languageVersion, true, ts.ScriptKind.TS)
      : originalGetSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([fileName], options, host);
  const sourceFile = program.getSourceFile(fileName)!;
  const checker = program.getTypeChecker();
  const inventory = buildIrUnitInventory([sourceFile], { entrySource: sourceFile });
  const identityContext = buildIrPlanningIdentityContext(inventory);
  const maps = buildIrOverlayIdentityMaps(sourceFile, checker, identityContext);
  const plan = planIrOverlayByIdentity(sourceFile, identityContext, {}, maps);
  const ctx = createCodegenContext(createEmptyModule(), checker, { target: "standalone" });
  const declaration = sourceFile.statements.find(ts.isFunctionDeclaration)!;
  const unitId = identityContext.unitIdByDeclaration.get(declaration)!;
  expect(unitId).toBeDefined();
  const collect = () => collectPreparedTopLevelFunctionValueTargetUnitIds(ctx, sourceFile, plan);
  return { sourceFile, ctx, declaration, unitId, collect };
}

describe("#7106 canonical primitive-apply receiver demand before sealing", () => {
  it.each(["true", "NaN", "'1,2,3'", "Symbol()"])("collects exact owner for original primitive %s", (argument) => {
    const f = fixture(`fn.apply(null, ${argument});`);
    expect([...f.collect()]).toEqual([f.unitId]);
    const call = f.sourceFile.statements[1]!;
    expect(ts.isExpressionStatement(call) && ts.isCallExpression(call.expression)).toBe(true);
    if (!ts.isExpressionStatement(call) || !ts.isCallExpression(call.expression)) throw new Error("call fixture lost");
    const access = call.expression.expression;
    if (!ts.isPropertyAccessExpression(access) || !ts.isIdentifier(access.expression)) throw new Error("receiver lost");
    expect(f.ctx.oracle.valueDeclarationOf(access.expression)).toBe(f.declaration);
    // Generic R2 classification is deliberately unchanged.
    expect(identifierIsRuntimeFunctionValueReference(access.expression)).toBe(false);
  });

  it.each([
    "fn.apply(null, null);",
    "fn.apply(null, undefined);",
    "fn.apply(null, [1, 2]);",
    "fn.call(null, true);",
    "fn.apply(null);",
    "declare const input: unknown; fn.apply(null, input);",
    "const receiver = { apply(a: null, b: boolean) { return b; } }; receiver.apply(null, true);",
    "function outer(fn: () => void) { fn.apply(null, true); }",
  ])("does not add unrelated demand: %s", (body) => {
    expect([...fixture(body).collect()]).toEqual([]);
  });

  it("does not certify a reassigned declaration's cached owner", () => {
    const f = fixture("fn.apply(null, true);");
    // Exercise the actual context guard with the genuine bound declaration.
    // This does not claim to test index.ts's reassignment discovery pass.
    f.ctx.reassignedFunctionDeclarations = new WeakSet([f.declaration]);
    expect([...f.collect()]).toEqual([]);
  });

  it("does not certify a runtime-eval global binding's cached owner", () => {
    const f = fixture("fn.apply(null, true);");
    f.ctx.runtimeEvalGlobalFunctionBindings = true;
    expect([...f.collect()]).toEqual([]);
  });
});
