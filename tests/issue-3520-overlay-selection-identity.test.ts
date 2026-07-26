// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import {
  buildIrOverlayIdentityMaps,
  planIrOverlayByIdentity,
  projectIrSafeFunctionNames,
} from "../src/codegen/ir-overlay-identity.js";
import { buildIrUnitInventory, type IrUnitId } from "../src/ir/identity.js";
import {
  buildIrPlanningIdentityContext,
  IrPlanningIdentityInvariantError,
  type IrPlanningIdentityContext,
} from "../src/ir/planning-identity.js";
import { ts } from "../src/ts-api.js";

interface Fixture {
  readonly checker: ts.TypeChecker;
  readonly sources: ReadonlyMap<string, ts.SourceFile>;
  readonly context: IrPlanningIdentityContext;
}

function fixture(files: ReadonlyMap<string, string>, roots = [...files.keys()]): Fixture {
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    noLib: true,
    strict: false,
    target: ts.ScriptTarget.ES2022,
  };
  const host: ts.CompilerHost = {
    fileExists: (fileName) => files.has(fileName),
    readFile: (fileName) => files.get(fileName),
    getSourceFile: (fileName, languageVersion) => {
      const text = files.get(fileName);
      return text === undefined
        ? undefined
        : ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.TS);
    },
    getDefaultLibFileName: () => "/repo/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/repo",
    getDirectories: () => [],
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram(roots, options, host);
  const checker = program.getTypeChecker();
  const sources = new Map(roots.map((fileName) => [fileName, program.getSourceFile(fileName)!] as const));
  const sourceFiles = [...sources.values()];
  const inventory = buildIrUnitInventory(sourceFiles, {
    checker,
    entrySource: sources.get("/repo/a.ts") ?? sources.get(roots[0]!)!,
  });
  return { checker, sources, context: buildIrPlanningIdentityContext(inventory) };
}

function functionIds(context: IrPlanningIdentityContext, sourceFile: ts.SourceFile, name: string): IrUnitId[] {
  return sourceFile.statements
    .filter(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === name,
    )
    .map((declaration) => context.unitIdByDeclaration.get(declaration)!);
}

function plan(sourceFile: ts.SourceFile, fixture: Fixture) {
  const maps = buildIrOverlayIdentityMaps(sourceFile, fixture.checker, fixture.context);
  return {
    maps,
    plan: planIrOverlayByIdentity(sourceFile, fixture.context, { experimentalIR: true, trackFallbacks: true }, maps),
  };
}

describe("#3520 production overlay selection identity seam", () => {
  it("retains exact same-name source claims independent of inventory order", () => {
    const files = new Map([
      ["/repo/a.ts", `export function same(value: number): number { return value + 1; }`],
      ["/repo/b.ts", `export function same(value: number): number { return value + 2; }`],
    ]);
    const forward = fixture(files);
    const reversed = fixture(files, ["/repo/b.ts", "/repo/a.ts"]);

    for (const current of [forward, reversed]) {
      const a = current.sources.get("/repo/a.ts")!;
      const b = current.sources.get("/repo/b.ts")!;
      const aId = functionIds(current.context, a, "same")[0]!;
      const bId = functionIds(current.context, b, "same")[0]!;
      const aOverlay = plan(a, current);
      const bOverlay = plan(b, current);

      expect(aId).not.toBe(bId);
      expect(aOverlay.plan.functionClaims[0]).toMatchObject({ unitId: aId, declaration: a.statements[0] });
      expect(bOverlay.plan.functionClaims[0]).toMatchObject({ unitId: bId, declaration: b.statements[0] });
      expect(aOverlay.plan.functionClaims[0]!.typeEntry).toBe(aOverlay.maps.unitTypeMap.get(aId));
      expect(bOverlay.plan.functionClaims[0]!.typeEntry).toBe(bOverlay.maps.unitTypeMap.get(bId));
      expect(aOverlay.plan.selectionProjection.selection.funcs).toEqual(new Set(["same"]));
      expect(bOverlay.plan.selectionProjection.selection.funcs).toEqual(new Set(["same"]));

      aOverlay.plan.safeFunctionUnitIds.add(aId);
      bOverlay.plan.safeFunctionUnitIds.add(bId);
      expect(projectIrSafeFunctionNames(aOverlay.plan.safeFunctionUnitIds, aOverlay.plan)).toEqual(new Set(["same"]));
      expect(projectIrSafeFunctionNames(bOverlay.plan.safeFunctionUnitIds, bOverlay.plan)).toEqual(new Set(["same"]));
    }

    expect(functionIds(forward.context, forward.sources.get("/repo/a.ts")!, "same")).toEqual(
      functionIds(reversed.context, reversed.sources.get("/repo/a.ts")!, "same"),
    );
    expect(functionIds(forward.context, forward.sources.get("/repo/b.ts")!, "same")).toEqual(
      functionIds(reversed.context, reversed.sources.get("/repo/b.ts")!, "same"),
    );
  });

  it("omits every ambiguous within-source claim before function preparation", () => {
    const current = fixture(
      new Map([
        [
          "/repo/duplicate.ts",
          `
            function same(value: number): number { return value + 1; }
            function same(value: number): number { return value + 2; }
          `,
        ],
      ]),
    );
    const sourceFile = current.sources.get("/repo/duplicate.ts")!;
    const ids = functionIds(current.context, sourceFile, "same");
    const { plan: overlay } = plan(sourceFile, current);

    expect(ids).toHaveLength(2);
    expect(overlay.identitySelection.funcs.size).toBe(2);
    expect(ids.every((unitId) => overlay.selectionProjection.omittedUnitIds.has(unitId))).toBe(true);
    expect(overlay.selectionProjection.selection.funcs).toEqual(new Set());
    expect(overlay.functionClaims).toEqual([]);
  });

  it("rejects a stale SourceFile with the typed planning invariant", () => {
    const current = fixture(
      new Map([["/repo/exact.ts", `export function exact(value: number): number { return value; }`]]),
    );
    const sourceFile = current.sources.get("/repo/exact.ts")!;
    const maps = buildIrOverlayIdentityMaps(sourceFile, current.checker, current.context);
    const stale = ts.createSourceFile(sourceFile.fileName, sourceFile.text, ts.ScriptTarget.ESNext, true);

    expect(() =>
      planIrOverlayByIdentity(stale, current.context, { experimentalIR: true, trackFallbacks: true }, maps),
    ).toThrowError(IrPlanningIdentityInvariantError);
    try {
      planIrOverlayByIdentity(stale, current.context, { experimentalIR: true, trackFallbacks: true }, maps);
    } catch (error) {
      expect((error as IrPlanningIdentityInvariantError).code).toBe("source-record-mismatch");
    }
  });
});
