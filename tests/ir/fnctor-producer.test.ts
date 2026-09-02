import { describe, expect, it } from "vitest";
import { ts } from "../../src/ts-api.js";
import { buildIrUnitInventory } from "../../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../../src/ir/planning-identity.js";
import type { CodegenContext } from "../../src/codegen/context/types.js";
import {
  buildStandaloneIrFnctorObservation,
  observeApprovedIrFnctor,
} from "../../src/codegen/program-abi-fnctor-producer.js";
import {
  validateProgramAbiFnctorPhysicalContract,
  type ProgramAbiFnctorObservation,
} from "../../src/codegen/program-abi-fnctor-planning.js";
import { irFnctorConstructorFuncRef } from "../../src/ir/callable-bindings.js";
import { irFnctorLayoutTypeRef } from "../../src/ir/abi-bindings.js";
import type { IrFnctorShape } from "../../src/ir/fnctor-abi.js";
import { fnctorConstructorField } from "../../src/codegen/fnctor-identity-fields.js";
import { closureBagField } from "../../src/codegen/closures/closure-header-layout.js";

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
    siteCtorName: new Map([[data.site, "Parser"]]),
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

function standaloneShape(data: ReturnType<typeof fixture>): IrFnctorShape {
  const sourceId = data.identity.sourceIdBySourceFile.get(data.file)!;
  const constructorUnitId = data.identity.unitIdByDeclaration.get(data.declaration)!;
  return {
    kind: "fnctor-shape",
    sourceId,
    constructorUnitId,
    constructorName: "Parser",
    constructorTarget: irFnctorConstructorFuncRef(constructorUnitId, "__fnctor_Parser_new"),
    reservedLayout: irFnctorLayoutTypeRef(constructorUnitId, "__fnctor_Parser"),
    fields: [{ name: "input", type: { kind: "string" }, ordinal: 0 }],
    captures: [],
    userParamTypes: [{ kind: "string" }],
    hiddenIdentity: true,
    constructorIdentity: { unitId: constructorUnitId, paramIndex: 1 },
  };
}

function standalonePhysicalFixture(data: ReturnType<typeof fixture>): {
  ctx: CodegenContext;
  input: ReturnType<typeof inputFor>;
  shape: IrFnctorShape;
} {
  const ctx = makeContext(data, {}, true);
  const fields = [
    { name: "input", type: { kind: "ref_null" as const, typeIdx: 9 }, mutable: true },
    fnctorConstructorField(),
    closureBagField(),
  ];
  const constructorFunction = {
    name: "__fnctor_Parser_new",
    typeIdx: 8,
    locals: [],
    body: [],
    exported: false,
  };
  Object.assign(ctx, {
    nativeStrings: true,
    fast: false,
    anyStrTypeIdx: 9,
    targetProfile: { semanticProviders: "native-first" },
    fnctorReservedTypeIdx: new Map([["Parser", 7]]),
    structMap: new Map([["__fnctor_Parser", 7]]),
    mod: {
      types: [
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { kind: "struct", name: "__fnctor_Parser", fields },
        {
          kind: "func",
          params: [{ kind: "externref" }, { kind: "externref" }],
          results: [{ kind: "ref", typeIdx: 7 }],
        },
        { kind: "struct", name: "$AnyString", fields: [{ name: "length", type: { kind: "i32" } }] },
      ],
      functions: [constructorFunction],
      imports: [],
      globals: [],
      exports: [],
    },
  });
  const input = {
    ...inputFor(ctx, data),
    structTypeIdx: 7,
    fields,
    userParamTypes: [{ kind: "externref" as const }],
    constructorFuncIdx: 0,
    constructorFunction,
  };
  return { ctx, input, shape: standaloneShape(data) };
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

  it("builds a get-only standalone Parser contract with exact logical/physical carriers", () => {
    const data = fixture();
    const { ctx, input, shape } = standalonePhysicalFixture(data);
    const observation = buildStandaloneIrFnctorObservation(input, shape);

    expect(observation).toMatchObject({
      constructorResultType: { kind: "ref", typeIdx: 7 },
      instanceCarrierType: { kind: "ref_null", typeIdx: 7 },
      supportsConstruction: false,
      supportsFieldGet: true,
      fieldMappings: [
        {
          name: "input",
          physicalIndex: 0,
          logicalType: { kind: "string" },
          physicalType: { kind: "ref_null", typeIdx: 9 },
          refinement: "nullable-native-string",
        },
      ],
    });
    expect(validateProgramAbiFnctorPhysicalContract(ctx, observation!)).toBeNull();
  });

  it("observes the exact get-only standalone Parser after its legacy constructor is finalized", () => {
    const data = fixture();
    const observed: { value?: ProgramAbiFnctorObservation } = {};
    const { ctx, input } = standalonePhysicalFixture(data);
    ctx.programAbiFnctors = {
      observe(value: ProgramAbiFnctorObservation) {
        observed.value = value;
      },
    } as unknown as CodegenContext["programAbiFnctors"];

    expect(observeApprovedIrFnctor(input)).toBe(true);
    expect(observed.value).toMatchObject({
      sourceId: data.identity.sourceIdBySourceFile.get(data.file),
      constructorUnitId: data.identity.unitIdByDeclaration.get(data.declaration),
      supportsConstruction: false,
      supportsFieldGet: true,
      instanceCarrierType: { kind: "ref_null", typeIdx: 7 },
      shape: {
        fields: [{ name: "input", type: { kind: "string" }, ordinal: 0 }],
        userParamTypes: [{ kind: "string" }],
      },
    });
  });

  it.each([
    [
      "reordered compiler fields",
      (o: ProgramAbiFnctorObservation) => ({ ...o, fields: [o.fields[0]!, o.fields[2]!, o.fields[1]!] }),
    ],
    [
      "an unknown padding field",
      (o: ProgramAbiFnctorObservation) => ({
        ...o,
        fields: [...o.fields, { name: "__pad0", type: { kind: "externref" as const }, mutable: true }],
      }),
    ],
    [
      "a presence bit",
      (o: ProgramAbiFnctorObservation) => ({
        ...o,
        fields: [{ ...o.fields[0]!, presenceTracked: true, presenceBit: 0 }, ...o.fields.slice(1)],
      }),
    ],
    [
      "a non-null physical input",
      (o: ProgramAbiFnctorObservation) => ({
        ...o,
        fields: [{ ...o.fields[0]!, type: { kind: "ref" as const, typeIdx: 9 } }, ...o.fields.slice(1)],
      }),
    ],
    [
      "a logical ordinal drift",
      (o: ProgramAbiFnctorObservation) => ({
        ...o,
        shape: { ...o.shape, fields: [{ ...o.shape.fields[0]!, ordinal: 1 }] },
      }),
    ],
    [
      "a physical mapping drift",
      (o: ProgramAbiFnctorObservation) => ({ ...o, fieldMappings: [{ ...o.fieldMappings[0]!, physicalIndex: 1 }] }),
    ],
    [
      "a missing field refinement",
      (o: ProgramAbiFnctorObservation) => ({
        ...o,
        fieldMappings: [{ ...o.fieldMappings[0]!, refinement: "none" as const }],
      }),
    ],
    [
      "a foreign constructor result",
      (o: ProgramAbiFnctorObservation) => ({
        ...o,
        resultIsExternref: true,
        constructorResultType: { kind: "externref" as const },
      }),
    ],
    [
      "a non-null instance carrier",
      (o: ProgramAbiFnctorObservation) => ({ ...o, instanceCarrierType: { kind: "ref" as const, typeIdx: 7 } }),
    ],
    ["construction capability", (o: ProgramAbiFnctorObservation) => ({ ...o, supportsConstruction: true })],
    ["missing get capability", (o: ProgramAbiFnctorObservation) => ({ ...o, supportsFieldGet: false })],
    [
      "a physical constructor parameter drift",
      (o: ProgramAbiFnctorObservation) => ({ ...o, userParamTypes: [{ kind: "ref" as const, typeIdx: 9 }] }),
    ],
    [
      "a source identity drift",
      (o: ProgramAbiFnctorObservation) => ({ ...o, sourceId: `${o.sourceId}:other` as typeof o.sourceId }),
    ],
  ])("rejects %s", (_label, mutate) => {
    const data = fixture();
    const { ctx, input, shape } = standalonePhysicalFixture(data);
    const observation = buildStandaloneIrFnctorObservation(input, shape)!;
    expect(validateProgramAbiFnctorPhysicalContract(ctx, mutate(observation))).not.toBeNull();
  });

  it.each([
    ["a split layout", (ctx: CodegenContext) => (ctx.fnctorLayoutInfo = new Map([["__fnctor_Parser", {} as never]]))],
    // The standalone observation's cold-tail signal is the WasmGC split's
    // struct-name map (`fnctor-cold-tail.ts:361`), not the linear reservation's
    // type-index map (`linear-type-reservations.ts:243`). `cb733cde37` moved
    // `program-abi-fnctor-producer.ts:225` onto the struct-name map; this
    // fixture kept setting the old one, so the case stopped rejecting. The host
    // twin at `:81` still reads `fnctorColdTailTypeIdx` — do not change it.
    [
      "a cold tail",
      (ctx: CodegenContext) => (ctx.fnctorColdTailStructName = new Map([["__fnctor_Parser", "__fnctor_Parser__cold"]])),
    ],
    ["a fast lane", (ctx: CodegenContext) => (ctx.fast = true)],
    ["a host lane", (ctx: CodegenContext) => (ctx.standalone = false)],
  ])("does not build the standalone observation for %s", (_label, mutate) => {
    const data = fixture();
    const { ctx, input, shape } = standalonePhysicalFixture(data);
    mutate(ctx);
    expect(buildStandaloneIrFnctorObservation(input, shape)).toBeUndefined();
  });
});
