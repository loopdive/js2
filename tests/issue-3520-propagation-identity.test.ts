// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { buildIrUnitInventory, type IrUnitId } from "../src/ir/identity.js";
import {
  buildIrPlanningIdentityContext,
  IrPlanningIdentityInvariantError,
  type IrPlanningIdentityContext,
} from "../src/ir/planning-identity.js";
import {
  buildIrUnitTypeMap,
  projectIrUnitTypeMapToLegacy,
  type IrUnitTypeMap,
  type TypeMapEntry,
} from "../src/ir/propagate.js";
import { buildIrRecursiveTypeEvidence } from "../src/ir/type-evidence.js";
import { ts } from "../src/ts-api.js";

const A_SOURCE = `
  export {};
  function same(n) {
    if (n <= 0) return 0;
    return same(n - 1);
  }
  function owner() { return same(3); }
`;

const B_SOURCE = `
  export {};
  function same(value) {
    if (value === "") return "";
    return same(value);
  }
  function owner() { return same("distinct"); }
`;

const C_SOURCE = `
  export {};
  function same(value) { return !value; }
  function owner() { return same(true); }
`;

const PROVIDER_SOURCE = `
  export default function defaultTarget(value) { return value; }
  export function shared(value) { return value; }
`;

const CONSUMER_SOURCE = `
  import importedDefault, { shared as renamedTarget } from "./provider";
  function shared(value) { return !value; }
  function localOwner() { return shared(true); }
  function importedOwner() {
    const shared = (value: number) => value + 1;
    return importedDefault(1) + renamedTarget(2) + shared(3);
  }
`;

interface Fixture {
  readonly checker: ts.TypeChecker;
  readonly a: ts.SourceFile;
  readonly b: ts.SourceFile;
  readonly c: ts.SourceFile;
  readonly context: IrPlanningIdentityContext;
}

function fixture(reverseRoots = false): Fixture {
  const files = new Map([
    ["/repo/a.ts", A_SOURCE],
    ["/repo/b.ts", B_SOURCE],
    ["/repo/c.ts", C_SOURCE],
  ]);
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
  const roots = reverseRoots ? ["/repo/c.ts", "/repo/b.ts", "/repo/a.ts"] : ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"];
  const program = ts.createProgram(roots, options, host);
  const checker = program.getTypeChecker();
  const a = program.getSourceFile("/repo/a.ts")!;
  const b = program.getSourceFile("/repo/b.ts")!;
  const c = program.getSourceFile("/repo/c.ts")!;
  const inventory = buildIrUnitInventory(reverseRoots ? [c, b, a] : [a, b, c], {
    checker,
    entrySource: a,
  });
  return { checker, a, b, c, context: buildIrPlanningIdentityContext(inventory) };
}

function importFixture(): {
  readonly checker: ts.TypeChecker;
  readonly provider: ts.SourceFile;
  readonly consumer: ts.SourceFile;
  readonly context: IrPlanningIdentityContext;
} {
  const files = new Map([
    ["/repo/provider.ts", PROVIDER_SOURCE],
    ["/repo/consumer.ts", CONSUMER_SOURCE],
  ]);
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
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
    directoryExists: (directoryName) => directoryName === "/repo",
    realpath: (path) => path,
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram(["/repo/consumer.ts", "/repo/provider.ts"], options, host);
  const checker = program.getTypeChecker();
  const provider = program.getSourceFile("/repo/provider.ts")!;
  const consumer = program.getSourceFile("/repo/consumer.ts")!;
  const inventory = buildIrUnitInventory([consumer, provider], { checker, entrySource: consumer });
  return { checker, provider, consumer, context: buildIrPlanningIdentityContext(inventory) };
}

function functionId(context: IrPlanningIdentityContext, sourceFile: ts.SourceFile, name: string): IrUnitId {
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  )!;
  return context.unitIdByDeclaration.get(declaration)!;
}

function stableRows(typeMap: IrUnitTypeMap): readonly (readonly [IrUnitId, TypeMapEntry])[] {
  return [...typeMap].map(([unitId, entry]) => [unitId, entry] as const);
}

describe("#3520 identity-keyed propagation and recursive evidence", () => {
  it("keeps same-named cross-source propagation distinct and canonical", () => {
    const forward = fixture();
    const reversed = fixture(true);
    const forwardMap = buildIrUnitTypeMap([forward.c, forward.b, forward.a], forward.checker, forward.context);
    const reversedMap = buildIrUnitTypeMap([reversed.a, reversed.b, reversed.c], reversed.checker, reversed.context);
    const aSame = functionId(forward.context, forward.a, "same");
    const bSame = functionId(forward.context, forward.b, "same");
    const aOwner = functionId(forward.context, forward.a, "owner");
    const bOwner = functionId(forward.context, forward.b, "owner");
    const cSame = functionId(forward.context, forward.c, "same");
    const cOwner = functionId(forward.context, forward.c, "owner");

    expect(aSame).not.toBe(bSame);
    expect(aOwner).not.toBe(bOwner);
    expect(new Set([aSame, bSame, cSame]).size).toBe(3);
    expect(forwardMap.get(aSame)).toEqual({ params: [{ kind: "f64" }], returnType: { kind: "f64" } });
    expect(forwardMap.get(aOwner)).toEqual({ params: [], returnType: { kind: "f64" } });
    expect(forwardMap.get(bSame)).toEqual({ params: [{ kind: "string" }], returnType: { kind: "string" } });
    expect(forwardMap.get(bOwner)).toEqual({ params: [], returnType: { kind: "string" } });
    expect(forwardMap.get(cSame)).toEqual({ params: [{ kind: "bool" }], returnType: { kind: "bool" } });
    expect(forwardMap.get(cOwner)).toEqual({ params: [], returnType: { kind: "bool" } });
    expect(stableRows(reversedMap)).toEqual(stableRows(forwardMap));
  });

  it("keeps two same-named recursive SCC decisions distinct from a nonrecursive peer", () => {
    const forward = fixture();
    const reversed = fixture(true);
    const { a, b, c, checker, context } = forward;
    const propagated = buildIrUnitTypeMap([c, b, a], checker, context);
    const evidence = buildIrRecursiveTypeEvidence([a, b, c], checker, propagated, context);
    const reversedPropagated = buildIrUnitTypeMap(
      [reversed.a, reversed.c, reversed.b],
      reversed.checker,
      reversed.context,
    );
    const reversedEvidence = buildIrRecursiveTypeEvidence(
      [reversed.c, reversed.a, reversed.b],
      reversed.checker,
      reversedPropagated,
      reversed.context,
    );
    const numericRecursiveSame = functionId(context, a, "same");
    const stringRecursiveSame = functionId(context, b, "same");
    const nonrecursiveSame = functionId(context, c, "same");

    expect(evidence.decisions.get(numericRecursiveSame)).toEqual({
      accepted: true,
      component: [numericRecursiveSame],
    });
    expect(evidence.decisions.get(stringRecursiveSame)).toEqual({
      accepted: true,
      component: [stringRecursiveSame],
    });
    expect(evidence.typeMap.get(numericRecursiveSame)).toEqual(propagated.get(numericRecursiveSame));
    expect(evidence.typeMap.get(stringRecursiveSame)).toEqual(propagated.get(stringRecursiveSame));
    expect(evidence.decisions.has(nonrecursiveSame)).toBe(false);
    expect(evidence.typeMap.has(nonrecursiveSame)).toBe(false);
    expect([...reversedEvidence.decisions]).toEqual([...evidence.decisions]);
    expect(stableRows(reversedEvidence.typeMap)).toEqual(stableRows(evidence.typeMap));
  });

  it("uses unique checker-free fallback and conservatively demotes legacy collisions", () => {
    const { a, b, c, checker, context } = fixture();
    const aSame = functionId(context, a, "same");
    const checkerFreeUnique = buildIrUnitTypeMap([a], undefined, context);
    const checkerFreeAmbiguous = buildIrUnitTypeMap([c, b, a], undefined, context);
    const checkerBacked = buildIrUnitTypeMap([a, b, c], checker, context);

    expect(checkerFreeUnique.get(aSame)?.params).toEqual([{ kind: "f64" }]);
    expect(checkerFreeAmbiguous.get(aSame)?.params).toEqual([{ kind: "unknown" }]);

    // Both active sources contain `same` and `owner`. The legacy seam cannot
    // represent either pair, so the explicit projection demotes both labels
    // instead of selecting one ID by insertion order.
    expect(projectIrUnitTypeMapToLegacy([a, b, c], checkerBacked, context)).toEqual(new Map());
    expect(projectIrUnitTypeMapToLegacy([a], checkerBacked, context).size).toBe(2);
    expect(projectIrUnitTypeMapToLegacy([b], checkerBacked, context).size).toBe(2);
    expect(projectIrUnitTypeMapToLegacy([c], checkerBacked, context).size).toBe(2);

    const foreign = ts.createSourceFile("/repo/foreign.ts", "function f() {}", ts.ScriptTarget.Latest, true);
    expect(() => buildIrUnitTypeMap([foreign], checker, context)).toThrowError(
      expect.objectContaining<IrPlanningIdentityInvariantError>({ code: "source-record-mismatch" }),
    );
  });

  it("resolves default and renamed imports exactly without capturing a shadowed same-name call", () => {
    const { checker, provider, consumer, context } = importFixture();
    const propagated = buildIrUnitTypeMap([consumer, provider], checker, context);
    const defaultTarget = functionId(context, provider, "defaultTarget");
    const renamedTarget = functionId(context, provider, "shared");
    const localSameName = functionId(context, consumer, "shared");

    expect(new Set([defaultTarget, renamedTarget, localSameName]).size).toBe(3);
    expect(propagated.get(defaultTarget)).toEqual({ params: [{ kind: "f64" }], returnType: { kind: "f64" } });
    expect(propagated.get(renamedTarget)).toEqual({ params: [{ kind: "f64" }], returnType: { kind: "f64" } });
    expect(propagated.get(localSameName)).toEqual({ params: [{ kind: "bool" }], returnType: { kind: "bool" } });
  });
});
