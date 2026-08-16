// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import ts from "typescript";

import { analyzeSource } from "../src/checker/index.js";
import { compile, type IrObservedOutcome } from "../src/index.js";
import { collectIrDirectCallLoweringPlans } from "../src/ir/ast-lowering-plans.js";
import { irUnitFuncRef } from "../src/ir/callable-bindings.js";
import { lowerFunctionAstToIr, type IrFromAstResolver } from "../src/ir/from-ast.js";
import type { IrClassShape, IrType } from "../src/ir/nodes.js";
import { classifyIrFailure, evaluateIrOutcomePolicy, type IrUnsupportedCode } from "../src/ir/outcomes.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";
import { createTestIrClassId, createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const F64: IrType = { kind: "val", val: { kind: "f64" } };
const EXTERNREF: IrType = { kind: "val", val: { kind: "externref" } };
const irIdentities = createTestIrFunctionIdentityFactory("issue-3529-dataflow-outcomes");

function terminalFor(result: Awaited<ReturnType<typeof compile>>, displayName = "test"): IrObservedOutcome {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const outcome = result.irOutcomes?.find((candidate) => candidate.displayName === displayName);
  expect(outcome, `missing terminal outcome for ${displayName}`).toBeDefined();
  return outcome!;
}

async function expectBuildUnsupported(source: string, code: IrUnsupportedCode): Promise<void> {
  const result = await compile(source, { fileName: `${code}.ts`, trackIrOutcomes: true });
  const outcome = terminalFor(result);
  expect(outcome).toMatchObject({
    kind: "unsupported",
    code,
    stage: "build",
    legacyBodyEmitted: true,
    irBodyEmitted: false,
  });
  expect(evaluateIrOutcomePolicy([outcome], "hybrid").ready).toBe(true);
  expect(evaluateIrOutcomePolicy([outcome], "ir-only").ready).toBe(false);
}

function directDeclaration(source: string): ts.FunctionDeclaration {
  const ast = analyzeSource(source, "direct-string-method.ts");
  const declaration = ast.sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "test",
  );
  expect(declaration).toBeDefined();
  return declaration!;
}

function lowerDirect(source: string): void {
  lowerFunctionAstToIr(directDeclaration(source), {
    ownerUnitId: irIdentities.next("test").unitId,
    exported: true,
  });
}

function expectLowerInvariant(
  source: string,
  calleeTypes: ReadonlyMap<string, { params: readonly IrType[]; returnType: IrType | null }>,
  resolver?: IrFromAstResolver,
): void {
  const ast = analyzeSource(source, "producer-seam-invariant.ts");
  const declaration = ast.sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "test",
  );
  expect(declaration).toBeDefined();
  const ownerIdentity = irIdentities.next("test");
  const directCalls = collectIrDirectCallLoweringPlans(
    declaration!,
    ownerIdentity.unitId,
    new Map(
      [...calleeTypes].map(([calleeName, signature]) => [
        calleeName,
        { target: irUnitFuncRef(irIdentities.next(`callee:${calleeName}`)), signature },
      ]),
    ),
  );

  let thrown: unknown;
  try {
    lowerFunctionAstToIr(declaration!, {
      ownerUnitId: ownerIdentity.unitId,
      exported: true,
      checker: ast.checker,
      directCalls,
      resolver,
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  const outcome = classifyIrFailure(thrown, "build");
  expect(outcome).toMatchObject({
    kind: "invariant",
    code: "unexpected-internal-throw",
    stage: "build",
  });
  const observed: IrObservedOutcome = {
    key: "producer-seam-invariant::function::test#0",
    file: "producer-seam-invariant.ts",
    unitKind: "function",
    displayName: "test",
    ordinal: 0,
    line: 1,
    column: 1,
    backend: "wasmgc",
    target: "gc",
    legacyBodyEmitted: true,
    irBodyEmitted: false,
    ...outcome,
  };
  expect(evaluateIrOutcomePolicy([observed], "hybrid").ready).toBe(false);
  expect(evaluateIrOutcomePolicy([observed], "ir-only").ready).toBe(false);
}

/**
 * Sibling of {@link expectLowerInvariant} for an arm whose own contract is a
 * DEMOTE, not the invariant backstop — the typed `unsupported` outcome keeps a
 * working legacy body, so `hybrid` stays ready and only `ir-only` blocks.
 */
function expectLowerTypedDemote(
  source: string,
  calleeTypes: ReadonlyMap<string, { params: readonly IrType[]; returnType: IrType | null }>,
  code: IrUnsupportedCode,
  resolver?: IrFromAstResolver,
): void {
  const ast = analyzeSource(source, "producer-seam-demote.ts");
  const declaration = ast.sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "test",
  );
  expect(declaration).toBeDefined();
  const ownerIdentity = irIdentities.next("test");
  const directCalls = collectIrDirectCallLoweringPlans(
    declaration!,
    ownerIdentity.unitId,
    new Map(
      [...calleeTypes].map(([calleeName, signature]) => [
        calleeName,
        { target: irUnitFuncRef(irIdentities.next(`callee:${calleeName}`)), signature },
      ]),
    ),
  );

  let thrown: unknown;
  try {
    lowerFunctionAstToIr(declaration!, {
      ownerUnitId: ownerIdentity.unitId,
      exported: true,
      checker: ast.checker,
      directCalls,
      resolver,
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect(classifyIrFailure(thrown, "build")).toMatchObject({
    kind: "unsupported",
    code,
    stage: "build",
  });
}

describe("#3529 P2 — typed dataflow outcomes", () => {
  it.each([
    {
      name: "mixed string equality",
      code: "operand-coercion-unsupported" as const,
      source: `export function test(): number { return 0 == "" ? 1 : 0; }`,
    },
    {
      name: "mixed strict string equality",
      code: "operand-coercion-unsupported" as const,
      source: `export function test(): number { return 0 === "" ? 1 : 0; }`,
    },
    {
      name: "object/number relational coercion",
      code: "operand-coercion-unsupported" as const,
      source: `
        class Box { valueOf(): number { return 1; } }
        export function test(): number { return new Box() > 0 ? 1 : 0; }
      `,
    },
    {
      name: "object identity representation",
      code: "operand-coercion-unsupported" as const,
      source: `
        class Box {}
        export function test(): number { return new Box() === new Box() ? 1 : 0; }
      `,
    },
    {
      name: "class/number additive coercion",
      code: "operand-coercion-unsupported" as const,
      source: `
        class Box { valueOf(): number { return 1; } }
        export function test(): number { return new Box() + 3; }
      `,
    },
    {
      name: "string append without producer encoding evidence",
      code: "string-evidence-unsupported" as const,
      source: `
        export function test(): string {
          let text = "";
          for (let i = 0; i < 2; i++) text += i;
          return text;
        }
      `,
    },
    {
      name: "array reference property write",
      code: "property-write-unsupported" as const,
      source: `
        export function test(): number {
          const values: number[] = [1, 2];
          values.length = 0;
          return values.length;
        }
      `,
    },
  ])("records $name at the exact producer gate", async ({ source, code }) => {
    await expectBuildUnsupported(source, code);
  });

  it.each([
    ["+", `return +new Box();`],
    ["-", `return -new Box();`],
    ["!", `return !new Box() ? 1 : 0;`],
  ])("records unary %s coercion as unsupported", async (_operator, body) => {
    await expectBuildUnsupported(
      `
        class Box { valueOf(): number { return 1; } }
        export function test(): number { ${body} }
      `,
      "operand-coercion-unsupported",
    );
  });

  it.each([
    ["bare null", `export function test(): number { return +null; }`],
    [
      "undefined-valued expression",
      `export function test(x: number): number { return (void x) === undefined ? 1 : 0; }`,
    ],
    ["null versus ambient undefined", `export function test(): number { return null === undefined ? 1 : 0; }`],
  ])("records %s as an unsupported nullish representation", async (_name, source) => {
    await expectBuildUnsupported(source, "nullish-value-unsupported");
  });

  it("materializes reassigned vector references as slots instead of violating the mutation invariant", async () => {
    const result = await compile(
      `
        export function test(): number {
          let values: number[] = [1, 2, 3, 4];
          let sum = 0;
          for (let i = 0; i < values.length; i++) {
            sum += values[i];
            if (i === 1) values = [9, 9];
          }
          return sum;
        }
      `,
      { fileName: "mutable-vector-slot.ts", trackIrOutcomes: true },
    );

    expect(terminalFor(result)).toMatchObject({
      kind: "emitted",
      irBodyEmitted: true,
    });
    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.test as () => number)()).toBe(3);
  });

  // (#4502) This one reaches the MIXED string/non-string gate, whose own
  // comment reads "Always a clean demote, never the invariant backstop: one
  // operand is statically string-kinded here, so this is a slice-1 capability
  // gap by construction." It has produced a typed `operand-coercion-unsupported`
  // since that arm was written; the assertion here still said
  // `unexpected-internal-throw` and was RED on main (verified on fce375e5,
  // independently of #4502's sweep). Corrected to the contract the site states.
  // The sibling boolean/unary contradictions below are the real
  // producer-contract cases and still assert `invariant`.
  it("demotes cleanly at the mixed-string gate (its own stated contract)", () => {
    expectLowerTypedDemote(
      `
        function text(): string { return "value"; }
        export function test(): number { return "value" == text() ? 1 : 0; }
      `,
      new Map([["text", { params: [], returnType: F64 }]]),
      "operand-coercion-unsupported",
    );
  });

  it("keeps a checker-boolean carrier contradiction invariant at the general binary gate", () => {
    expectLowerInvariant(
      `
        function predicate(): boolean { return true; }
        export function test(): number { return true == predicate() ? 1 : 0; }
      `,
      new Map([["predicate", { params: [], returnType: F64 }]]),
    );
  });

  it.each([
    ["-", "number", EXTERNREF],
    ["+", "number", EXTERNREF],
    ["!", "boolean", F64],
  ] as const)("keeps unary %s with a checker-%s carrier contradiction invariant", (operator, sourceType, carrier) => {
    expectLowerInvariant(
      `
        function value(): ${sourceType} { return ${sourceType === "boolean" ? "true" : "1"}; }
        export function test(): number { return ${operator}value() ? 1 : 0; }
      `,
      new Map([["value", { params: [], returnType: carrier }]]),
    );
  });

  it("keeps a checker-string RHS carrier contradiction invariant at string +=", () => {
    expectLowerInvariant(
      `
        function text(): string { return "value"; }
        export function test(): string {
          let output = "";
          for (let i = 0; i < 1; i++) output += text();
          return output;
        }
      `,
      new Map([["text", { params: [], returnType: F64 }]]),
      { resolveString: () => ({ kind: "externref" }) },
    );
  });

  it("constructs an exact local class named Date before consulting the ambient extern registry", () => {
    const dateShape: IrClassShape = {
      classId: createTestIrClassId("issue-3529-dataflow-outcomes/date"),
      className: "Date",
      fields: [],
      methods: [],
      constructorParams: [],
    };
    const resolver = {
      getExternClassInfo: (name: string) =>
        name === "Date"
          ? {
              className: "Date",
              constructorParams: [],
              methods: new Map(),
              properties: new Map(),
            }
          : undefined,
      isAmbientBinding: () => false,
    };
    const lowered = lowerFunctionAstToIr(
      directDeclaration(`
        class Date {}
        export function test(): Date { return new Date(); }
      `),
      {
        ownerUnitId: irIdentities.next("test").unitId,
        exported: true,
        returnTypeOverride: { kind: "class", shape: dateShape },
        classShapes: new Map([["Date", dateShape]]),
        resolver,
      },
    ).main;

    const instructionKinds = lowered.blocks.flatMap((block) => block.instrs.map((instruction) => instruction.kind));
    expect(instructionKinds).toContain("class.new");
    expect(instructionKinds).not.toContain("extern.new");

    const localShape: IrClassShape = {
      ...dateShape,
      classId: createTestIrClassId("issue-3529-dataflow-outcomes/local"),
      className: "Local",
    };
    expect(() =>
      lowerFunctionAstToIr(
        directDeclaration(`
          class Local {}
          const Date = Local;
          export function test(): Local { return new Date(); }
        `),
        {
          ownerUnitId: irIdentities.next("test").unitId,
          exported: true,
          returnTypeOverride: { kind: "class", shape: localShape },
          classShapes: new Map([["Local", localShape]]),
          resolver,
        },
      ),
    ).toThrow('extern constructor "Date" is shadowed');
  });

  it.each(["toString", "valueOf"])("does not treat inherited String.%s as a method-table signature", (methodName) => {
    let thrown: unknown;
    try {
      lowerDirect(`
          export function test(): string {
            const value = "hello";
            return value.${methodName}();
          }
        `);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(TypeError);
    // The load-bearing assertion: the inherited signature must NOT be treated
    // as a method-table entry, so lowering rejects rather than silently
    // resolving it.
    expect((thrown as Error).message).toContain(`method call .${methodName}(...) on string not in slice 4`);
    // (#4502) `.m(...) on <type> not in slice 4` is the exact message shape
    // `method-call-unsupported` was introduced for (#680) — "a not-yet-adopted
    // construct, NOT a bug, so it demotes". This has produced the typed code
    // since then; the assertion still said `unexpected-internal-throw` and was
    // RED on main (verified on fce375e5, independently of #4502's sweep).
    expect(classifyIrFailure(thrown, "build")).toMatchObject({
      kind: "unsupported",
      code: "method-call-unsupported",
      stage: "build",
    });
  });
});
