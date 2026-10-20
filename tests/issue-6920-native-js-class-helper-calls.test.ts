// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { ts } from "../src/ts-api.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { buildIrProgramCallableBindingGraph } from "../src/ir/program-callable-bindings.js";
import { forEachInstrDeep } from "../src/ir/core/nodes.js";
import type { IrUnitId } from "../src/shared/contracts/ir-identity.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";

const fixtures: readonly { name: string; files: Record<string, string>; expected: number }[] = [
  {
    name: "method",
    files: {
      "./entry.ts":
        "function helper():number{return 3;}class C{m(){return helper();}}export function run():number{return new C().m()===undefined?1:0;}",
    },
    expected: 0,
  },
  {
    name: "constructor",
    files: {
      "./entry.ts":
        "function helper():number{return 3;}class C{x:number;constructor(){this.x=helper();}}export function run():number{return new C().x===undefined?1:0;}",
    },
    expected: 0,
  },
  {
    name: "field initializer",
    files: {
      "./entry.ts":
        "function helper():number{return 3;}class C{x:number=helper();}export function run():number{return new C().x===undefined?1:0;}",
    },
    expected: 0,
  },
  {
    name: "imported alias",
    files: {
      "./entry.ts":
        'import {helper as h} from "./helper.js";class C{m(){return h();}}export function run():number{return new C().m()===undefined?1:0;}',
      "./helper.ts": "export function helper():number{return 3;}",
    },
    expected: 0,
  },
];
const policies = [
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
] as const;
function reference(files: Record<string, string>): number {
  const cache = new Map<string, Record<string, unknown>>();
  const load = (path: string): Record<string, unknown> => {
    const existing = cache.get(path);
    if (existing) return existing;
    const exports: Record<string, unknown> = {};
    cache.set(path, exports);
    const js = ts.transpileModule(files[path]!, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function("exports", "require", js)(exports, (id: string) => load(id.replace(/\.js$/, ".ts")));
    return exports;
  };
  return (load("./entry.ts").run as () => number)();
}
it.each(fixtures.flatMap((fixture) => policies.map((policy) => ({ ...fixture, policy }))))(
  "prepares authentic $name helper caller on $policy.backend:$policy.target",
  (fixture) => {
    expect(reference(fixture.files)).toBe(fixture.expected);
    const ast = analyzeMultiSource(fixture.files, "./entry.ts");
    const source = prepareIrProgramSources({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy: fixture.policy,
      runtimePolicies: [fixture.policy],
      deferTopLevelInit: false,
      linearVectorProjection: "native-f64",
    });
    if (source.kind !== "prepared") throw Error(JSON.stringify(source));
    const identity = buildIrPlanningIdentityContext(source.inventory);
    const graph = buildIrProgramCallableBindingGraph({
      checker: ast.checker,
      sourceFiles: ast.sourceFiles,
      identityContext: identity,
    });
    expect(graph.uses).toHaveLength(1);
    const use = graph.uses[0]!;
    const caller = identity.unitByUnitId.get(use.ownerUnitId)!;
    expect(caller.kind).toBe(
      fixture.name === "constructor"
        ? "class-constructor"
        : fixture.name === "field initializer"
          ? "class-instance-field-initializer"
          : "class-instance-method",
    );
    if (fixture.name === "field initializer") expect(caller.terminal).toBe(false);
    const actual: { owner: IrUnitId; target: IrUnitId }[] = [];
    for (const fn of source.ir.functions)
      for (const block of fn.blocks)
        for (const root of block.instrs)
          forEachInstrDeep(root, (instruction) => {
            if (instruction.kind === "call" && instruction.target.binding.kind === "unit")
              actual.push({ owner: fn.unitId, target: instruction.target.binding.unitId });
          });
    expect(actual).toContainEqual({ owner: use.ownerUnitId, target: use.targetUnitId });
    const outcome = prepareTypedIrProgram(captureTypedIrProgramInput(source), {
      policy: fixture.policy,
      runtimePolicies: [fixture.policy],
      controls: {
        gvnMode: "off",
        ownership: false,
        escape: false,
        verifyIntermediateAllocations: true,
        verifyDominanceNaive: true,
      },
    });
    if (outcome.kind !== "prepared") throw Error(JSON.stringify(outcome));
    const encoded = encodePreparedIrProgram(outcome.program);
    expect(encodePreparedIrProgram(decodePreparedIrProgram(encoded))).toBe(encoded);
  },
);
it.each([
  ["mutable target", "function helper():number{return 3;}helper=()=>4;class C{m(){return helper();}}"],
  ["shadowed target", "function helper():number{return 3;}class C{m(helper:any){return helper();}}"],
  [
    "nested function body",
    "function helper():number{return 3;}class C{m(){function inner(){return helper();}return 3;}}",
  ],
  ["deferred closure field", "function helper():number{return 3;}class C{x=()=>helper();}"],
])("does not fabricate a class caller plan for %s", (_name, text) => {
  const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
  const inventory = buildIrUnitInventory(ast.sourceFiles, {
    checker: ast.checker,
    entrySource: ast.entryFile,
    wholeProgramClassConstructors: true,
  });
  const identity = buildIrPlanningIdentityContext(inventory);
  const graph = buildIrProgramCallableBindingGraph({
    checker: ast.checker,
    sourceFiles: ast.sourceFiles,
    identityContext: identity,
  });
  expect(graph.uses.filter((use) => identity.unitByUnitId.get(use.ownerUnitId)!.kind.startsWith("class-"))).toEqual([]);
});
