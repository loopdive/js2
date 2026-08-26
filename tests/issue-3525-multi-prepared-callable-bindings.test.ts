// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeMultiSource } from "../src/checker/index.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import {
  buildIrProgramCallableBindingGraph,
  IrProgramCallableBindingInvariantError,
} from "../src/ir/program-callable-bindings.js";
import { buildIrPlanningIdentityContext, type IrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { ts } from "../src/ts-api.js";

interface GraphFixture {
  readonly ast: ReturnType<typeof analyzeMultiSource>;
  readonly identity: IrPlanningIdentityContext;
  readonly graph: ReturnType<typeof buildIrProgramCallableBindingGraph>;
}

function makeGraph(files: Record<string, string>, entryFile: string): GraphFixture {
  const ast = analyzeMultiSource(files, entryFile);
  const inventory = buildIrUnitInventory(ast.sourceFiles, {
    checker: ast.checker,
    entrySource: ast.entryFile,
  });
  const identity = buildIrPlanningIdentityContext(inventory);
  const graph = buildIrProgramCallableBindingGraph({
    checker: ast.checker,
    sourceFiles: ast.sourceFiles,
    identityContext: identity,
  });
  return { ast, identity, graph };
}

function functionUnitId(fixture: GraphFixture, fileName: string, name: string): string {
  const normalizedFileName = fileName.replace(/^\/+/, "");
  const source = fixture.ast.sourceFiles.find(
    (candidate) => candidate.fileName === fileName || candidate.fileName.replace(/^\.?\//, "") === normalizedFileName,
  );
  expect(source).toBeDefined();
  const declaration = source!.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && (statement.name?.text ?? "default") === name && !!statement.body,
  );
  expect(declaration).toBeDefined();
  return fixture.identity.unitIdByDeclaration.get(declaration!)!;
}

function useSignature(fixture: GraphFixture): readonly string[] {
  return fixture.graph.uses.map((use) => {
    const callee = use.node.expression.getText();
    return `${use.sourceId}|${use.ownerUnitId}|${callee}|${use.targetUnitId}|${use.bindingId}|${use.canonicalBindingId}`;
  });
}

const ALIAS_FILES = {
  "./a.ts": `
    export function same(value: number): number { return value; }
    export function only(value: number): number { return value + 1; }
    export default function (value: number): number { return value + 2; }
    export { same as renamed };
  `,
  "./b.ts": `
    import defaultFn, { same as localSame, renamed as reexported } from "./a";
    import * as ns from "./a";
    export { renamed as chained } from "./a";
    export * from "./a";
    export function same(value: number): number { return value + 100; }
    export function invoke(value: number): number {
      return localSame(value) + defaultFn(value) + ns.same(value) + reexported(value);
    }
  `,
  "./entry.ts": `
    import { invoke as call, chained, same as entrySame } from "./b";
    export function entry(value: number): number {
      return call(value) + chained(value) + entrySame(value);
    }
  `,
} as const;

describe("#3525 whole-program callable binding graph", () => {
  it("resolves renamed/default/namespace/re-export calls to exact units", () => {
    const fixture = makeGraph(ALIAS_FILES, "./entry.ts");
    const aSame = functionUnitId(fixture, "/a.ts", "same");
    const aDefault = functionUnitId(fixture, "/a.ts", "default");
    const bSame = functionUnitId(fixture, "/b.ts", "same");
    const bInvoke = functionUnitId(fixture, "/b.ts", "invoke");
    const entry = functionUnitId(fixture, "/entry.ts", "entry");

    expect(fixture.graph.schema).toBe("ir-program-callable-binding-graph-v1");
    expect(fixture.graph.sourceIds).toEqual(fixture.identity.inventory.sources.map((source) => source.id));
    expect(
      fixture.graph.records.filter((record) => record.kind === "source").map((record) => record.targetUnitId),
    ).toEqual([aSame, functionUnitId(fixture, "/a.ts", "only"), aDefault, bSame, bInvoke, entry]);

    const bUses = fixture.graph.uses.filter((use) => use.ownerUnitId === bInvoke);
    expect(bUses).toHaveLength(4);
    expect(bUses.map((use) => [use.node.expression.getText(), use.targetUnitId])).toEqual([
      ["localSame", aSame],
      ["defaultFn", aDefault],
      ["ns.same", aSame],
      ["reexported", aSame],
    ]);

    const entryUses = fixture.graph.uses.filter((use) => use.ownerUnitId === entry);
    expect(entryUses).toHaveLength(3);
    expect(entryUses.map((use) => [use.node.expression.getText(), use.targetUnitId])).toEqual([
      ["call", bInvoke],
      ["chained", aSame],
      ["entrySame", bSame],
    ]);

    const localSameUse = bUses.find((use) => use.node.expression.getText() === "localSame")!;
    expect(fixture.graph.resolveCall(localSameUse.node, bInvoke)).toBe(localSameUse);
    expect(fixture.graph.resolveCall(localSameUse.node, entry)).toBeUndefined();
    expect(new Set(fixture.graph.records.map((record) => record.bindingId)).size).toBe(fixture.graph.records.length);
    expect(Object.isFrozen(fixture.graph)).toBe(true);
    expect(Object.isFrozen(fixture.graph.records)).toBe(true);
    expect(Object.isFrozen(fixture.graph.uses)).toBe(true);
  });

  it("keeps record and use order independent of caller source insertion order", () => {
    const first = makeGraph(ALIAS_FILES, "./entry.ts");
    const reversedAst = analyzeMultiSource(
      {
        "./entry.ts": ALIAS_FILES["./entry.ts"],
        "./b.ts": ALIAS_FILES["./b.ts"],
        "./a.ts": ALIAS_FILES["./a.ts"],
      },
      "./entry.ts",
    );
    const reversedInventory = buildIrUnitInventory(reversedAst.sourceFiles, {
      checker: reversedAst.checker,
      entrySource: reversedAst.entryFile,
    });
    const reversedIdentity = buildIrPlanningIdentityContext(reversedInventory);
    const second = buildIrProgramCallableBindingGraph({
      checker: reversedAst.checker,
      sourceFiles: [...reversedAst.sourceFiles].reverse(),
      identityContext: reversedIdentity,
    });

    expect(second.sourceIds).toEqual(first.graph.sourceIds);
    expect(second.records).toEqual(first.graph.records);
    expect(useSignature({ ast: reversedAst, identity: reversedIdentity, graph: second })).toEqual(useSignature(first));
  });

  it("declines mutable, value-escaped, optional, dynamic, and overloaded call sites", () => {
    const fixture = makeGraph(
      {
        "./dep.ts": `
          export function mutable(value: number): number { return value; }
          mutable = (value: number) => value + 1;
          export function overloaded(value: number): number;
          export function overloaded(value: string): number;
          export function overloaded(value: number | string): number { return 1; }
        `,
        "./entry.ts": `
          import { mutable, overloaded } from "./dep";
          import * as ns from "./dep";
          const escaped = overloaded;
          export function entry(value: number): number {
            return mutable?.(value) + ns["mutable"](value) + escaped(value) + overloaded(value);
          }
        `,
      },
      "./entry.ts",
    );
    const entry = functionUnitId(fixture, "/entry.ts", "entry");
    expect(fixture.graph.uses.filter((use) => use.ownerUnitId === entry)).toEqual([]);
    expect(fixture.graph.records.filter((record) => record.kind === "import-alias")).toEqual([]);
  });

  it("rejects a copied SourceFile population instead of guessing a join", () => {
    const fixture = makeGraph({ "./entry.ts": "export function entry(): number { return 1; }" }, "./entry.ts");
    const foreignSource = ts.createSourceFile(
      fixture.ast.entryFile.fileName,
      fixture.ast.entryFile.text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    let caught: unknown;
    try {
      buildIrProgramCallableBindingGraph({
        checker: fixture.ast.checker,
        sourceFiles: [foreignSource],
        identityContext: fixture.identity,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IrProgramCallableBindingInvariantError);
    expect(caught).toMatchObject({ code: "source-record-mismatch" });
  });
});
