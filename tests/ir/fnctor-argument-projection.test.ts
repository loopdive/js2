// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import {
  collectIrFnctorArgumentProjectionsForPlanning,
  irFnctorArgumentProjectionRouteIsActive,
  makeIrFnctorArgumentProjectionAuthority,
  makeIrFnctorAdmissionResolver,
  type IrFnctorArgumentProjectionRoute,
} from "../../src/codegen/ir-fnctor-admission.js";
import type { CodegenContext } from "../../src/codegen/context/types.js";
import {
  irFnctorParameterPreselectionIsCurrent,
  planIrFnctorParameterPreselection,
} from "../../src/codegen/ir-fnctor-parameter-planning.js";
import type { IrFnctorLowering } from "../../src/ir/backend/handles.js";
import type { IrFnctorShape } from "../../src/ir/fnctor-abi.js";
import {
  collectIrFnctorArgumentProjections,
  proveIrFnctorInputConstructorSyntax,
  retainIrFnctorArgumentProjections,
  type IrFnctorArgumentProjection,
} from "../../src/ir/fnctor-argument-projection.js";
import { buildIrUnitInventory } from "../../src/ir/identity.js";
import { buildIrPlanningIdentityContext, type IrPlanningIdentityContext } from "../../src/ir/planning-identity.js";
import { buildIrUnitTypeMap, type IrUnitTypeMap } from "../../src/ir/propagate.js";
import { planIrCompilationByIdentity } from "../../src/ir/select-identity.js";
import type { FuncTypeDef, ValType, WasmFunction } from "../../src/ir/types.js";
import { ts } from "../../src/ts-api.js";

const BASE_SOURCE = `
function Parser(input) {
  this.input = input;
}
function stringToNumber(str, isLegacyOctalNumericLiteral) {
  if (isLegacyOctalNumericLiteral) return parseInt(str, 8);
  return parseFloat(str.replace(/_/g, ""));
}
function readNumber(parser) {
  var octal = false;
  return stringToNumber(parser.input.slice(0, parser.input.length), octal);
}
export function run() {
  return readNumber(new Parser("12_3"));
}
`;

interface FixtureOptions {
  readonly entryText?: string;
  readonly entryFileName?: string;
  readonly otherText?: string;
  readonly reverseInventory?: boolean;
}

interface Fixture {
  readonly checker: ts.TypeChecker;
  readonly entry: ts.SourceFile;
  readonly other?: ts.SourceFile;
  readonly sources: readonly ts.SourceFile[];
  readonly identity: IrPlanningIdentityContext;
  readonly unitTypeMap: IrUnitTypeMap;
  readonly site: ts.NewExpression;
  readonly constructor: ts.FunctionDeclaration;
}

function fixture(options: FixtureOptions = {}): Fixture {
  const entryFileName = options.entryFileName ?? "/repo/entry.mjs";
  const files = new Map<string, string>([
    [entryFileName, options.entryText ?? BASE_SOURCE],
    [
      "/repo/lib.d.ts",
      "declare function parseInt(value: any, radix?: number): number; declare function parseFloat(value: any): number;",
    ],
  ]);
  if (options.otherText !== undefined) files.set("/repo/other.mjs", options.otherText);
  const compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noImplicitAny: false,
    strict: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
  };
  const host: ts.CompilerHost = {
    fileExists: (fileName) => files.has(fileName),
    readFile: (fileName) => files.get(fileName),
    getSourceFile: (fileName, languageVersion) => {
      const source = files.get(fileName);
      if (source === undefined) return undefined;
      const scriptKind = fileName.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
      return ts.createSourceFile(fileName, source, languageVersion, true, scriptKind);
    },
    getDefaultLibFileName: () => "/repo/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/repo",
    getDirectories: () => [],
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    resolveModuleNames: (moduleNames, containingFile) =>
      moduleNames.map((moduleName) => {
        if (!moduleName.startsWith("./")) return undefined;
        const directory = containingFile.slice(0, containingFile.lastIndexOf("/") + 1);
        const resolvedFileName = `${directory}${moduleName.slice(2)}`;
        if (!files.has(resolvedFileName)) return undefined;
        return {
          resolvedFileName,
          extension: resolvedFileName.endsWith(".mjs") ? ts.Extension.Mjs : ts.Extension.Ts,
          isExternalLibraryImport: false,
        };
      }),
  };
  const roots = [...files.keys()].filter((fileName) => fileName !== "/repo/lib.d.ts").sort();
  const program = ts.createProgram(roots, compilerOptions, host);
  const checker = program.getTypeChecker();
  const entry = program.getSourceFile(entryFileName)!;
  const other = program.getSourceFile("/repo/other.mjs");
  const sourceOrder = [entry, ...(other ? [other] : [])];
  const inventorySources = options.reverseInventory ? [...sourceOrder].reverse() : sourceOrder;
  const identity = buildIrPlanningIdentityContext(
    buildIrUnitInventory(inventorySources, { checker, entrySource: entry }),
  );
  let site: ts.NewExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (!site && ts.isNewExpression(node)) site = node;
    ts.forEachChild(node, visit);
  };
  visit(entry);
  const localConstructor = entry.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "Parser",
  );
  if (!site || !ts.isIdentifier(site.expression)) throw new Error("fixture must contain a Parser allocation");
  let constructorDeclaration = localConstructor;
  if (!constructorDeclaration) {
    let symbol = checker.getSymbolAtLocation(site.expression);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
    constructorDeclaration = symbol?.getDeclarations()?.find(ts.isFunctionDeclaration);
  }
  if (!constructorDeclaration) throw new Error("fixture must resolve its Parser allocation");
  return {
    checker,
    entry,
    ...(other ? { other } : {}),
    sources: sourceOrder,
    identity,
    unitTypeMap: buildIrUnitTypeMap(sourceOrder, checker, identity),
    site,
    constructor: constructorDeclaration,
  };
}

interface ContextOptions {
  readonly approved?: boolean;
  readonly publishSiteName?: boolean;
  readonly approvedName?: boolean;
  readonly refusedName?: boolean;
  readonly constructorDeclaration?: ts.FunctionDeclaration;
  readonly reservedTypeIdx?: number;
  readonly structTypeIdx?: number;
}

function contextFor(data: Fixture, options: ContextOptions = {}): CodegenContext {
  const approved = options.approved ?? true;
  const publishSiteName = options.publishSiteName ?? true;
  const approvedName = options.approvedName ?? true;
  const constructorDeclaration = options.constructorDeclaration ?? data.constructor;
  const reservedTypeIdx = options.reservedTypeIdx === undefined ? 7 : options.reservedTypeIdx;
  const structTypeIdx = options.structTypeIdx === undefined ? reservedTypeIdx : options.structTypeIdx;
  return {
    fnctorEscapeGate: {
      sites: new Map([[data.site, approved ? "reconstruct" : "keep-static"]]),
      siteCtorName: publishSiteName ? new Map([[data.site, "Parser"]]) : new Map(),
      approved: approved ? new Set([data.site]) : new Set(),
      approvedNames: approvedName ? new Set(["Parser"]) : new Set(),
      ctorDeclByName: new Map([["Parser", constructorDeclaration]]),
      provenance: {
        compilePath: "multi",
        sourceFileCount: data.sources.length,
        refusals: new Map(),
        refusedNames: options.refusedName ? ["Parser"] : [],
      },
    },
    fnctorReservedTypeIdx: new Map([["Parser", reservedTypeIdx]]),
    structMap: new Map([["__fnctor_Parser", structTypeIdx]]),
    standalone: true,
    nativeStrings: true,
    wasi: false,
    fast: false,
    targetProfile: { semanticProviders: "native-first" },
  } as unknown as CodegenContext;
}

const EXACT_ROUTE: IrFnctorArgumentProjectionRoute = Object.freeze({
  experimentalIR: true,
  postLegacyPhysicalReservation: true,
  irFirstEnvironment: "0",
});

function projections(
  data: Fixture,
  context: CodegenContext = contextFor(data),
  route: IrFnctorArgumentProjectionRoute = EXACT_ROUTE,
): readonly IrFnctorArgumentProjection[] {
  return collectIrFnctorArgumentProjectionsForPlanning(
    context,
    data.checker,
    data.identity,
    data.entry,
    data.unitTypeMap,
    route,
  );
}

function authorityFor(data: Fixture, context: CodegenContext = contextFor(data)) {
  return makeIrFnctorArgumentProjectionAuthority(context, data.checker);
}

function terminalId(data: Fixture, name: string) {
  const declaration = data.entry.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!declaration) throw new Error(`missing ${name}`);
  const unitId = data.identity.unitIdByDeclaration.get(declaration);
  if (!unitId) throw new Error(`missing unit for ${name}`);
  return { declaration, unitId };
}

function firstCallIn(declaration: ts.FunctionDeclaration): ts.CallExpression {
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (!found && ts.isCallExpression(node)) found = node;
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  if (!found) throw new Error("expected a call expression");
  return found;
}

function firstNewIn(declaration: ts.FunctionDeclaration): ts.NewExpression {
  let found: ts.NewExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (!found && ts.isNewExpression(node)) found = node;
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  if (!found) throw new Error("expected a new expression");
  return found;
}

describe("#3521 dormant source-qualified fnctor argument projection", () => {
  it("retains the checker-any constructor through the logical string argument without creating an admission", () => {
    const data = fixture();
    const syntax = proveIrFnctorInputConstructorSyntax(data.checker, data.identity, data.constructor);
    expect(syntax).toBeDefined();
    let reservationRequests = 0;
    const coreResult = collectIrFnctorArgumentProjections({
      sourceFile: data.entry,
      checker: data.checker,
      identityContext: data.identity,
      unitTypeMap: data.unitTypeMap,
      resolvePhysicalReservation: (site, constructorProof) => {
        reservationRequests++;
        return {
          kind: "fnctor-physical-reservation",
          sourceId: constructorProof.sourceId,
          constructorUnitId: constructorProof.constructorUnitId,
          constructorDeclaration: constructorProof.constructorDeclaration,
          constructorSite: site,
          reservationKey: "__fnctor_Parser",
          reservedTypeIdx: 7,
        };
      },
    });
    expect(reservationRequests).toBe(1);
    expect(coreResult).toHaveLength(1);
    const result = projections(data);
    expect(result).toHaveLength(1);
    const projection = result[0]!;
    const constructorParameter = data.constructor.parameters[0]!;
    expect(data.checker.getTypeAtLocation(constructorParameter).flags & ts.TypeFlags.Any).not.toBe(0);
    expect(projection.constructorParameterDeclaration).toBe(constructorParameter);
    expect(projection.constructorSite).toBe(data.site);
    expect(projection.allocationArgument).toBe(data.site.arguments![0]);
    expect(projection.logicalShape).toEqual({ fieldName: "input", fieldType: "string" });
    expect(projection.physicalReservation).toMatchObject({ reservationKey: "__fnctor_Parser", reservedTypeIdx: 7 });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.constructorSyntax)).toBe(true);
    expect(Object.isFrozen(projection.physicalReservation)).toBe(true);
    expect(Object.isFrozen(projection.proof)).toBe(true);
    expect("noEscape" in projection.proof).toBe(false);
    expect(makeIrFnctorAdmissionResolver(contextFor(data), data.checker, data.identity)(data.site)).toBeUndefined();
  });

  it("enforces the exact standalone post-legacy route and fails closed in every other mode", () => {
    const data = fixture();
    const exactContext = contextFor(data);
    expect(irFnctorArgumentProjectionRouteIsActive(exactContext, EXACT_ROUTE)).toBe(true);
    expect(projections(data, exactContext, EXACT_ROUTE)).toHaveLength(1);

    const routeMutations: readonly [string, IrFnctorArgumentProjectionRoute][] = [
      ["experimental IR off", { ...EXACT_ROUTE, experimentalIR: false }],
      ["pre-legacy planning", { ...EXACT_ROUTE, postLegacyPhysicalReservation: false }],
      ["IR-first unset", { ...EXACT_ROUTE, irFirstEnvironment: undefined }],
      ["IR-first enabled", { ...EXACT_ROUTE, irFirstEnvironment: "1" }],
      ["non-literal disable", { ...EXACT_ROUTE, irFirstEnvironment: "false" }],
    ];
    for (const [label, route] of routeMutations) {
      expect(irFnctorArgumentProjectionRouteIsActive(exactContext, route), label).toBe(false);
      expect(projections(data, exactContext, route), label).toEqual([]);
    }

    const contextMutations: readonly [string, CodegenContext][] = [
      ["host target", { ...exactContext, standalone: false }],
      ["host strings", { ...exactContext, nativeStrings: false }],
      ["WASI target", { ...exactContext, wasi: true }],
      ["fast mode", { ...exactContext, fast: true }],
      [
        "non-native semantic provider",
        {
          ...exactContext,
          targetProfile: { ...exactContext.targetProfile, semanticProviders: "host-assisted" },
        },
      ],
    ];
    for (const [label, context] of contextMutations) {
      expect(irFnctorArgumentProjectionRouteIsActive(context, EXACT_ROUTE), label).toBe(false);
      expect(projections(data, context, EXACT_ROUTE), label).toEqual([]);
    }
  });

  it("retains evidence from the complete population while leaving propagation and selection unchanged", () => {
    const data = fixture();
    const result = projections(data);
    const withoutProjection = planIrCompilationByIdentity(
      data.entry,
      data.identity,
      { experimentalIR: true, trackFallbacks: true },
      data.unitTypeMap,
    );
    const withProjection = planIrCompilationByIdentity(
      data.entry,
      data.identity,
      {
        experimentalIR: true,
        trackFallbacks: true,
        fnctorArgumentProjections: result,
        fnctorArgumentProjectionAuthority: authorityFor(data),
      },
      data.unitTypeMap,
    );
    const withoutAuthority = planIrCompilationByIdentity(
      data.entry,
      data.identity,
      { experimentalIR: true, trackFallbacks: true, fnctorArgumentProjections: result },
      data.unitTypeMap,
    );
    const readNumber = terminalId(data, "readNumber");
    expect(data.unitTypeMap.get(readNumber.unitId)?.params[0]?.kind).toBe("dynamic");
    expect([...withProjection.funcs.keys()]).toEqual([...withoutProjection.funcs.keys()]);
    expect([...withProjection.fallbacks!.entries()]).toEqual([...withoutProjection.fallbacks!.entries()]);
    expect(withProjection.fnctorAdmissions).toBeUndefined();
    expect(withProjection.fnctorArgumentProjections).toHaveLength(1);
    expect(withoutAuthority.fnctorArgumentProjections).toBeUndefined();
    expect(withProjection.units.has(result[0]!.callerUnitId)).toBe(true);
    expect(withProjection.funcs.has(result[0]!.callerUnitId)).toBe(false);
  });

  it("keeps a top-level candidate when unrelated nested, class-member, and module-init syntax is inventoried", () => {
    const data = fixture({
      entryText: `${BASE_SOURCE}
        function outer() { function nested() { return 1; } return nested(); }
        class Holder { method() { return 2; } }
        const unrelated = outer();
      `,
    });
    expect(projections(data)).toHaveLength(1);
  });

  it.each([
    ["module init", `${BASE_SOURCE}\nreadNumber(new Parser("module"));`],
    [
      "a nested function",
      `${BASE_SOURCE}\nfunction outer() { function nested() { return readNumber(new Parser("nested")); } return nested(); }`,
    ],
    ["a class member", `${BASE_SOURCE}\nclass Holder { method() { return readNumber(new Parser("member")); } }`],
    ["transparent wrappers", `${BASE_SOURCE}\nfunction wrapped() { return (readNumber)((new Parser("wrapped"))); }`],
    [
      "local aliases",
      `${BASE_SOURCE}\nconst P = Parser; const read = readNumber; function aliased() { return read(new P("alias")); }`,
    ],
    [
      "compound alias uncertainty",
      `${BASE_SOURCE}\nfunction aliased() { const P = Parser.bind(null); const read = readNumber.bind(null); return read(new P("alias")); }`,
    ],
  ])("rejects a second exact constructor/callee use from %s", (_label, entryText) => {
    const data = fixture({ entryText });
    expect(projections(data)).toEqual([]);
  });

  it.each([
    [
      "constructor and callee values",
      `${BASE_SOURCE}
        function invoke(C, F) { return F(new C("forwarded")); }
        export function forwarded() { return invoke(Parser, readNumber); }
      `,
    ],
    [
      "a constructor value",
      `${BASE_SOURCE}
        function allocate(C) { return new C("forwarded"); }
        export function forwarded() { return allocate(Parser); }
      `,
    ],
    [
      "a callee value",
      `${BASE_SOURCE}
        function invoke(F) { return F({ input: "forwarded" }); }
        export function forwarded() { return invoke(readNumber); }
      `,
    ],
  ])("rejects dynamic wrapper forwarding of %s", (_label, entryText) => {
    const data = fixture({ entryText });
    expect(projections(data)).toEqual([]);
  });

  it.each([
    [
      "default parameter values",
      `${BASE_SOURCE}
        function invoke(C = Parser, F = readNumber) { return F(new C("defaulted")); }
        export function forwarded() { return invoke(); }
      `,
    ],
    [
      "assignments",
      `${BASE_SOURCE}
        let C;
        let F;
        C = Parser;
        F = readNumber;
        export function forwarded() { return F(new C("assigned")); }
      `,
    ],
    [
      "factory returns",
      `${BASE_SOURCE}
        function constructorFactory() { return Parser; }
        function calleeFactory() { return readNumber; }
        export function forwarded() {
          const C = constructorFactory();
          const F = calleeFactory();
          return F(new C("factory"));
        }
      `,
    ],
    [
      "class fields",
      `${BASE_SOURCE}
        class Forwarder {
          C = Parser;
          F = readNumber;
          run() { return this.F(new this.C("field")); }
        }
      `,
    ],
  ])("rejects target values forwarded through %s", (_label, entryText) => {
    const data = fixture({ entryText });
    expect(projections(data)).toEqual([]);
  });

  it("keeps the projection when an unrelated exact function is used through a compound call", () => {
    const data = fixture({
      entryText: `${BASE_SOURCE}
        function other(value) { return value; }
        export function unrelated() { return other.call(null, 1); }
      `,
    });
    expect(projections(data)).toHaveLength(1);
  });

  it("rejects checker-resolved imported uses of the exact constructor and callee in another source", () => {
    const data = fixture({
      entryText: BASE_SOURCE.replace("function Parser", "export function Parser").replace(
        "function readNumber",
        "export function readNumber",
      ),
      otherText: `
        import { Parser, readNumber } from "./entry.mjs";
        export function foreign() { return readNumber(new Parser("foreign")); }
      `,
    });
    expect(projections(data)).toEqual([]);
  });

  it.each([
    ["a conditional constructor write", `function Parser(input) { if (input) this.input = input; }`],
    ["an aliased constructor parameter", `function Parser(input) { const value = input; this.input = value; }`],
    ["an additional constructor field", `function Parser(input) { this.input = input; this.extra = 1; }`],
    ["a default constructor parameter", `function Parser(input = "x") { this.input = input; }`],
    ["a rest constructor parameter", `function Parser(...input) { this.input = input; }`],
    ["the wrong constructor parameter", `function Parser(input, other) { this.input = other; }`],
  ])("rejects %s", (_label, constructorSource) => {
    const data = fixture({
      entryText: BASE_SOURCE.replace(/function Parser\(input\) \{[\s\S]*?\n\}/, constructorSource),
    });
    expect(projections(data)).toEqual([]);
  });

  it.each([
    ["an alias", `export function run() { const parser = new Parser("x"); return readNumber(parser); }`],
    ["a stored value", `export function run() { const box = {}; box.value = new Parser("x"); return box.value; }`],
    ["a returned value", `export function run() { return new Parser("x"); }`],
    ["a reassigned binding", `export function run() { let parser = new Parser("x"); parser = null; return parser; }`],
    [
      "a captured binding",
      `export function run() { const parser = new Parser("x"); return () => readNumber(parser); }`,
    ],
    [
      "a second use",
      `export function run() { const parser = new Parser("x"); readNumber(parser); return readNumber(parser); }`,
    ],
    ["a spread call", `export function run() { return readNumber(...[new Parser("x")]); }`],
    ["an optional call", `export function run() { return readNumber?.(new Parser("x")); }`],
    ["a numeric allocation argument", `export function run() { return readNumber(new Parser(12)); }`],
    ["a dynamic allocation argument", `export function run(value) { return readNumber(new Parser(value)); }`],
    ["a union allocation argument", `export function run(flag) { return readNumber(new Parser(flag ? "x" : 1)); }`],
    [
      "a second allocation",
      `export function run() { readNumber(new Parser("x")); return readNumber(new Parser("y")); }`,
    ],
    ["a second call edge", `export function run() { readNumber(new Parser("x")); return readNumber({ input: "y" }); }`],
  ])("rejects %s", (_label, runSource) => {
    const data = fixture({ entryText: BASE_SOURCE.replace(/export function run\(\) \{[\s\S]*?\n\}/, runSource) });
    expect(projections(data)).toEqual([]);
  });

  it("rejects generic calls and a callee with the wrong parameter index", () => {
    const generic = fixture({
      entryFileName: "/repo/entry.ts",
      entryText: `
        function Parser(input: any) { this.input = input; }
        function readNumber<T>(parser: any) { return parser.input; }
        export function run() { return readNumber<string>(new Parser("x")); }
      `,
    });
    expect(projections(generic)).toEqual([]);

    const wrongParameter = fixture({
      entryText: BASE_SOURCE.replace("function readNumber(parser)", "function readNumber(flag, parser)"),
    });
    expect(projections(wrongParameter)).toEqual([]);
  });

  it("rejects ambiguous and foreign same-spelled declarations by checker identity", () => {
    const duplicateConstructor = fixture({
      entryText: BASE_SOURCE.replace(
        "function Parser(input) {\n  this.input = input;\n}",
        "function Parser(input) { this.input = input; }\nfunction Parser(input) { this.input = input; }",
      ),
    });
    expect(projections(duplicateConstructor)).toEqual([]);

    const foreignConstructor = fixture({
      entryText: BASE_SOURCE,
      otherText: "export function Parser(input) { this.input = input; }",
    });
    const otherConstructor = foreignConstructor.other!.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "Parser",
    )!;
    expect(
      projections(foreignConstructor, contextFor(foreignConstructor, { constructorDeclaration: otherConstructor })),
    ).toEqual([]);

    const importedConstructor = fixture({
      entryText: `
        import { Parser } from "./other.mjs";
        function readNumber(parser) { return parser.input; }
        export function run() { return readNumber(new Parser("x")); }
      `,
      otherText: "export function Parser(input) { this.input = input; }",
    });
    expect(
      collectIrFnctorArgumentProjectionsForPlanning(
        {
          fnctorEscapeGate: {
            sites: new Map([[importedConstructor.site, "reconstruct"]]),
            siteCtorName: new Map([[importedConstructor.site, "Parser"]]),
            approved: new Set([importedConstructor.site]),
            approvedNames: new Set(["Parser"]),
            ctorDeclByName: new Map(),
            provenance: { refusedNames: [] },
          },
          fnctorReservedTypeIdx: new Map([["Parser", 7]]),
          structMap: new Map([["__fnctor_Parser", 7]]),
        } as unknown as CodegenContext,
        importedConstructor.checker,
        importedConstructor.identity,
        importedConstructor.entry,
        importedConstructor.unitTypeMap,
        EXACT_ROUTE,
      ),
    ).toEqual([]);

    const importedCallee = fixture({
      entryText: `
        import { readNumber } from "./other.mjs";
        function Parser(input) { this.input = input; }
        export function run() { return readNumber(new Parser("x")); }
      `,
      otherText: "export function readNumber(parser) { return parser.input; }",
    });
    expect(projections(importedCallee)).toEqual([]);
  });

  it.each([
    ["an unapproved site", { approved: false }],
    ["a missing site name", { publishSiteName: false }],
    ["a missing approved name", { approvedName: false }],
    ["a refused name", { refusedName: true }],
    ["a negative reservation", { reservedTypeIdx: -1, structTypeIdx: -1 }],
    ["a mismatched struct reservation", { reservedTypeIdx: 7, structTypeIdx: 8 }],
  ] satisfies readonly [string, ContextOptions][])("rejects %s", (_label, contextOptions) => {
    const data = fixture();
    expect(projections(data, contextFor(data, contextOptions))).toEqual([]);
  });

  it("is canonical when the same source graph is inventoried in the opposite order", () => {
    const otherText = "export function unrelated(value) { return value; }";
    const forward = fixture({ otherText });
    const reverse = fixture({ otherText, reverseInventory: true });
    const summarize = (projection: IrFnctorArgumentProjection) => ({
      sourceId: projection.sourceId,
      callerUnitId: projection.callerUnitId,
      calleeUnitId: projection.calleeUnitId,
      constructorUnitId: projection.constructorUnitId,
      constructorPos: projection.constructorSite.pos,
      callPos: projection.directCall.pos,
      reservationKey: projection.physicalReservation.reservationKey,
      reservedTypeIdx: projection.physicalReservation.reservedTypeIdx,
    });
    expect(summarize(projections(reverse)[0]!)).toEqual(summarize(projections(forward)[0]!));
  });

  it("rejects coherent substitute declaration, UnitId, parameter, AST, and reservation records", () => {
    const data = fixture({
      entryText: `${BASE_SOURCE}
        function OtherParser(input) { this.input = input; }
        function otherReadNumber(value) { return value.input; }
        function otherRun() { return otherReadNumber(new OtherParser("9")); }
      `,
    });
    const projection = projections(data)[0]!;
    const sourceId = data.identity.sourceIdBySourceFile.get(data.entry)!;
    const otherConstructor = terminalId(data, "OtherParser");
    const otherCallee = terminalId(data, "otherReadNumber");
    const otherCaller = terminalId(data, "otherRun");
    const otherSyntax = proveIrFnctorInputConstructorSyntax(data.checker, data.identity, otherConstructor.declaration)!;
    const otherCall = firstCallIn(otherCaller.declaration);
    const otherSite = firstNewIn(otherCaller.declaration);
    const substitute: IrFnctorArgumentProjection = {
      ...projection,
      callerUnitId: otherCaller.unitId,
      callerDeclaration: otherCaller.declaration,
      directCall: otherCall,
      calleeUnitId: otherCallee.unitId,
      calleeDeclaration: otherCallee.declaration,
      calleeParameterDeclaration: otherCallee.declaration.parameters[0]!,
      constructorUnitId: otherConstructor.unitId,
      constructorDeclaration: otherConstructor.declaration,
      constructorParameterDeclaration: otherConstructor.declaration.parameters[0]!,
      constructorSite: otherSite,
      allocationArgument: otherSite.arguments![0]!,
      constructorSyntax: otherSyntax,
      physicalReservation: {
        ...projection.physicalReservation,
        constructorUnitId: otherConstructor.unitId,
        constructorDeclaration: otherConstructor.declaration,
        constructorSite: otherSite,
        reservationKey: "__fnctor_OtherParser",
      },
    };
    expect(
      retainIrFnctorArgumentProjections(data.entry, sourceId, data.identity, authorityFor(data), [substitute]),
    ).toBeUndefined();

    const coherentCalleeRecords: IrFnctorArgumentProjection = {
      ...projection,
      calleeUnitId: otherCallee.unitId,
      calleeDeclaration: otherCallee.declaration,
      calleeParameterDeclaration: otherCallee.declaration.parameters[0]!,
    };
    expect(
      retainIrFnctorArgumentProjections(data.entry, sourceId, data.identity, authorityFor(data), [
        coherentCalleeRecords,
      ]),
    ).toBeUndefined();

    const coherentConstructorRecords: IrFnctorArgumentProjection = {
      ...projection,
      constructorUnitId: otherConstructor.unitId,
      constructorDeclaration: otherConstructor.declaration,
      constructorParameterDeclaration: otherConstructor.declaration.parameters[0]!,
      constructorSyntax: otherSyntax,
      physicalReservation: {
        ...projection.physicalReservation,
        constructorUnitId: otherConstructor.unitId,
        constructorDeclaration: otherConstructor.declaration,
      },
    };
    expect(
      retainIrFnctorArgumentProjections(data.entry, sourceId, data.identity, authorityFor(data), [
        coherentConstructorRecords,
      ]),
    ).toBeUndefined();
  });

  it("fails closed when any retained identity, AST, reservation, or logical-shape join changes", () => {
    const data = fixture({ otherText: "export function foreign() { return 0; }" });
    const projection = projections(data)[0]!;
    const caller = terminalId(data, "run");
    const callee = terminalId(data, "readNumber");
    const constructorUnit = terminalId(data, "Parser");
    const foreignSourceId = data.identity.sourceIdBySourceFile.get(data.other!)!;
    const factorySite = ts.factory.createNewExpression(ts.factory.createIdentifier("Parser"), undefined, [
      ts.factory.createStringLiteral("x"),
    ]);
    const detachedCall = ts.factory.createCallExpression(ts.factory.createIdentifier("readNumber"), undefined, [
      projection.constructorSite,
    ]);
    const detachedAssignment = ts.factory.createBinaryExpression(
      ts.factory.createPropertyAccessExpression(ts.factory.createThis(), "input"),
      ts.factory.createToken(ts.SyntaxKind.EqualsToken),
      ts.factory.createIdentifier("input"),
    );
    const detachedStatement = ts.factory.createExpressionStatement(detachedAssignment);
    const mutations: readonly [string, (value: IrFnctorArgumentProjection) => IrFnctorArgumentProjection][] = [
      ["record kind", (value) => ({ ...value, kind: "other" as IrFnctorArgumentProjection["kind"] })],
      ["source id", (value) => ({ ...value, sourceId: foreignSourceId })],
      ["source file", (value) => ({ ...value, sourceFile: data.other! })],
      ["caller unit", (value) => ({ ...value, callerUnitId: callee.unitId })],
      ["caller declaration", (value) => ({ ...value, callerDeclaration: callee.declaration })],
      ["direct call", (value) => ({ ...value, directCall: firstCallIn(projection.calleeDeclaration) })],
      ["direct call reverse parent", (value) => ({ ...value, directCall: detachedCall })],
      ["callee unit", (value) => ({ ...value, calleeUnitId: caller.unitId })],
      ["callee declaration", (value) => ({ ...value, calleeDeclaration: caller.declaration })],
      [
        "callee parameter",
        (value) => ({ ...value, calleeParameterDeclaration: constructorUnit.declaration.parameters[0]! }),
      ],
      ["callee parameter index", (value) => ({ ...value, calleeParameterIndex: 1 as 0 })],
      ["constructor unit", (value) => ({ ...value, constructorUnitId: callee.unitId })],
      ["constructor declaration", (value) => ({ ...value, constructorDeclaration: callee.declaration })],
      [
        "constructor parameter",
        (value) => ({ ...value, constructorParameterDeclaration: callee.declaration.parameters[0]! }),
      ],
      ["constructor parameter index", (value) => ({ ...value, constructorParameterIndex: 1 as 0 })],
      ["constructor site", (value) => ({ ...value, constructorSite: factorySite })],
      ["allocation argument", (value) => ({ ...value, allocationArgument: ts.factory.createStringLiteral("x") })],
      [
        "constructor syntax source",
        (value) => ({ ...value, constructorSyntax: { ...value.constructorSyntax, sourceId: foreignSourceId } }),
      ],
      [
        "constructor syntax source file",
        (value) => ({ ...value, constructorSyntax: { ...value.constructorSyntax, sourceFile: data.other! } }),
      ],
      [
        "constructor syntax kind",
        (value) => ({
          ...value,
          constructorSyntax: {
            ...value.constructorSyntax,
            kind: "other" as IrFnctorArgumentProjection["constructorSyntax"]["kind"],
          },
        }),
      ],
      [
        "constructor syntax unit",
        (value) => ({
          ...value,
          constructorSyntax: { ...value.constructorSyntax, constructorUnitId: callee.unitId },
        }),
      ],
      [
        "constructor syntax declaration",
        (value) => ({
          ...value,
          constructorSyntax: { ...value.constructorSyntax, constructorDeclaration: callee.declaration },
        }),
      ],
      [
        "constructor syntax parameter",
        (value) => ({
          ...value,
          constructorSyntax: {
            ...value.constructorSyntax,
            parameterDeclaration: callee.declaration.parameters[0]!,
          },
        }),
      ],
      [
        "constructor syntax parameter index",
        (value) => ({
          ...value,
          constructorSyntax: { ...value.constructorSyntax, parameterIndex: 1 as 0 },
        }),
      ],
      [
        "constructor syntax statement",
        (value) => ({
          ...value,
          constructorSyntax: { ...value.constructorSyntax, assignmentStatement: detachedStatement },
        }),
      ],
      [
        "constructor syntax assignment",
        (value) => ({
          ...value,
          constructorSyntax: { ...value.constructorSyntax, inputAssignment: detachedAssignment },
        }),
      ],
      [
        "reservation kind",
        (value) => ({
          ...value,
          physicalReservation: {
            ...value.physicalReservation,
            kind: "other" as IrFnctorArgumentProjection["physicalReservation"]["kind"],
          },
        }),
      ],
      [
        "reservation source",
        (value) => ({
          ...value,
          physicalReservation: { ...value.physicalReservation, sourceId: foreignSourceId },
        }),
      ],
      [
        "reservation unit",
        (value) => ({
          ...value,
          physicalReservation: { ...value.physicalReservation, constructorUnitId: callee.unitId },
        }),
      ],
      [
        "reservation declaration",
        (value) => ({
          ...value,
          physicalReservation: { ...value.physicalReservation, constructorDeclaration: callee.declaration },
        }),
      ],
      [
        "reservation site",
        (value) => ({ ...value, physicalReservation: { ...value.physicalReservation, constructorSite: factorySite } }),
      ],
      [
        "reservation key",
        (value) => ({ ...value, physicalReservation: { ...value.physicalReservation, reservationKey: "wrong" } }),
      ],
      [
        "reservation index",
        (value) => ({ ...value, physicalReservation: { ...value.physicalReservation, reservedTypeIdx: -1 } }),
      ],
      [
        "logical field",
        (value) => ({ ...value, logicalShape: { ...value.logicalShape, fieldName: "other" as "input" } }),
      ],
      [
        "logical type",
        (value) => ({ ...value, logicalShape: { ...value.logicalShape, fieldType: "f64" as "string" } }),
      ],
    ];
    const sourceId = data.identity.sourceIdBySourceFile.get(data.entry)!;
    for (const [label, mutate] of mutations) {
      expect(
        retainIrFnctorArgumentProjections(data.entry, sourceId, data.identity, authorityFor(data), [
          mutate(projection),
        ]),
        label,
      ).toBeUndefined();
    }
  });

  it("fails closed for every constructor and argument proof bit and never accepts a forged noEscape fact", () => {
    const data = fixture();
    const projection = projections(data)[0]!;
    const sourceId = data.identity.sourceIdBySourceFile.get(data.entry)!;
    for (const key of Object.keys(projection.constructorSyntax.proof)) {
      const proof = { ...projection.constructorSyntax.proof, [key]: false };
      const candidate = {
        ...projection,
        constructorSyntax: { ...projection.constructorSyntax, proof },
      } as unknown as IrFnctorArgumentProjection;
      expect(
        retainIrFnctorArgumentProjections(data.entry, sourceId, data.identity, authorityFor(data), [candidate]),
        key,
      ).toBeUndefined();
    }
    for (const key of Object.keys(projection.proof)) {
      const candidate = {
        ...projection,
        proof: { ...projection.proof, [key]: false },
      } as unknown as IrFnctorArgumentProjection;
      expect(
        retainIrFnctorArgumentProjections(data.entry, sourceId, data.identity, authorityFor(data), [candidate]),
        key,
      ).toBeUndefined();
    }
    const forged = {
      ...projection,
      proof: { ...projection.proof, noEscape: true },
    } as unknown as IrFnctorArgumentProjection;
    expect(
      retainIrFnctorArgumentProjections(data.entry, sourceId, data.identity, authorityFor(data), [forged]),
    ).toBeUndefined();
  });

  it("retains a fresh deeply frozen canonical row instead of a caller-owned mutable clone", () => {
    const data = fixture();
    const projection = projections(data)[0]!;
    const sourceId = data.identity.sourceIdBySourceFile.get(data.entry)!;
    const mutable = {
      ...projection,
      constructorSyntax: {
        ...projection.constructorSyntax,
        proof: { ...projection.constructorSyntax.proof },
      },
      physicalReservation: { ...projection.physicalReservation },
      logicalShape: { ...projection.logicalShape },
      proof: { ...projection.proof },
      callerOwnedExtra: true,
    } as IrFnctorArgumentProjection & { callerOwnedExtra: boolean };
    const retained = retainIrFnctorArgumentProjections(data.entry, sourceId, data.identity, authorityFor(data), [
      mutable,
    ]);
    expect(retained).toHaveLength(1);
    const canonical = retained![0]!;
    expect(canonical).not.toBe(mutable);
    expect(canonical.constructorSyntax).not.toBe(mutable.constructorSyntax);
    expect(canonical.constructorSyntax.proof).not.toBe(mutable.constructorSyntax.proof);
    expect(canonical.physicalReservation).not.toBe(mutable.physicalReservation);
    expect(canonical.logicalShape).not.toBe(mutable.logicalShape);
    expect(canonical.proof).not.toBe(mutable.proof);
    expect("callerOwnedExtra" in canonical).toBe(false);
    expect(Object.isFrozen(retained)).toBe(true);
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(Object.isFrozen(canonical.constructorSyntax)).toBe(true);
    expect(Object.isFrozen(canonical.constructorSyntax.proof)).toBe(true);
    expect(Object.isFrozen(canonical.physicalReservation)).toBe(true);
    expect(Object.isFrozen(canonical.logicalShape)).toBe(true);
    expect(Object.isFrozen(canonical.proof)).toBe(true);

    const writable = mutable as unknown as {
      constructorSyntax: { proof: { sameSource: boolean } };
      physicalReservation: { reservedTypeIdx: number };
      logicalShape: { fieldName: string };
      proof: { noAlias: boolean };
    };
    writable.constructorSyntax.proof.sameSource = false;
    writable.physicalReservation.reservedTypeIdx = -1;
    writable.logicalShape.fieldName = "other";
    writable.proof.noAlias = false;
    expect(canonical.constructorSyntax.proof.sameSource).toBe(true);
    expect(canonical.physicalReservation.reservedTypeIdx).toBe(7);
    expect(canonical.logicalShape.fieldName).toBe("input");
    expect(canonical.proof.noAlias).toBe(true);
  });

  it("rejects missing and duplicate retained rows", () => {
    const data = fixture();
    const projection = projections(data)[0]!;
    const sourceId = data.identity.sourceIdBySourceFile.get(data.entry)!;
    expect(
      retainIrFnctorArgumentProjections(data.entry, sourceId, data.identity, authorityFor(data), []),
    ).toBeUndefined();
    expect(
      retainIrFnctorArgumentProjections(data.entry, sourceId, data.identity, authorityFor(data), [
        projection,
        projection,
      ]),
    ).toBeUndefined();
  });
});

interface PreselectionHarness {
  readonly ctx: CodegenContext;
  readonly projection: IrFnctorArgumentProjection;
  readonly callable: WasmFunction;
  readonly callableType: FuncTypeDef;
  readonly sourceRegistry: {
    ctx: CodegenContext;
    identityContext: IrPlanningIdentityContext;
    handle: number | undefined;
    func: WasmFunction | undefined;
    handleForUnit(unitId: string): number | undefined;
    functionForUnit(unitId: string): WasmFunction | undefined;
  };
  readonly fnctorRegistry: {
    ctx: CodegenContext;
    identityContext: IrPlanningIdentityContext;
    loweringPatch: Partial<IrFnctorLowering>;
    fieldPatch: Partial<ReturnType<IrFnctorLowering["field"]>>;
    resolveNull: boolean;
    resolve(shape: IrFnctorShape): IrFnctorLowering | null;
  };
}

function makePreselectionHarness(data: Fixture): PreselectionHarness {
  const ctx = contextFor(data);
  const projection = projections(data, ctx)[0]!;
  const instanceCarrier = { kind: "ref_null" as const, typeIdx: 7 };
  const callableType: FuncTypeDef = {
    kind: "func",
    params: [instanceCarrier],
    results: [{ kind: "f64" }],
  };
  const callable: WasmFunction = {
    name: "readNumber",
    typeIdx: 8,
    locals: [],
    body: [],
    exported: false,
  };
  Object.assign(ctx, {
    irPlanningIdentityContext: data.identity,
    anyStrTypeIdx: 9,
    numImportFuncs: 0,
    mod: {
      types: [
        { kind: "func", params: [], results: [] },
        { kind: "func", params: [], results: [] },
        { kind: "func", params: [], results: [] },
        { kind: "func", params: [], results: [] },
        { kind: "func", params: [], results: [] },
        { kind: "func", params: [], results: [] },
        { kind: "func", params: [], results: [] },
        { kind: "struct", name: "__fnctor_Parser", fields: [] },
        callableType,
        { kind: "struct", name: "$AnyString", fields: [] },
      ],
      functions: [callable],
      imports: [],
      globals: [],
      exports: [],
      funcOrdinalToPosition: [],
    },
  });
  const sourceRegistry: PreselectionHarness["sourceRegistry"] = {
    ctx,
    identityContext: data.identity,
    handle: 0,
    func: callable,
    handleForUnit(unitId) {
      return unitId === projection.calleeUnitId ? this.handle : undefined;
    },
    functionForUnit(unitId) {
      return unitId === projection.calleeUnitId ? this.func : undefined;
    },
  };
  const fnctorRegistry: PreselectionHarness["fnctorRegistry"] = {
    ctx,
    identityContext: data.identity,
    loweringPatch: {},
    fieldPatch: {},
    resolveNull: false,
    resolve(shapeValue) {
      if (this.resolveNull) return null;
      const shape = shapeValue;
      const field = {
        fieldIdx: 0,
        logicalType: { kind: "string" as const },
        physicalType: { kind: "ref_null" as const, typeIdx: 9 },
        refinement: "nullable-native-string" as const,
        ...this.fieldPatch,
      };
      return {
        instanceCarrierType: instanceCarrier,
        constructorResultType: { kind: "ref", typeIdx: 7 },
        reservedLayout: shape.reservedLayout,
        constructorFunc: shape.constructorTarget,
        captureParamTypes: [],
        tdzFlagParamTypes: [],
        userParamTypes: [{ kind: "externref" }],
        hiddenIdentity: true,
        constructorIdentityParamIndex: 1,
        resultIsExternref: false,
        supportsConstruction: false,
        supportsFieldGet: true,
        structTypeIdx: 7,
        field: () => field,
        fieldIdx: () => field.fieldIdx,
        ...this.loweringPatch,
      };
    },
  };
  Object.assign(ctx, {
    programAbiSourceCallables: sourceRegistry,
    programAbiFnctors: fnctorRegistry,
  });
  return { ctx, projection, callable, callableType, sourceRegistry, fnctorRegistry };
}

function preselectionPlan(data: Fixture, harness: PreselectionHarness = makePreselectionHarness(data)) {
  return planIrFnctorParameterPreselection({
    ctx: harness.ctx,
    sourceFile: data.entry,
    identityContext: data.identity,
    route: EXACT_ROUTE,
    authority: authorityFor(data, harness.ctx),
    projections: [harness.projection],
  });
}

describe("#3521 linked fnctor parameter preselection", () => {
  it("joins the exact retained edge, get-only layout, and current source-callable slot", () => {
    const data = fixture();
    const harness = makePreselectionHarness(data);
    const plan = preselectionPlan(data, harness);

    expect(plan).toMatchObject({
      kind: "fnctor-parameter-preselection",
      ownerUnitId: harness.projection.calleeUnitId,
      selectorKind: "object",
      parameterDeclaration: harness.projection.calleeParameterDeclaration,
      parameterIndex: 0,
      overrideType: { kind: "fnctor" },
      physical: {
        instanceCarrier: { kind: "ref_null", typeIdx: 7 },
        fieldCarrier: { kind: "ref_null", typeIdx: 9 },
        fieldIndex: 0,
        fieldRefinement: "nullable-native-string",
      },
      preselection: {
        handle: 0,
        func: harness.callable,
        typeIdx: 8,
        type: harness.callableType,
      },
    });
    expect(plan!.fieldReads).toHaveLength(2);
    expect(plan!.fieldReads.every((row) => row.access.name.text === "input")).toBe(true);
    expect(plan!.stringSliceCall.expression.getText()).toBe("parser.input.slice");
    expect(plan!.valueConsumerCall.arguments[0]).toBe(plan!.stringSliceCall);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan!.shape)).toBe(true);
    expect(Object.isFrozen(plan!.fieldReads)).toBe(true);
    expect(Object.isFrozen(plan!.physical.instanceCarrier)).toBe(true);
    expect(irFnctorParameterPreselectionIsCurrent(harness.ctx, plan!)).toBe(true);
  });

  it.each([
    ["missing rows", []],
    ["duplicate rows", null],
  ])("rejects %s before consulting mutable ABI state", (_label, rows) => {
    const data = fixture();
    const harness = makePreselectionHarness(data);
    const projectionsValue = rows === null ? [harness.projection, harness.projection] : rows;
    expect(
      planIrFnctorParameterPreselection({
        ctx: harness.ctx,
        sourceFile: data.entry,
        identityContext: data.identity,
        route: EXACT_ROUTE,
        authority: authorityFor(data, harness.ctx),
        projections: projectionsValue,
      }),
    ).toBeUndefined();
  });

  it("rejects missing or stale fnctor/source-callable authorities", () => {
    const data = fixture();
    const mutations: readonly [string, (harness: PreselectionHarness) => void][] = [
      ["unresolved fnctor", (harness) => (harness.fnctorRegistry.resolveNull = true)],
      ["foreign fnctor context", (harness) => (harness.fnctorRegistry.ctx = {} as CodegenContext)],
      ["foreign source registry", (harness) => (harness.sourceRegistry.ctx = {} as CodegenContext)],
      ["missing handle", (harness) => (harness.sourceRegistry.handle = undefined)],
      ["missing function", (harness) => (harness.sourceRegistry.func = undefined)],
      [
        "stale function object",
        (harness) =>
          (harness.sourceRegistry.func = {
            ...harness.callable,
            body: [],
          }),
      ],
      ["stale type index", (harness) => (harness.callable.typeIdx = 6)],
    ];
    for (const [label, mutate] of mutations) {
      const harness = makePreselectionHarness(data);
      mutate(harness);
      expect(preselectionPlan(data, harness), label).toBeUndefined();
    }
  });

  it("rejects every get-only carrier/refinement capability mismatch", () => {
    const data = fixture();
    const mutations: readonly [string, (harness: PreselectionHarness) => void][] = [
      ["construction enabled", (harness) => (harness.fnctorRegistry.loweringPatch = { supportsConstruction: true })],
      ["field get disabled", (harness) => (harness.fnctorRegistry.loweringPatch = { supportsFieldGet: false })],
      [
        "wrong instance carrier",
        (harness) => (harness.fnctorRegistry.loweringPatch = { instanceCarrierType: { kind: "ref", typeIdx: 7 } }),
      ],
      [
        "wrong constructor result",
        (harness) =>
          (harness.fnctorRegistry.loweringPatch = { constructorResultType: { kind: "ref_null", typeIdx: 7 } }),
      ],
      ["wrong field index", (harness) => (harness.fnctorRegistry.fieldPatch = { fieldIdx: 1 })],
      [
        "wrong field carrier",
        (harness) => (harness.fnctorRegistry.fieldPatch = { physicalType: { kind: "ref_null", typeIdx: 7 } }),
      ],
      ["missing refinement", (harness) => (harness.fnctorRegistry.fieldPatch = { refinement: "none" })],
    ];
    for (const [label, mutate] of mutations) {
      const harness = makePreselectionHarness(data);
      mutate(harness);
      expect(preselectionPlan(data, harness), label).toBeUndefined();
    }
  });

  it.each([
    ["another field", BASE_SOURCE.replaceAll("parser.input", "parser.value")],
    ["optional field", BASE_SOURCE.replace("parser.input.slice", "parser?.input.slice")],
    ["another method", BASE_SOURCE.replace(".slice(0, parser.input.length)", ".substring(0, parser.input.length)")],
    ["another start", BASE_SOURCE.replace(".slice(0, parser.input.length)", ".slice(1, parser.input.length)")],
    ["extra use", BASE_SOURCE.replace("var octal = false;", "var octal = parser.input === ''; ")],
  ])("rejects the %s parameter-use topology", (_label, entryText) => {
    const data = fixture({ entryText });
    const harness = makePreselectionHarness(data);
    expect(preselectionPlan(data, harness)).toBeUndefined();
  });

  it("detects callable and fnctor drift after construction", () => {
    const data = fixture();
    const harness = makePreselectionHarness(data);
    const plan = preselectionPlan(data, harness)!;
    expect(irFnctorParameterPreselectionIsCurrent(harness.ctx, plan)).toBe(true);

    harness.callableType.params[0] = { kind: "ref", typeIdx: 7 } satisfies ValType;
    expect(irFnctorParameterPreselectionIsCurrent(harness.ctx, plan)).toBe(false);
    harness.callableType.params[0] = { kind: "ref_null", typeIdx: 7 };
    harness.fnctorRegistry.fieldPatch = { refinement: "none" };
    expect(irFnctorParameterPreselectionIsCurrent(harness.ctx, plan)).toBe(false);
  });
});
