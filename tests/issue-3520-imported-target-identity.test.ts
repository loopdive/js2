// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { buildIrUnitInventory, type IrUnitId } from "../src/ir/identity.js";
import {
  makeIrIdentityImportedFunctionResolver,
  makeIrImportedFunctionResolver,
  projectIrIdentityImportedFunctionResolverToLegacy,
  projectIrIdentityImportedTargetToLegacy,
  type IrIdentityImportedFunctionResolver,
  type IrImportedFunctionResolver,
} from "../src/ir/imported-functions.js";
import {
  buildIrPlanningIdentityContext,
  IrPlanningIdentityInvariantError,
  type IrPlanningIdentityContext,
  type IrPlanningIdentityInvariantCode,
} from "../src/ir/planning-identity.js";
import { ts } from "../src/ts-api.js";

const IDENTITY_RESOLVER_IS_LEGACY_ASSIGNABLE: [IrIdentityImportedFunctionResolver] extends [IrImportedFunctionResolver]
  ? true
  : false = false;

interface Fixture {
  readonly checker: ts.TypeChecker;
  readonly sourceFiles: readonly ts.SourceFile[];
  readonly byName: ReadonlyMap<string, ts.SourceFile>;
  readonly context: IrPlanningIdentityContext;
}

function fixture(
  files: Readonly<Record<string, string>>,
  rootOrder = Object.keys(files),
  inventoryOrder = rootOrder,
): Fixture {
  const textByName = new Map(Object.entries(files));
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    noLib: true,
    strict: false,
    target: ts.ScriptTarget.ES2022,
  };
  const host: ts.CompilerHost = {
    fileExists: (fileName) => textByName.has(fileName),
    readFile: (fileName) => textByName.get(fileName),
    getSourceFile: (fileName, languageVersion) => {
      const text = textByName.get(fileName);
      return text === undefined
        ? undefined
        : ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.TS);
    },
    getDefaultLibFileName: () => "/repo/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/repo",
    getDirectories: () => [],
    directoryExists: (directoryName) => directoryName === "/repo",
    realpath: (path) => path,
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram(rootOrder, options, host);
  const checker = program.getTypeChecker();
  const byName = new Map(rootOrder.map((fileName) => [fileName, program.getSourceFile(fileName)!] as const));
  const sourceFiles = rootOrder.map((fileName) => byName.get(fileName)!);
  const inventoryFiles = inventoryOrder.map((fileName) => byName.get(fileName)!);
  const entrySource = byName.get("/repo/entry.ts") ?? inventoryFiles[0]!;
  const inventory = buildIrUnitInventory(inventoryFiles, { checker, entrySource });
  return { checker, sourceFiles, byName, context: buildIrPlanningIdentityContext(inventory) };
}

function callIdentifier(sourceFile: ts.SourceFile, name: string): ts.Identifier {
  let found: ts.Identifier | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      found = node.expression;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`missing call identifier ${name}`);
  return found;
}

function functionDeclaration(sourceFile: ts.SourceFile, name?: string): ts.FunctionDeclaration {
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.body !== undefined && statement.name?.text === name,
  );
  if (!declaration) throw new Error(`missing function declaration ${name ?? "<anonymous>"}`);
  return declaration;
}

function functionId(context: IrPlanningIdentityContext, declaration: ts.FunctionDeclaration): IrUnitId {
  const unitId = context.unitIdByDeclaration.get(declaration);
  if (!unitId) throw new Error("missing fixture function identity");
  return unitId;
}

function expectPlanningError(run: () => unknown, code: IrPlanningIdentityInvariantCode): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(IrPlanningIdentityInvariantError);
  expect(caught).toMatchObject({ code });
}

describe("#3520 imported target identity", () => {
  it("resolves renamed and anonymous-default imports to exact declaration IDs", () => {
    const graph = fixture({
      "/repo/provider.ts": `
        export function sourceName(value: number): number { return value + 1; }
        export default function (value: number): number { return value + 2; }
        sourceName(0);
      `,
      "/repo/entry.ts": `
        import localDefault, { sourceName as renamed } from "./provider";
        renamed(1);
        localDefault(2);
      `,
    });
    const entry = graph.byName.get("/repo/entry.ts")!;
    const provider = graph.byName.get("/repo/provider.ts")!;
    const namedDeclaration = functionDeclaration(provider, "sourceName");
    const defaultDeclaration = functionDeclaration(provider);
    const resolver = makeIrIdentityImportedFunctionResolver(graph.checker, graph.sourceFiles, graph.context);

    const renamed = resolver.resolveImportedFunctionTarget(callIdentifier(entry, "renamed"))!;
    const defaultTarget = resolver.resolveImportedFunctionTarget(callIdentifier(entry, "localDefault"))!;
    expect(renamed).toMatchObject({
      targetUnitId: functionId(graph.context, namedDeclaration),
      targetName: "sourceName",
      declaration: namedDeclaration,
      legacyProjection: "unambiguous",
    });
    expect(defaultTarget).toMatchObject({
      targetUnitId: functionId(graph.context, defaultDeclaration),
      targetName: "default",
      declaration: defaultDeclaration,
      legacyProjection: "unambiguous",
    });
    expect(projectIrIdentityImportedTargetToLegacy(renamed)).toEqual({
      targetName: "sourceName",
      declaration: namedDeclaration,
    });
    const projectedResolver = projectIrIdentityImportedFunctionResolverToLegacy(resolver);
    expect(projectedResolver.resolveImportedFunction(callIdentifier(entry, "renamed"))).toEqual({
      targetName: "sourceName",
      declaration: namedDeclaration,
    });
    expect(projectedResolver.resolveTopLevelFunctionValue(callIdentifier(provider, "sourceName"))).toEqual({
      targetName: "sourceName",
      declaration: namedDeclaration,
    });

    const overloadFactory = makeIrImportedFunctionResolver(graph.checker, graph.sourceFiles, graph.context);
    expect(overloadFactory.resolveImportedFunctionTarget(callIdentifier(entry, "renamed"))?.targetUnitId).toBe(
      renamed.targetUnitId,
    );
    expect(IDENTITY_RESOLVER_IS_LEGACY_ASSIGNABLE).toBe(false);
    expect(
      makeIrImportedFunctionResolver(graph.checker, graph.sourceFiles).resolveImportedFunction(
        callIdentifier(entry, "localDefault"),
      ),
    ).toEqual({ targetName: "default", declaration: defaultDeclaration });
  });

  it("keeps same-labeled cross-source targets distinct and order-independent before legacy projection", () => {
    const files = {
      "/repo/a.ts": `export function same(value: number): number { return value + 1; }`,
      "/repo/b.ts": `export function same(value: number): number { return value + 2; }`,
      "/repo/entry.ts": `
        import { same as fromA } from "./a";
        import { same as fromB } from "./b";
        fromA(1);
        fromB(1);
      `,
    } as const;
    const forward = fixture(files, ["/repo/entry.ts", "/repo/a.ts", "/repo/b.ts"]);
    const reversed = fixture(
      files,
      ["/repo/b.ts", "/repo/a.ts", "/repo/entry.ts"],
      ["/repo/b.ts", "/repo/entry.ts", "/repo/a.ts"],
    );

    const resolve = (
      graph: Fixture,
    ): readonly [
      ReturnType<ReturnType<typeof makeIrIdentityImportedFunctionResolver>["resolveImportedFunctionTarget"]>,
      ReturnType<ReturnType<typeof makeIrIdentityImportedFunctionResolver>["resolveImportedFunctionTarget"]>,
    ] => {
      const entry = graph.byName.get("/repo/entry.ts")!;
      const resolver = makeIrIdentityImportedFunctionResolver(graph.checker, graph.sourceFiles, graph.context);
      return [
        resolver.resolveImportedFunctionTarget(callIdentifier(entry, "fromA")),
        resolver.resolveImportedFunctionTarget(callIdentifier(entry, "fromB")),
      ];
    };
    const [forwardA, forwardB] = resolve(forward);
    const [reversedA, reversedB] = resolve(reversed);

    expect(forwardA).toBeDefined();
    expect(forwardB).toBeDefined();
    expect(forwardA!.targetUnitId).not.toBe(forwardB!.targetUnitId);
    expect([forwardA!.targetName, forwardB!.targetName]).toEqual(["same", "same"]);
    expect([forwardA!.legacyProjection, forwardB!.legacyProjection]).toEqual(["ambiguous", "ambiguous"]);
    expect(projectIrIdentityImportedTargetToLegacy(forwardA!)).toBeUndefined();
    expect(projectIrIdentityImportedTargetToLegacy(forwardB!)).toBeUndefined();
    expect([reversedA!.targetUnitId, reversedB!.targetUnitId]).toEqual([
      forwardA!.targetUnitId,
      forwardB!.targetUnitId,
    ]);

    const legacy = makeIrImportedFunctionResolver(forward.checker, forward.sourceFiles);
    const forwardEntry = forward.byName.get("/repo/entry.ts")!;
    const exact = makeIrIdentityImportedFunctionResolver(forward.checker, forward.sourceFiles, forward.context);
    const projected = projectIrIdentityImportedFunctionResolverToLegacy(exact);
    expect(projected.resolveImportedFunction(callIdentifier(forwardEntry, "fromA"))).toBeUndefined();
    expect(projected.resolveImportedFunction(callIdentifier(forwardEntry, "fromB"))).toBeUndefined();
    expect(legacy.resolveImportedFunction(callIdentifier(forwardEntry, "fromA"))).toBeUndefined();
    expect(legacy.resolveImportedFunction(callIdentifier(forwardEntry, "fromB"))).toBeUndefined();
  });

  it("rejects cloned and stale source populations with typed planning invariants", () => {
    const graph = fixture({
      "/repo/provider.ts": `export function target(value: number): number { return value; }`,
      "/repo/entry.ts": `import { target } from "./provider"; target(1);`,
    });
    const entry = graph.byName.get("/repo/entry.ts")!;
    const provider = graph.byName.get("/repo/provider.ts")!;
    const clone = ts.createSourceFile(provider.fileName, provider.text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

    expectPlanningError(
      () => makeIrIdentityImportedFunctionResolver(graph.checker, [entry, clone], graph.context),
      "source-record-mismatch",
    );

    (provider as unknown as { statements: ts.NodeArray<ts.Statement> }).statements = ts.factory.createNodeArray();
    expectPlanningError(
      () => makeIrIdentityImportedFunctionResolver(graph.checker, graph.sourceFiles, graph.context),
      "unit-record-mismatch",
    );

    const bodyGraph = fixture({
      "/repo/provider.ts": `export function target(value: number): number { return value; }`,
      "/repo/entry.ts": `import { target } from "./provider"; target(1);`,
    });
    const bodyProvider = bodyGraph.byName.get("/repo/provider.ts")!;
    const bodyDeclaration = functionDeclaration(bodyProvider, "target");
    (bodyDeclaration as unknown as { body?: ts.Block }).body = undefined;
    expectPlanningError(
      () => makeIrIdentityImportedFunctionResolver(bodyGraph.checker, bodyGraph.sourceFiles, bodyGraph.context),
      "unit-record-mismatch",
    );
  });

  it("preserves overload and live-reassignment rejection while retaining stable IDs", () => {
    const graph = fixture({
      "/repo/provider.ts": `
        function overloaded(value: number): number;
        function overloaded(value: number): number { return value; }
        export { overloaded };
        export function live(value: number): number { return value + 1; }
        [live] = [function (value: number): number { return value + 2; }];
        export function stable(value: number): number { return value + 3; }
      `,
      "/repo/entry.ts": `
        import { overloaded, live, stable } from "./provider";
        overloaded(1);
        live(1);
        stable(1);
      `,
    });
    const entry = graph.byName.get("/repo/entry.ts")!;
    const provider = graph.byName.get("/repo/provider.ts")!;
    const resolver = makeIrIdentityImportedFunctionResolver(graph.checker, graph.sourceFiles, graph.context);

    expect(resolver.resolveImportedFunctionTarget(callIdentifier(entry, "overloaded"))).toBeUndefined();
    expect(resolver.resolveImportedFunctionTarget(callIdentifier(entry, "live"))).toBeUndefined();
    const stableDeclaration = functionDeclaration(provider, "stable");
    expect(resolver.resolveImportedFunctionTarget(callIdentifier(entry, "stable"))).toMatchObject({
      targetUnitId: functionId(graph.context, stableDeclaration),
      targetName: "stable",
      declaration: stableDeclaration,
      legacyProjection: "unambiguous",
    });

    const legacy = makeIrImportedFunctionResolver(graph.checker, graph.sourceFiles);
    expect(legacy.resolveImportedFunction(callIdentifier(entry, "overloaded"))).toBeUndefined();
    expect(legacy.resolveImportedFunction(callIdentifier(entry, "live"))).toBeUndefined();
    expect(legacy.resolveImportedFunction(callIdentifier(entry, "stable"))).toEqual({
      targetName: "stable",
      declaration: stableDeclaration,
    });
  });
});
