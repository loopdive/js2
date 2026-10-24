// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it, vi } from "vitest";
import { ts } from "../src/ts-api.js";
import { compile } from "../src/index.js";
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

// A real bound Program/checker/inventory/context. Negative fault injections
// only reuse its actual AST nodes and source units, and always restore them.
function fixture(prefix = false) {
  const fileName = "/__issue7106_member_rhs_currentness.ts";
  const text = `function subject(): number { return 0; }
    function other(): number { return 1; }
    subject.equal = function (a, b) { return ${prefix ? "!(a === b)" : "a === b"}; };
    other.equal = function (c, d) { return c === d; };`;
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, onError, shouldCreateNewSourceFile) =>
    name === fileName
      ? ts.createSourceFile(name, text, version, true, ts.ScriptKind.TS)
      : originalGetSourceFile(name, version, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([fileName], options, host);
  const sourceFile = program.getSourceFile(fileName)!;
  const checker = program.getTypeChecker();
  const identity = buildIrPlanningIdentityContext(buildIrUnitInventory([sourceFile], { entrySource: sourceFile }));
  const ctx = createCodegenContext(createEmptyModule(), checker, { target: "standalone" });
  const resolver = makeIrIdentityImportedFunctionResolver(checker, [sourceFile], identity);
  const assignments = sourceFile.statements.filter(ts.isExpressionStatement).map((statement) => statement.expression);
  const first = assignments[0];
  const second = assignments[1];
  if (
    !first ||
    !second ||
    !ts.isBinaryExpression(first) ||
    !ts.isBinaryExpression(second) ||
    !ts.isFunctionExpression(first.right) ||
    !ts.isFunctionExpression(second.right) ||
    !ts.isPropertyAccessExpression(first.left) ||
    !ts.isPropertyAccessExpression(second.left) ||
    !ts.isIdentifier(first.left.expression) ||
    !ts.isIdentifier(second.left.expression)
  )
    throw new Error("source fixture lost");
  const rhs = first.right;
  const secondRhs = second.right;
  const receiver = first.left.expression;
  const actualTarget = resolver.resolveTopLevelFunctionValueTarget(receiver)!;
  const otherActualTarget = resolver.resolveTopLevelFunctionValueTarget(second.left.expression)!;
  expect(actualTarget.targetUnitId).not.toBe(otherActualTarget.targetUnitId);
  const signature = vi.fn((expression: ts.FunctionExpression) => computeClosureWrapperSig(ctx, expression));
  const carrier = vi.fn(() => resolveIrDynamicCarrierType(ctx).kind === "externref");
  const source = makeIrFunctionMemberClosures(ctx, identity, resolver, {
    computeSignature: signature,
    dynamicCarrierIsExternref: carrier,
    valueType: irVal,
    typeBindingKey: irTypeBindingKey,
  });
  const plan = source.resolve(rhs);
  expect(plan).toBeDefined();
  if (!plan) throw new Error("genuine positive source was not certified");
  expect(plan.isCurrent()).toBe(true);
  const resetCalls = () => {
    signature.mockClear();
    carrier.mockClear();
  };
  const expectNoAbiService = () => {
    expect(signature).not.toHaveBeenCalled();
    expect(carrier).not.toHaveBeenCalled();
  };
  return {
    first,
    second,
    rhs,
    secondRhs,
    receiver,
    plan,
    resolver,
    actualTarget,
    otherActualTarget,
    resetCalls,
    expectNoAbiService,
  };
}

describe("#7106 exact member RHS currentness before canonical services", () => {
  it("retains the authentic same-source current plan", () => {
    expect(fixture().plan.isCurrent()).toBe(true);
  });

  it("refuses transplanting the same RHS node to another assignment in the same terminal", () => {
    const f = fixture();
    const originalParent = f.rhs.parent;
    const originalRight = f.second.right;
    f.resetCalls();
    try {
      Reflect.set(f.rhs, "parent", f.second);
      Reflect.set(f.second, "right", f.rhs);
      expect(f.plan.isCurrent()).toBe(false);
      f.expectNoAbiService();
    } finally {
      Reflect.set(f.rhs, "parent", originalParent);
      Reflect.set(f.second, "right", originalRight);
    }
    expect(f.plan.isCurrent()).toBe(true);
  });

  it("refuses a captured assignment whose RHS was replaced", () => {
    const f = fixture();
    const originalRight = f.first.right;
    f.resetCalls();
    try {
      Reflect.set(f.first, "right", f.secondRhs);
      expect(f.plan.isCurrent()).toBe(false);
      f.expectNoAbiService();
    } finally {
      Reflect.set(f.first, "right", originalRight);
    }
    expect(f.plan.isCurrent()).toBe(true);
  });

  it("refuses an in-place prefix operator change before cached oracle or ABI queries", () => {
    const f = fixture(true);
    const statement = f.rhs.body.statements[0];
    if (
      !statement ||
      !ts.isReturnStatement(statement) ||
      !statement.expression ||
      !ts.isPrefixUnaryExpression(statement.expression)
    )
      throw new Error("actual prefix fixture lost");
    const expression = statement.expression;
    const originalOperator = expression.operator;
    expect(originalOperator).toBe(ts.SyntaxKind.ExclamationToken);
    f.resetCalls();
    try {
      Reflect.set(expression, "operator", ts.SyntaxKind.PlusToken);
      expect(f.plan.isCurrent()).toBe(false);
      f.expectNoAbiService();
    } finally {
      Reflect.set(expression, "operator", originalOperator);
    }
    expect(f.plan.isCurrent()).toBe(true);
  });

  it("refuses a changed unit behind the real target resolver before ABI work", () => {
    const f = fixture();
    // Corrupt one real resolver result using another actual source unit ID.
    // The mismatched pair is negative fault data, never accepted authority.
    const spy = vi.spyOn(f.resolver, "resolveTopLevelFunctionValueTarget").mockReturnValue({
      ...f.actualTarget,
      targetUnitId: f.otherActualTarget.targetUnitId,
    });
    f.resetCalls();
    try {
      expect(f.plan.isCurrent()).toBe(false);
      f.expectNoAbiService();
    } finally {
      spy.mockRestore();
    }
    expect(f.plan.isCurrent()).toBe(true);
  });
});

it("emits actual parameter binding scaffolds with source maps enabled", async () => {
  const result = await compile(
    `function subject(): number { return 0; }
    subject.equal = function (a, b) { return a === b; };
    export function run(): number { return subject.equal(1, 1) ? 1 : 0; }`,
    {
      target: "standalone",
      sourceMap: true,
      skipSemanticDiagnostics: true,
      trackIrOutcomes: true,
      deferTopLevelInit: true,
    },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(typeof result.sourceMap).toBe("string");
  for (const name of ["<module-init>", "run"]) {
    const row = result.irOutcomes?.find((entry) => entry.displayName === name);
    expect(row, JSON.stringify(result.irOutcomes)).toMatchObject({
      kind: "emitted",
      irBodyEmitted: true,
      legacyBodyEmitted: false,
      directBodyEmissions: 0,
      preparedComponentId: expect.any(String),
    });
    expect(row).not.toHaveProperty("r2Withdrawal");
  }
  expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  expect(typeof instance.exports.__module_init).toBe("function");
  (instance.exports.__module_init as () => void)();
  expect((instance.exports.run as () => number)()).toBe(1);
}, 35_000);
