// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { ts } from "../src/ts-api.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { prepareIrProgramSources, type IrSourceMapCaptureRequest } from "../src/ir/program-source.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { unloweredSourceClassDefinition } from "../src/ir/program/source-class-definitions.js";
import { sourceInput, requireProgram } from "./helpers/typed-program-fixtures.js";
import { replayProgram, replayOptions } from "./helpers/ir-whole-program-replay.js";

const sources = {
  heritage: "let trace:number=0;class C extends (trace=7,null){}export function run():number{return trace;}",
  computed: 'let trace:number=0;class C {[(trace=7,"x")]:number;}export function run():number{return trace;}',
};
function context(source: string) {
  const input = sourceInput({ "./entry.ts": source });
  const inventory = buildIrUnitInventory(input.sourceFiles, { entrySource: input.entrySource, checker: input.checker });
  return { input, identity: buildIrPlanningIdentityContext(inventory) };
}
for (const [name, source] of Object.entries(sources))
  it(`does not emit the incomplete ${name} definition as a complete source program`, () => {
    const javascript = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const exports: { run?: () => number } = {};
    runInNewContext(javascript, { exports }, { timeout: 1000 });
    expect(exports.run?.()).toBe(7);
    const { input, identity } = context(source),
      result = prepareWholeIrProgram(input);
    expect(result.kind).toBe("unsupported");
    if (result.kind !== "unsupported") throw Error("source definition was silently omitted");
    expect(result.code).toBe("class-definition-execution-unsupported");
    expect(result.stage).toBe("build");
    expect(result.detail).toContain("ClassDefinitionEvaluation");
    const own = identity.inventory.allUnits.find((row) => row.id === result.unitId);
    expect(own?.kind).toBe("class-implicit-constructor");
    expect(result.location).toEqual({
      sourceId: own!.sourceId,
      line: own!.line,
      column: own!.column,
      declarationStart: own!.declarationStart,
      declarationEnd: own!.declarationEnd,
    });
    expect(result.sourceFile).toBe("entry.ts");
  });

for (const [name, source] of Object.entries({
  unused: "class C{}export function run():number{return 1;}",
  only: "class C{}",
  explicit: "class C{constructor(){}}export function run():number{return 1;}",
  expression: "const C=class Inner{};export function run():number{return 1;}",
  nested: "export function run():number{class C{}return 1;}",
  derived: "class C extends null{}export function run():number{return 1;}",
}))
  it(`keeps ${name} definitions in the outstanding executable source population`, () => {
    const { input, identity } = context(source),
      failure = prepareWholeIrProgram(input);
    expect(failure.kind).toBe("unsupported");
    if (failure.kind !== "unsupported") throw Error("missing class definition producer was not reported");
    expect(failure.code).toBe("class-definition-execution-unsupported");
    const original = identity.inventory.allUnits.find((row) => row.id === failure.unitId);
    expect(original).toBeDefined();
    expect(["class-constructor", "class-implicit-constructor"]).toContain(original!.kind);
    expect(identity.inventory.classes.some((row) => row.id === original!.lexicalOwnerId)).toBe(true);
  });

it("allows erased ambient classes and executes the ordinary complete program", async () => {
  const source = "declare class C{}export function run():number{return 7;}";
  const { input, identity } = context(source);
  expect(identity.inventory.classes).toHaveLength(1);
  expect(unloweredSourceClassDefinition(identity)).toBeUndefined();
  const result = await replayProgram(
    requireProgram(prepareWholeIrProgram(input)),
    replayOptions("wasmgc", "standalone"),
  );
  if (result.kind !== "ran") throw Error(JSON.stringify(result.failure));
  const run = result.run.exports.run;
  if (typeof run !== "function") throw Error("missing actual export");
  expect(run()).toBe(7);
  expect(result.run.emitted.module.imports).toEqual([]);
});
it("recognizes ambient ancestry without treating a real namespace class as erased", () => {
  const ambient = context("declare namespace N {class C{}}export function run():number{return 7;}").identity;
  expect(ambient.inventory.classes).toHaveLength(1);
  expect(unloweredSourceClassDefinition(ambient)).toBeUndefined();
  const actual = context("namespace N {export class C{}}export function run():number{return 7;}").identity;
  expect(actual.inventory.classes).toHaveLength(1);
  expect(unloweredSourceClassDefinition(actual)?.kind).toBe("unsupported");
});
it("does not turn missing class declarations or constructor units into empty coverage", () => {
  const { identity } = context("class C{}export function run():number{return 7;}");
  expect(unloweredSourceClassDefinition(identity)?.kind).toBe("unsupported");
  expect(() => unloweredSourceClassDefinition({ ...identity, declarationByClassId: new Map() })).toThrow(
    /exact declaration/,
  );
  const units = identity.inventory.allUnits.filter((row) => row.kind !== "class-implicit-constructor");
  expect(() =>
    unloweredSourceClassDefinition({ ...identity, inventory: { ...identity.inventory, allUnits: units } }),
  ).toThrow(/actual constructor unit/);
});

it("validates requested source maps before reporting unsupported class execution", () => {
  const { input } = context("class C{}export function run():number{return 7;}");
  const sourceMap: IrSourceMapCaptureRequest = {
    kind: "capture-source-map",
    sources: input.sourceFiles.map((sourceFile) => ({
      sourceFile,
      projection: { originalText: sourceFile.text, analyzedText: sourceFile.text, stages: [] },
    })),
  };
  const prepare = (map: unknown) => prepareIrProgramSources({ ...input, sourceMap: map as IrSourceMapCaptureRequest });
  expect(prepare(sourceMap).kind).toBe("unsupported");
  expect(() => prepare({ ...sourceMap, kind: "bogus" })).toThrow(/unknown request kind/);
  expect(() => prepare({ ...sourceMap, sources: [] })).toThrow(/missing actual source reference row/);
  expect(() =>
    prepare({
      ...sourceMap,
      sources: sourceMap.sources.map((row) => ({
        ...row,
        projection: {
          ...row.projection,
          originalText: row.projection.originalText + " ",
          analyzedText: row.projection.analyzedText + " ",
        },
      })),
    }),
  ).toThrow(/analyzed text differs/);
});
