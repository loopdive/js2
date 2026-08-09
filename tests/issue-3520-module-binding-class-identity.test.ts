// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { buildIrUnitInventory, type IrClassId, type IrUnitId } from "../src/ir/identity.js";
import {
  makeIrIdentityLocalClassExpressionResolver,
  makeIrIdentityModuleBindingResolver,
  makeIrLocalClassExpressionResolver,
  makeIrModuleBindingResolver,
  projectIrLocalClassExpressionResolverToLegacy,
  projectIrModuleBindingResolverToLegacy,
  type IrLegacyLocalClassExpressionResolver,
  type IrLegacyModuleBindingResolver,
  type IrLocalClassExpressionResolver,
  type IrModuleBindingResolver,
} from "../src/ir/module-bindings.js";
import type { IrClassShape } from "../src/ir/nodes.js";
import {
  buildIrPlanningIdentityContext,
  IrPlanningIdentityInvariantError,
  type IrPlanningIdentityContext,
  type IrPlanningIdentityInvariantCode,
} from "../src/ir/planning-identity.js";
import { ts } from "../src/ts-api.js";

const LEGACY_MODULE_RESOLVER_IS_EXACT: [IrLegacyModuleBindingResolver] extends [IrModuleBindingResolver]
  ? true
  : false = false;
const LEGACY_CLASS_RESOLVER_IS_EXACT: [IrLegacyLocalClassExpressionResolver] extends [IrLocalClassExpressionResolver]
  ? true
  : false = false;

const MODULE_OPTIONS = {
  numberStorage: "f64",
  allowHostExterns: false,
  allowBuiltinMapExtern: false,
} as const;

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
  const entrySource = byName.get("/repo/a.ts") ?? inventoryFiles[0]!;
  const inventory = buildIrUnitInventory(inventoryFiles, { checker, entrySource });
  return { checker, sourceFiles, byName, context: buildIrPlanningIdentityContext(inventory) };
}

function collectNodes<T extends ts.Node>(root: ts.Node, guard: (node: ts.Node) => node is T): T[] {
  const nodes: T[] = [];
  const visit = (node: ts.Node): void => {
    if (guard(node)) nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return nodes;
}

function functionDeclaration(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!declaration) throw new Error(`missing function ${name}`);
  return declaration;
}

function classDeclaration(sourceFile: ts.SourceFile, name: string): ts.ClassDeclaration {
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement) && statement.name?.text === name,
  );
  if (!declaration) throw new Error(`missing class ${name}`);
  return declaration;
}

function unitId(context: IrPlanningIdentityContext, declaration: ts.Node): IrUnitId {
  const id = context.unitIdByDeclaration.get(declaration);
  if (!id) throw new Error("missing unit identity");
  return id;
}

function classId(context: IrPlanningIdentityContext, declaration: ts.ClassDeclaration): IrClassId {
  const id = context.classIdByDeclaration.get(declaration);
  if (!id) throw new Error("missing class identity");
  return id;
}

function propertyReceiver(root: ts.Node, name: string): ts.Identifier {
  const receiver = collectNodes(
    root,
    (node): node is ts.Identifier =>
      ts.isIdentifier(node) &&
      node.text === name &&
      ts.isPropertyAccessExpression(node.parent) &&
      node.parent.expression === node,
  )[0];
  if (!receiver) throw new Error(`missing property receiver ${name}`);
  return receiver;
}

function identifierUse(root: ts.Node, name: string): ts.Identifier {
  const identifier = collectNodes(
    root,
    (node): node is ts.Identifier =>
      ts.isIdentifier(node) &&
      node.text === name &&
      !(ts.isVariableDeclaration(node.parent) && node.parent.name === node),
  )[0];
  if (!identifier) throw new Error(`missing identifier use ${name}`);
  return identifier;
}

function projected(classId: IrClassId, name: string): IrClassShape {
  return { classId, className: name, fields: [], methods: [], constructorParams: [] };
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

describe("#3520 module-binding and local-class identity", () => {
  it("attaches the exact terminal owner to each use of one module declaration", () => {
    const graph = fixture({
      "/repo/a.ts": `
        let shared: number = 1;
        const initialized: number = shared;
        export function read(): number { return shared; }
        class Box { read(): number { return shared; } }
        export function shadow(): number { const shared: number = 2; return shared; }
      `,
    });
    const sourceFile = graph.byName.get("/repo/a.ts")!;
    const read = functionDeclaration(sourceFile, "read");
    const boxRead = classDeclaration(sourceFile, "Box").members.find(
      (member): member is ts.MethodDeclaration => ts.isMethodDeclaration(member) && member.name.getText() === "read",
    )!;
    const shadow = functionDeclaration(sourceFile, "shadow");
    const initialized = sourceFile.statements.find(
      (statement): statement is ts.VariableStatement =>
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(
          (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "initialized",
        ),
    )!;
    const moduleUse = identifierUse(initialized, "shared");
    const functionUse = identifierUse(read, "shared");
    const memberUse = identifierUse(boxRead, "shared");
    const shadowUse = identifierUse(shadow, "shared");
    const declaration = sourceFile.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === "shared")!;
    const resolver = makeIrIdentityModuleBindingResolver(graph.checker, MODULE_OPTIONS, graph.context);

    const moduleBinding = resolver(moduleUse)!;
    const functionBinding = resolver(functionUse)!;
    const memberBinding = resolver(memberUse)!;
    expect(moduleBinding.declaration).toBe(declaration);
    expect(functionBinding.declaration).toBe(declaration);
    expect(memberBinding.declaration).toBe(declaration);
    expect(moduleBinding.ownerUnitId).toBe(graph.context.moduleInitUnitIdBySourceFile.get(sourceFile));
    expect(functionBinding.ownerUnitId).toBe(unitId(graph.context, read));
    expect(memberBinding.ownerUnitId).toBe(unitId(graph.context, boxRead));
    expect(moduleBinding.storageOwnerUnitId).toBe(moduleBinding.ownerUnitId);
    expect(functionBinding.storageOwnerUnitId).toBe(moduleBinding.ownerUnitId);
    expect(memberBinding.storageOwnerUnitId).toBe(moduleBinding.ownerUnitId);
    expect(functionBinding.ownerUnitId).not.toBe(moduleBinding.ownerUnitId);
    expect(memberBinding.ownerUnitId).not.toBe(functionBinding.ownerUnitId);
    expect(functionBinding.globalBindingId).toBe(moduleBinding.globalBindingId);
    expect(memberBinding.globalBindingId).toBe(moduleBinding.globalBindingId);
    expect(functionBinding.tdzBindingId).toBe(moduleBinding.tdzBindingId);
    expect(memberBinding.tdzBindingId).toBe(moduleBinding.tdzBindingId);
    expect(functionBinding.globalBindingId).not.toBe(functionBinding.tdzBindingId);
    expect(resolver(shadowUse)).toBeUndefined();

    const overloaded = makeIrModuleBindingResolver(graph.checker, MODULE_OPTIONS, graph.context);
    expect(overloaded(functionUse)?.ownerUnitId).toBe(functionBinding.ownerUnitId);
    const projectedResolver = projectIrModuleBindingResolverToLegacy(resolver);
    expect(projectedResolver(functionUse)).toEqual({
      declaration,
      mutable: true,
      valueKind: { kind: "f64" },
    });
    expect(makeIrModuleBindingResolver(graph.checker, MODULE_OPTIONS)(functionUse)).toEqual(
      projectedResolver(functionUse),
    );
    expect(LEGACY_MODULE_RESOLVER_IS_EXACT).toBe(false);
  });

  it("keeps same-labelled module storage distinct across sources and inventory order", () => {
    const files = {
      "/repo/a.ts": `let shared: number = 1; export function read(): number { return shared; }`,
      "/repo/b.ts": `let shared: number = 2; export function readB(): number { return shared; }`,
    } as const;
    const forward = fixture(files, ["/repo/a.ts", "/repo/b.ts"]);
    const reversed = fixture(files, ["/repo/b.ts", "/repo/a.ts"], ["/repo/b.ts", "/repo/a.ts"]);

    const bindingIds = (graph: Fixture): readonly [string, string] => {
      const a = graph.byName.get("/repo/a.ts")!;
      const b = graph.byName.get("/repo/b.ts")!;
      const resolver = makeIrIdentityModuleBindingResolver(graph.checker, MODULE_OPTIONS, graph.context);
      const aBinding = resolver(identifierUse(functionDeclaration(a, "read"), "shared"))!;
      const bBinding = resolver(identifierUse(functionDeclaration(b, "readB"), "shared"))!;
      expect(aBinding.declarationOrdinal).toBe(0);
      expect(bBinding.declarationOrdinal).toBe(0);
      expect(aBinding.globalBindingId).not.toBe(bBinding.globalBindingId);
      expect(aBinding.tdzBindingId).not.toBe(bBinding.tdzBindingId);
      return [aBinding.globalBindingId, bBinding.globalBindingId];
    };

    expect(bindingIds(reversed)).toEqual(bindingIds(forward));
  });

  it("keeps same-named classes exact across sources and inventory order", () => {
    const files = {
      "/repo/a.ts": `
        class Value { n: number; constructor(n: number) { this.n = n; } }
        export function read(flag: boolean, parameter: Value): number {
          const selected = flag ? new Value(1) : new Value(2);
          const alias = selected;
          return alias.n + parameter.n;
        }
        export function shadow(): number {
          class Value { n: number; constructor() { this.n = 3; } }
          const read = (value: Value): number => value.n;
          return read(new Value());
        }
      `,
      "/repo/b.ts": `
        class Value { n: number; constructor(n: number) { this.n = n; } }
        export function read(parameter: Value): number { return parameter.n; }
      `,
    } as const;
    const forward = fixture(files, ["/repo/a.ts", "/repo/b.ts"]);
    const reversed = fixture(files, ["/repo/b.ts", "/repo/a.ts"], ["/repo/b.ts", "/repo/a.ts"]);

    const resolveIds = (graph: Fixture): readonly [IrClassId, IrClassId] => {
      const a = graph.byName.get("/repo/a.ts")!;
      const b = graph.byName.get("/repo/b.ts")!;
      const aDeclaration = classDeclaration(a, "Value");
      const bDeclaration = classDeclaration(b, "Value");
      const expectedA = classId(graph.context, aDeclaration);
      const expectedB = classId(graph.context, bDeclaration);
      const shapesA = new Map([["Value", projected(expectedA, "Value")]]);
      const shapesB = new Map([["Value", projected(expectedB, "Value")]]);
      const resolveA = makeIrIdentityLocalClassExpressionResolver(graph.checker, a, shapesA, graph.context);
      const resolveB = makeIrLocalClassExpressionResolver(graph.checker, b, shapesB, graph.context);
      expectPlanningError(
        () => makeIrIdentityLocalClassExpressionResolver(graph.checker, a, shapesB, graph.context),
        "class-record-mismatch",
      );
      const readA = functionDeclaration(a, "read");
      const readB = functionDeclaration(b, "read");
      const conditional = collectNodes(readA, ts.isConditionalExpression)[0]!;
      const alias = propertyReceiver(readA, "alias");
      const parameterA = propertyReceiver(readA, "parameter");
      const parameterB = propertyReceiver(readB, "parameter");
      for (const expression of [conditional, alias, parameterA]) {
        expect(resolveA(expression)).toEqual({ classId: expectedA, legacyName: "Value" });
      }
      expect(resolveB(parameterB)).toEqual({ classId: expectedB, legacyName: "Value" });
      expect(expectedA).not.toBe(expectedB);
      expect(projectIrLocalClassExpressionResolverToLegacy(resolveA)(alias)).toBe("Value");
      expect(makeIrLocalClassExpressionResolver(graph.checker, a, shapesA)(alias)).toBe("Value");
      expect(LEGACY_CLASS_RESOLVER_IS_EXACT).toBe(false);

      const shadowParameter = propertyReceiver(functionDeclaration(a, "shadow"), "value");
      expect(resolveA(shadowParameter)).toBeUndefined();
      return [expectedA, expectedB];
    };

    expect(resolveIds(reversed)).toEqual(resolveIds(forward));
  });

  it("rejects same-text SourceFile clones with typed planning invariants", () => {
    const graph = fixture({
      "/repo/a.ts": `
        let shared: number = 1;
        class Value { n: number; constructor() { this.n = shared; } }
        export function read(value: Value): number { return value.n + shared; }
      `,
    });
    const original = graph.byName.get("/repo/a.ts")!;
    const valueClassId = classId(graph.context, classDeclaration(original, "Value"));
    const clone = ts.createSourceFile(original.fileName, original.text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const moduleResolver = makeIrIdentityModuleBindingResolver(graph.checker, MODULE_OPTIONS, graph.context);
    const classResolver = makeIrIdentityLocalClassExpressionResolver(
      graph.checker,
      original,
      new Map([["Value", projected(valueClassId, "Value")]]),
      graph.context,
    );
    const clonedRead = functionDeclaration(clone, "read");

    expectPlanningError(() => moduleResolver(identifierUse(clonedRead, "shared")), "source-record-mismatch");
    expectPlanningError(() => classResolver(propertyReceiver(clonedRead, "value")), "source-record-mismatch");
  });
});
