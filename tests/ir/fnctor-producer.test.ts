import { describe, expect, it } from "vitest";
import { ts } from "../../src/ts-api.js";
import { buildIrUnitInventory } from "../../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../../src/ir/planning-identity.js";
import type { CodegenContext } from "../../src/codegen/context/types.js";
import { observeApprovedIrFnctor } from "../../src/codegen/program-abi-fnctor-producer.js";

function fixture(): {
  checker: ts.TypeChecker;
  file: ts.SourceFile;
  site: ts.NewExpression;
  declaration: ts.FunctionDeclaration;
  identity: ReturnType<typeof buildIrPlanningIdentityContext>;
} {
  const source = `
    function Parser(input: string) { this.input = input; }
    function run(): string { return new Parser("x").input; }
  `;
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    strict: true,
  };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (fileName, languageVersion) =>
    fileName === "/repo/a.ts" ? ts.createSourceFile(fileName, source, languageVersion, true) : undefined;
  host.fileExists = (fileName) => fileName === "/repo/a.ts";
  host.readFile = (fileName) => (fileName === "/repo/a.ts" ? source : undefined);
  const program = ts.createProgram(["/repo/a.ts"], options, host);
  const file = program.getSourceFile("/repo/a.ts")!;
  let site: ts.NewExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (site) return;
    if (ts.isNewExpression(node)) {
      site = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const declaration = file.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "Parser",
  )!;
  return {
    checker: program.getTypeChecker(),
    file,
    site: site!,
    declaration,
    identity: buildIrPlanningIdentityContext(
      buildIrUnitInventory([file], { checker: program.getTypeChecker(), entrySource: file }),
    ),
  };
}

function makeContext(
  data: ReturnType<typeof fixture>,
  observed: { value?: unknown },
  standalone = false,
): CodegenContext {
  const gate = {
    approved: new Set([data.site]),
    approvedNames: new Set(["Parser"]),
    ctorDeclByName: new Map([["Parser", data.declaration]]),
    provenance: { refusedNames: [] },
  } as unknown as CodegenContext["fnctorEscapeGate"];
  return {
    checker: data.checker,
    standalone,
    wasi: false,
    fnctorEscapeGate: gate,
    fnctorReservedTypeIdx: new Map([["Parser", 7]]),
    structMap: new Map([["__fnctor_Parser", 7]]),
    programAbiFnctors: {
      observe(value: unknown) {
        observed.value = value;
      },
    } as unknown as CodegenContext["programAbiFnctors"],
    programAbiTypes: {} as NonNullable<CodegenContext["programAbiTypes"]>,
    irPlanningIdentityContext: data.identity,
  } as unknown as CodegenContext;
}

function inputFor(ctx: CodegenContext, data: ReturnType<typeof fixture>) {
  return {
    ctx,
    site: data.site,
    declaration: data.declaration,
    functionName: "Parser",
    structName: "__fnctor_Parser",
    structTypeIdx: 7,
    fields: [{ name: "input", type: { kind: "externref" as const }, mutable: true }],
    captureLayout: { captures: [], valueParamTypes: [], tdzFlagParamTypes: [], allParamTypes: [] },
    userParamTypes: [{ kind: "externref" as const }],
    resultIsExternref: false,
    constructorFuncIdx: 42,
    constructorFunction: {
      name: "__fnctor_Parser_new",
      typeIdx: 0,
      locals: [],
      body: [],
      exported: false,
    },
  };
}

describe("#3521 Program-ABI fnctor producer", () => {
  it("observes the complete source/unit-qualified fixed-input shape", () => {
    const data = fixture();
    const observed: { value?: any } = {};
    const ctx = makeContext(data, observed);

    expect(observeApprovedIrFnctor(inputFor(ctx, data))).toBe(true);
    expect(observed.value.shape).toMatchObject({
      kind: "fnctor-shape",
      sourceId: data.identity.sourceIdBySourceFile.get(data.file),
      constructorUnitId: data.identity.unitIdByDeclaration.get(data.declaration),
      fields: [{ name: "input", type: { kind: "string" }, ordinal: 0 }],
      captures: [],
      userParamTypes: [{ kind: "string" }],
      hiddenIdentity: true,
      constructorIdentity: {
        unitId: data.identity.unitIdByDeclaration.get(data.declaration),
        paramIndex: 1,
      },
    });
    expect(observed.value).toMatchObject({
      constructorFuncIdx: 42,
      structTypeIdx: 7,
      fields: [{ name: "input", type: { kind: "externref" }, mutable: true }],
      captureParamTypes: [],
      tdzFlagParamTypes: [],
      userParamTypes: [{ kind: "externref" }],
      constructorIdentityParamIndex: 1,
      resultIsExternref: false,
    });
  });

  it("leaves standalone/internal layouts on the legacy path", () => {
    const data = fixture();
    const observed: { value?: unknown } = {};
    const ctx = makeContext(data, observed, true);

    expect(observeApprovedIrFnctor(inputFor(ctx, data))).toBe(false);
    expect(observed.value).toBeUndefined();
  });
});
