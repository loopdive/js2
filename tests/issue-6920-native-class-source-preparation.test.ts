// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it, vi } from "vitest";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { analyzeMultiSource } from "../src/checker/index.js";
import { compile } from "../src/index.js";
import { ts } from "../src/ts-api.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import * as classProducer from "../src/ir/source-class-plans.js";
import * as astLowerer from "../src/ir/from-ast.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { assertSourceClassPreparation } from "../src/ir/program/class-preparation.js";
import { freezePreparedIrValue } from "../src/ir/program/data.js";
import { inferClassInitializerArrayTypes } from "../src/ir/array-element-inference.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { emitBinary } from "../src/emit/binary.js";
import * as directGc from "../src/codegen/index.js";
import * as directLinear from "../src/codegen-linear/index.js";
import type { IrPreparedSourceClass } from "../src/ir/program/class-preparation.js";
import { typedOptions } from "./helpers/typed-program-fixtures.js";
const profiles = [
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
] as const;
const fixtures = [
  "class C{x:number;constructor(x:number){this.x=x;}}export function run():number{return new C(7).x;}",
  "class C{x:number=7;}export function run():number{return new C().x;}",
  "class C{x:number;constructor(x:number){this.x=x;}read():number{return this.x;}}export function run():number{return new C(7).read();}",
  "class C{static read():number{return 7;}}export function run():number{return C.read();}",
  "class C{}export function run():number{const c=new C();return 7;}",
  "export function run():number{class C{x:number;constructor(x:number){this.x=x;}read():number{return this.x;}}return new C(7).read();}",
  "export function run():number{const C=class{x:number;constructor(x:number){this.x=x;}read():number{return this.x;}};return new C(7).read();}",
] as const;
const regressionSources = [
  "let answer:number=C.read();class C{static read():number{return 7;}}export function run():number{return answer;}",
  "class C{x:number;read():number{return this.x===undefined?1:0;}}export function run():number{return new C().read();}",
] as const;
function input(source: string, policy = profiles[0] as (typeof profiles)[number]) {
  const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
  return {
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    runtimePolicies: [policy],
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64" as const,
  };
}
function planner(text: string) {
  const request = input(text);
  const inventory = buildIrUnitInventory(request.sourceFiles, {
    checker: request.checker,
    entrySource: request.entrySource,
    wholeProgramClassConstructors: true,
  });
  const identity = buildIrPlanningIdentityContext(inventory);
  return { request, inventory, identity, plans: classProducer.prepareSourceClassPlans(request.checker, identity) };
}
function expectCapability(
  result: ReturnType<typeof prepareIrProgramSources> | ReturnType<typeof prepareWholeIrProgram>,
) {
  expect(result.kind).toBe("unsupported");
  if (result.kind !== "unsupported") throw Error("class semantic capability refusal was lost");
  expect(result.code).toBe("class-member-unsupported");
  expect(result.stage).toBe("build");
  expect(result.detail).toContain("definition/binding/TDZ/prototype and undefined-field read/type producer");
  expect(result.detail).toContain("metadata alone is not semantic preparation");
  expect(result.unitId).toBeDefined();
  expect(result.location.sourceId).toContain("entry.ts");
  expect(result.sourceFile).toBe("entry.ts");
}
afterEach(() => vi.restoreAllMocks());
it("refuses every authentic class family on four policies before any body lowering or synthetic class AST", async () => {
  const noBody = vi.spyOn(astLowerer, "lowerFunctionAstToIr").mockImplementation(() => {
    throw Error("body IR forbidden");
  });
  const noImplicit = vi.spyOn(astLowerer, "lowerPreparedImplicitClassConstructorToIr").mockImplementation(() => {
    throw Error("implicit body IR forbidden");
  });
  const noFunction = vi.spyOn(ts.factory, "createFunctionDeclaration").mockImplementation(() => {
    throw Error("fake function forbidden");
  });
  const noConstructor = vi.spyOn(ts.factory, "createConstructorDeclaration").mockImplementation(() => {
    throw Error("fake constructor forbidden");
  });
  let attempts = 0;
  for (const text of fixtures)
    for (const policy of profiles) {
      expectCapability(prepareIrProgramSources(input(text, policy)));
      attempts++;
      await yieldTurn();
    }
  expect(attempts).toBe(28);
  for (const poison of [noBody, noImplicit, noFunction, noConstructor]) expect(poison).not.toHaveBeenCalled();
}, 120000);
it("refuses the exact TDZ/default defects and unused original bodies before semantic PreparedIR", async () => {
  let attempts = 0;
  for (const text of [
    ...regressionSources,
    "class Unused{x:number;read():number{return this.x===undefined?1:0;}}export function run():number{return 7;}",
  ])
    for (const policy of profiles) {
      expectCapability(prepareWholeIrProgram(input(text, policy)));
      attempts++;
      await yieldTurn();
    }
  expect(attempts).toBe(12);
}, 120000);
it("produces zero public class artifacts for both semantic regression sources on four native policies", async () => {
  let attempts = 0;
  for (const text of regressionSources)
    for (const policy of profiles) {
      const result = await compile(text, { ...policy, optimize: false, sourceMap: false, wit: false });
      expect(result.success).toBe(false);
      if (result.success) throw Error("unimplemented class produced a public artifact");
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.binary.byteLength).toBe(0);
      attempts++;
      await yieldTurn();
    }
  expect(attempts).toBe(8);
}, 120000);
it("keeps actual scalar public and source-free live/codec execution on all four native policies with legacy generators poisoned", async () => {
  const noGc = vi.spyOn(directGc, "generateModule").mockImplementation(() => {
    throw Error("direct GC forbidden");
  });
  const noLinear = vi.spyOn(directLinear, "generateLinearModule").mockImplementation(() => {
    throw Error("direct Linear forbidden");
  });
  const text = "export function echo(value:boolean):boolean{return value;}export function run():number{return 7;}";
  let executions = 0;
  for (const policy of profiles) {
    const result = await compile(text, { ...policy, optimize: false, sourceMap: false, wit: true });
    expect(result.success).toBe(true);
    if (!result.success) throw Error(JSON.stringify(result.errors));
    const publicInstance = await WebAssembly.instantiate(Uint8Array.from(result.binary).buffer, {});
    const publicExports = publicInstance.instance.exports as {
      run(): number;
      echo(value: number): number;
      _start?: () => void;
    };
    publicExports._start?.();
    expect(publicExports.run()).toBe(7);
    expect(publicExports.echo(0)).toBe(0);
    expect(publicExports.echo(1)).toBe(1);
    executions++;
    const source = prepareWholeIrProgram(input(text, policy));
    if (source.kind !== "prepared") throw Error(JSON.stringify(source));
    const encoded = encodePreparedIrProgram(source.program),
      replay = decodePreparedIrProgram(encoded);
    expect(encodePreparedIrProgram(replay)).toBe(encoded);
    for (const program of [source.program, replay]) {
      assertPreparedIrProgram(program);
      const accepted = acceptPreparedIrProgram(program, {
        ...policy,
        moduleName: "scalar-class-refusal-control",
        sourceMap: false,
        utf8Storage: false,
        sharedExceptionTag: false,
      });
      if (accepted.kind !== "accepted") throw Error(JSON.stringify(accepted));
      const binary = emitBinary(emitAcceptedIrProgram(accepted).module);
      const instance = await WebAssembly.instantiate(Uint8Array.from(binary).buffer, {});
      const exports = instance.instance.exports as { run(): number; echo(value: number): number; _start?: () => void };
      exports._start?.();
      expect(exports.run()).toBe(7);
      expect(exports.echo(0)).toBe(0);
      expect(exports.echo(1)).toBe(1);
      executions++;
    }
    await yieldTurn();
  }
  expect(executions).toBe(12);
  expect(noGc).not.toHaveBeenCalled();
  expect(noLinear).not.toHaveBeenCalled();
}, 120000);
it("retains seven original class metadata censuses without class body or semantic preparation credit", () => {
  const noBody = vi.spyOn(astLowerer, "lowerFunctionAstToIr").mockImplementation(() => {
    throw Error("body forbidden");
  });
  for (const text of fixtures) {
    const { inventory, identity, plans } = planner(text);
    const data = plans.plans.map((p) => p.data);
    expect(data).toHaveLength(1);
    assertSourceClassPreparation(inventory, data);
    const plan = plans.plans[0]!;
    expect(identity.declarationByClassId.get(plan.data.classId)).toBe(plan.declaration);
    expect(plan.data.fieldIntents.every((f) => f.default === "undefined")).toBe(true);
    expect(plan.data.shape.constructorInitTarget?.binding).toMatchObject({
      kind: "unit",
      unitId: plan.data.constructorUnitId,
    });
    for (const [id, node] of plan.methods) expect(identity.declarationByUnitId.get(id)).toBe(node);
  }
  expect(noBody).not.toHaveBeenCalled();
}, 120000);
it("keeps original ordered initializer/default intents and recursive nominal metadata with no emitted body", () => {
  const ordered = planner(
    "function seed(x:number):number{return x;}class C{z:number=seed(1);a:number=seed(2);unset:number;}export function run():number{return 7;}",
  );
  const plan = ordered.plans.plans[0]!;
  expect(plan.data.shape.fields.map((f) => f.name)).toEqual(["a", "unset", "z"]);
  expect(plan.data.fieldIntents.map((f) => f.name)).toEqual(["z", "a", "unset"]);
  expect(plan.initializers.map((i) => i.expression.getText())).toEqual(["seed(1)", "seed(2)"]);
  const recursive = planner(
    "class A{next:B;constructor(next:B){this.next=next;}}class B{next:A;constructor(next:A){this.next=next;}}export function run():number{return 7;}",
  );
  const data = freezePreparedIrValue(recursive.plans.plans.map((p) => p.data)) as readonly IrPreparedSourceClass[];
  expect(data).toHaveLength(2);
  assertSourceClassPreparation(recursive.inventory, data);
  expect(Object.isFrozen(data)).toBe(true);
});
it("preserves authentic closed no-array analysis and held/array refusals", () => {
  const { request } = planner("class C{a:number=1;b:number=2;}export function run():number{return 7;}");
  const declaration = request.entrySource.statements.find(ts.isClassDeclaration)!;
  const expressions = declaration.members.filter(ts.isPropertyDeclaration).map((f) => f.initializer!);
  expect(inferClassInitializerArrayTypes(declaration, expressions).isResolvedVectorExpression(expressions[0]!)).toBe(
    false,
  );
  expect(() => inferClassInitializerArrayTypes(declaration, [...expressions].reverse())).toThrow(/reordered/);
  expect(() => inferClassInitializerArrayTypes(declaration, expressions.slice(1))).toThrow(/omitted/);
  const foreign = input("class D{a:number=1;}").entrySource.statements.find(ts.isClassDeclaration)!;
  expect(() =>
    inferClassInitializerArrayTypes(declaration, [
      foreign.members.filter(ts.isPropertyDeclaration)[0]!.initializer!,
      expressions[1]!,
    ]),
  ).toThrow(/foreign/);
  for (const text of [
    "class C{x:number[];}",
    "class C{x:ReadonlyArray<number>;}",
    "class C{x:number=([1,2])[0];}",
    "class C{x:[number,number];}",
  ]) {
    const ast = input(text).entrySource.statements.find(ts.isClassDeclaration)!;
    expect(() =>
      inferClassInitializerArrayTypes(
        ast,
        ast.members.filter(ts.isPropertyDeclaration).flatMap((f) => (f.initializer ? [f.initializer] : [])),
      ),
    ).toThrow(/array-capable/);
  }
  for (const text of [
    "class C{get x():number{return 7;}}export function run():number{return 7;}",
    "class A{}class C extends A{}export function run():number{return 7;}",
  ]) {
    const result = prepareWholeIrProgram(input(text));
    expect(result.kind).toBe("unsupported");
    if (result.kind !== "unsupported") throw Error("held source admission widened");
    expect(result.detail).toContain("held W1-C owner");
    expect(result.location).toBeDefined();
  }
});
it("refuses current syntax mutation and ten malformed original class metadata joins", () => {
  const { inventory, identity, plans } = planner(
    "class C{a:number=1;b:number=2;read():number{return this.a;}}export function run():number{return 7;}",
  );
  const data = plans.plans.map((p) => p.data),
    row = data[0]!;
  assertSourceClassPreparation(inventory, data);
  const changes: (() => readonly IrPreparedSourceClass[])[] = [
    () => [],
    () => [row, row],
    () => [{ ...row, sourceId: (inventory.sources[0]!.id + "foreign") as typeof row.sourceId }],
    () => [{ ...row, constructorUnitId: inventory.terminalUnits.find((u) => u.kind === "top-level-function")!.id }],
    () => [{ ...row, constructorKind: "explicit" }],
    () => [{ ...row, fieldIntents: row.fieldIntents.slice(1) }],
    () => [{ ...row, fieldIntents: [...row.fieldIntents].reverse() }],
    () => [
      {
        ...row,
        fieldIntents: row.fieldIntents.map((f, i) => (i === 0 ? { ...f, default: "zero" as "undefined" } : f)),
      },
    ],
    () => [{ ...row, fieldIntents: row.fieldIntents.map((f, i) => (i === 0 ? { ...f, initializerUnitId: null } : f)) }],
    () => [{ ...row, shape: { ...row.shape, methods: [] } }],
  ];
  for (const mutate of changes)
    expect(() => assertSourceClassPreparation(inventory, mutate())).toThrow(/source class preparation/);
  const literal = plans.plans[0]!.initializers[0]!.expression as ts.NumericLiteral;
  Object.defineProperty(literal, "text", { value: "9", writable: true, configurable: true });
  expect(() => classProducer.refuseUnimplementedSourceClassSemantics(plans, identity, () => {})).toThrow(
    /no longer matches/,
  );
});
it("retains the direct typed missing-ownership invariant on an explicitly guard-bypassed historical source preimage without semantic credit", () => {
  const bypass = vi.spyOn(classProducer, "refuseUnimplementedSourceClassSemantics").mockImplementation(() => {});
  const result = prepareIrProgramSources(input(fixtures[0]));
  bypass.mockRestore();
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  const typed = captureTypedIrProgramInput(result);
  expect(() =>
    prepareTypedIrProgram(typed, { ...typedOptions, policy: profiles[2], runtimePolicies: [profiles[2]] }),
  ).toThrow(/missing or stale ownership evidence/);
  expectCapability(prepareWholeIrProgram(input(fixtures[0])));
});
