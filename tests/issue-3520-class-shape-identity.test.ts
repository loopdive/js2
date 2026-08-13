// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { TsCheckerOracle } from "../src/checker/oracle.js";
import {
  collectIrClassShapeDeclarations,
  createIrClassShapeSidecar,
  orderIrClassShapeDeclarationsForProjection,
  requireIrClassShapeClassId,
  resolveIrClassShapeFromType,
  resolveIrClassShapeFromTypeReference,
  resolveIrParentClassId,
  type IrClassShapeEntry,
} from "../src/codegen/ir-class-shapes.js";
import { buildIrUnitInventory, type IrClassId } from "../src/ir/identity.js";
import type { IrClassShape } from "../src/ir/nodes.js";
import {
  buildIrPlanningIdentityContext,
  IrPlanningIdentityInvariantError,
  type IrPlanningIdentityContext,
  type IrPlanningIdentityInvariantCode,
} from "../src/ir/planning-identity.js";
import { ts } from "../src/ts-api.js";

interface Fixture {
  readonly checker: ts.TypeChecker;
  readonly byName: ReadonlyMap<string, ts.SourceFile>;
  readonly context: IrPlanningIdentityContext;
}

function fixture(files: Readonly<Record<string, string>>): Fixture {
  const textByName = new Map(Object.entries(files));
  const rootNames = Object.keys(files);
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    noLib: true,
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
  const program = ts.createProgram(rootNames, options, host);
  const checker = program.getTypeChecker();
  const byName = new Map(rootNames.map((fileName) => [fileName, program.getSourceFile(fileName)!] as const));
  const sourceFiles = rootNames.map((fileName) => byName.get(fileName)!);
  const inventory = buildIrUnitInventory(sourceFiles, { checker, entrySource: sourceFiles[0]! });
  return { checker, byName, context: buildIrPlanningIdentityContext(inventory) };
}

function classDeclaration(sourceFile: ts.SourceFile, name: string): ts.ClassDeclaration {
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement) && statement.name?.text === name,
  );
  if (!declaration) throw new Error(`missing class ${name}`);
  return declaration;
}

function typeReference(sourceFile: ts.SourceFile, aliasName: string): ts.TypeReferenceNode {
  const alias = sourceFile.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === aliasName,
  );
  if (!alias || !ts.isTypeReferenceNode(alias.type)) throw new Error(`missing type reference ${aliasName}`);
  return alias.type;
}

function classId(context: IrPlanningIdentityContext, declaration: ts.ClassDeclaration): IrClassId {
  const id = context.classIdByDeclaration.get(declaration);
  if (!id) throw new Error("missing class ID");
  return id;
}

function shape(classId: IrClassId, className: string, fieldName: string): IrClassShape {
  return {
    classId,
    className,
    fields: [{ name: fieldName, type: { kind: "val", val: { kind: "f64" } } }],
    methods: [],
    constructorParams: [],
  };
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

describe("#3520 exact class-shape identity", () => {
  it("orders acyclic forward dependencies and keeps recursive-cell groups stable by exact identity", () => {
    const graph = fixture({
      "/repo/a.ts": `
        class Holder {
          current: Value;
          constructor(current: Value) { this.current = current; }
          replace(next: Value): Value { return next; }
          get held(): Value { return this.current; }
          set held(next: Value) { this.current = next; }
          static keep(next: Value): Value { return next; }
        }
        class Value { amount: number; }
        class Left { constructor(right: Right) {} }
        class Right { constructor(left: Left) {} }
      `,
    });
    const sourceFile = graph.byName.get("/repo/a.ts")!;
    const collected = collectIrClassShapeDeclarations(sourceFile, graph.context);
    expect(collected.map((entry) => entry.legacyName)).toEqual(["Holder", "Value", "Left", "Right"]);
    expect(
      orderIrClassShapeDeclarationsForProjection(new TsCheckerOracle(graph.checker), collected, graph.context).map(
        (entry) => entry.legacyName,
      ),
    ).toEqual(["Value", "Holder", "Left", "Right"]);
  });

  it("keeps same-label entries exact while omitting the ambiguous legacy projection", () => {
    const graph = fixture({
      "/repo/a.ts": `
        import { Shared as Remote } from "./b";
        class Shared { local: number; }
        class Child extends Shared { remote(value: Remote): Shared { return new Shared(); } }
        type LocalRef = Shared;
        type RemoteRef = Remote;
      `,
      "/repo/b.ts": `export class Shared { foreign: number; }`,
    });
    const a = graph.byName.get("/repo/a.ts")!;
    const b = graph.byName.get("/repo/b.ts")!;
    const local = classDeclaration(a, "Shared");
    const remote = classDeclaration(b, "Shared");
    const localId = classId(graph.context, local);
    const remoteId = classId(graph.context, remote);
    const entries = new Map<IrClassId, IrClassShapeEntry>([
      [
        localId,
        { classId: localId, legacyName: "Shared", declaration: local, shape: shape(localId, "Shared", "local") },
      ],
      [
        remoteId,
        { classId: remoteId, legacyName: "Shared", declaration: remote, shape: shape(remoteId, "Shared", "foreign") },
      ],
    ]);
    const sidecar = createIrClassShapeSidecar(entries, graph.context);

    expect(sidecar.byClassId.get(localId)?.declaration).toBe(local);
    expect(sidecar.byClassId.get(remoteId)?.declaration).toBe(remote);
    expect(sidecar.legacyProjection.has("Shared")).toBe(false);
    expect(resolveIrClassShapeFromTypeReference(graph.checker, typeReference(a, "LocalRef"), sidecar)).toBe(
      entries.get(localId),
    );
    expect(resolveIrClassShapeFromTypeReference(graph.checker, typeReference(a, "RemoteRef"), sidecar)).toBe(
      entries.get(remoteId),
    );

    const child = classDeclaration(a, "Child");
    expect(resolveIrParentClassId(graph.checker, child, graph.context)).toBe(localId);
    const method = child.members.find(ts.isMethodDeclaration)!;
    const parameterType = graph.checker.getTypeAtLocation(method.parameters[0]!);
    expect(resolveIrClassShapeFromType(graph.checker, parameterType, sidecar)).toBe(entries.get(remoteId));

    expectPlanningError(
      () =>
        createIrClassShapeSidecar(
          new Map([
            [
              localId,
              {
                classId: localId,
                legacyName: "Shared",
                declaration: local,
                shape: shape(remoteId, "Shared", "local"),
              },
            ],
          ]),
          graph.context,
        ),
      "class-record-mismatch",
    );
  });

  it("omits repeated legacy labels across sources before consulting name-keyed registries", () => {
    const graph = fixture({
      "/repo/a.ts": `class Shared { local: number; } class Unique { value: number; }`,
      "/repo/b.ts": `class Shared { foreign: number; }`,
    });
    const a = graph.byName.get("/repo/a.ts")!;
    const b = graph.byName.get("/repo/b.ts")!;
    expect(collectIrClassShapeDeclarations(a, graph.context).map((entry) => entry.legacyName)).toEqual(["Unique"]);
    expect(collectIrClassShapeDeclarations(b, graph.context)).toEqual([]);
  });

  it("does not choose the last declaration for one same-source class label", () => {
    const graph = fixture({
      "/repo/a.ts": `class Repeat { first: number; } class Repeat { second: number; } type Ref = Repeat;`,
    });
    const sourceFile = graph.byName.get("/repo/a.ts")!;
    expect(collectIrClassShapeDeclarations(sourceFile, graph.context)).toEqual([]);
    const sidecar = createIrClassShapeSidecar(new Map(), graph.context);
    expect(
      resolveIrClassShapeFromTypeReference(graph.checker, typeReference(sourceFile, "Ref"), sidecar),
    ).toBeUndefined();
  });

  it("does not promote a cross-source class collision when one authoritative declaration disappears", () => {
    const graph = fixture({
      "/repo/a.ts": `export class Same { local: number; }`,
      "/repo/b.ts": `export class Same { foreign: number; }`,
    });
    const a = graph.byName.get("/repo/a.ts")!;
    const b = graph.byName.get("/repo/b.ts")!;
    expect(collectIrClassShapeDeclarations(a, graph.context)).toEqual([]);
    Reflect.set(b, "statements", ts.factory.createNodeArray());

    expectPlanningError(() => collectIrClassShapeDeclarations(a, graph.context), "class-record-mismatch");
  });

  it("rejects stale sources and declarations even when filename and text match", () => {
    const graph = fixture({ "/repo/a.ts": `class Exact { value: number; }` });
    const sourceFile = graph.byName.get("/repo/a.ts")!;
    const clone = ts.createSourceFile(
      sourceFile.fileName,
      sourceFile.text,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    const stale = classDeclaration(clone, "Exact");
    expectPlanningError(() => collectIrClassShapeDeclarations(clone, graph.context), "source-record-mismatch");
    expectPlanningError(() => requireIrClassShapeClassId(stale, graph.context), "source-record-mismatch");

    const replacementSource = ts.createSourceFile(
      sourceFile.fileName,
      sourceFile.text,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    const replacement = classDeclaration(replacementSource, "Exact");
    Reflect.set(replacement, "parent", sourceFile);
    expectPlanningError(() => requireIrClassShapeClassId(replacement, graph.context), "class-record-mismatch");
  });
});
