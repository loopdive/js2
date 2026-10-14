// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it, vi } from "vitest";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { analyzeMultiSource } from "../src/checker/index.js";
import { ts } from "../src/ts-api.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import * as sourceProducer from "../src/ir/program-source.js";
import * as classProducer from "../src/ir/source-class-plans.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { acceptPreparedIrProgram } from "../src/ir/program-consumer.js";
import { inferClassInitializerArrayTypes } from "../src/ir/array-element-inference.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { forEachInstrDeep } from "../src/ir/core/nodes.js";
import * as directGc from "../src/codegen/index.js";
import * as directLinear from "../src/codegen-linear/index.js";
import type { PreparedIrProgram } from "../src/ir/program.js";
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
function source(source: string, policy?: (typeof profiles)[number]) {
  const request = input(source, policy),
    result = prepareIrProgramSources(request);
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  return { request, result };
}
function prepared(text: string, policy = profiles[0] as (typeof profiles)[number]): PreparedIrProgram {
  const result = prepareWholeIrProgram(input(text, policy));
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  return result.program;
}
function classEntry(program: PreparedIrProgram) {
  const entry = program.abi.entries.find((e) => e.contract.kind === "class")!;
  if (entry.contract.kind !== "class") throw Error("no original class contract");
  return entry;
}
afterEach(() => vi.restoreAllMocks());
it("prepares the complete authentic class/body/default census for seven original forms on four source policies without synthetic class AST", async () => {
  const noFunction = vi.spyOn(ts.factory, "createFunctionDeclaration").mockImplementation(() => {
    throw Error("fake function forbidden");
  });
  const noConstructor = vi.spyOn(ts.factory, "createConstructorDeclaration").mockImplementation(() => {
    throw Error("fake constructor forbidden");
  });
  let rows = 0;
  for (const text of fixtures)
    for (const policy of profiles) {
      const attempt = prepareIrProgramSources(input(text, policy));
      if (policy.backend === "linear" && text !== fixtures[3]) {
        expect(attempt.kind).toBe("unsupported");
        if (attempt.kind !== "unsupported") throw Error("missing class evidence capability boundary");
        expect(attempt.detail).toContain("declared class-evidence producer");
        expect(attempt.location).toBeDefined();
        rows++;
        await yieldTurn();
        continue;
      }
      if (attempt.kind !== "prepared") throw Error(JSON.stringify(attempt));
      const result = attempt;
      expect(result.classes).toHaveLength(1);
      const row = result.classes![0]!;
      expect(row.classId).toBe(result.inventory.classes[0]!.id);
      expect(result.ir.functions).toHaveLength(result.inventory.terminalUnits.length);
      expect(row.fieldIntents.every((field) => field.default === "undefined")).toBe(true);
      expect(row.shape.constructorInitTarget?.binding).toMatchObject({ kind: "unit", unitId: row.constructorUnitId });
      expect(row.shape.constructorTarget?.binding.kind).toBe("support");
      expect(result.ir.functions.find((fn) => fn.unitId === row.constructorUnitId)!.params.at(-1)?.type.kind).toBe(
        "class",
      );
      const captured = captureTypedIrProgramInput(result);
      expect(captured.classes).toHaveLength(1);
      rows++;
      await yieldTurn();
    }
  expect(rows).toBe(28);
  expect(noFunction).not.toHaveBeenCalled();
  expect(noConstructor).not.toHaveBeenCalled();
}, 120000);
it("seals actual source class IR live/codec on both GC policies and retains typed physical inability with all source/direct producers poisoned", async () => {
  const inputs = fixtures.flatMap((text) =>
    profiles.slice(0, 2).map((policy) => {
      const { result, request } = source(text, policy);
      return { policy, typed: captureTypedIrProgramInput(result), request };
    }),
  );
  const noSource = vi.spyOn(sourceProducer, "prepareIrProgramSources").mockImplementation(() => {
    throw Error("source reconstruction forbidden");
  });
  const noClasses = vi.spyOn(classProducer, "prepareSourceClassPlans").mockImplementation(() => {
    throw Error("class reconstruction forbidden");
  });
  const noGc = vi.spyOn(directGc, "generateModule").mockImplementation(() => {
    throw Error("direct GC forbidden");
  });
  const noLinear = vi.spyOn(directLinear, "generateLinearModule").mockImplementation(() => {
    throw Error("direct Linear forbidden");
  });
  const restore: (() => void)[] = [];
  for (const { request } of inputs) {
    const declaration = request.entrySource.statements.find(ts.isClassDeclaration);
    if (declaration) {
      const descriptor = Object.getOwnPropertyDescriptor(declaration, "members")!;
      Object.defineProperty(declaration, "members", {
        configurable: true,
        get() {
          throw Error("post-capture class AST forbidden");
        },
      });
      restore.push(() => Object.defineProperty(declaration, "members", descriptor));
    }
  }
  let rows = 0;
  try {
    for (const { policy, typed } of inputs) {
      const result = prepareTypedIrProgram(typed, { ...typedOptions, policy, runtimePolicies: [policy] });
      expect(result.kind).toBe("prepared");
      if (result.kind !== "prepared") throw Error(JSON.stringify(result));
      const encoded = encodePreparedIrProgram(result.program),
        decoded = decodePreparedIrProgram(encoded);
      expect(encodePreparedIrProgram(decoded)).toBe(encoded);
      for (const value of [result.program, decoded]) {
        assertPreparedIrProgram(value);
        const accepted = acceptPreparedIrProgram(value, {
          ...policy,
          moduleName: "classes",
          sourceMap: false,
          utf8Storage: false,
          sharedExceptionTag: false,
        });
        expect(accepted.kind).toBe("unsupported");
        if (accepted.kind !== "unsupported") throw Error("physical class gap missing");
        expect(accepted.detail).toContain("class layout");
        expect(accepted.detail).toContain("needs type materialization");
        expect(accepted.location).toBeDefined();
        rows++;
      }
      await yieldTurn();
    }
  } finally {
    for (const callback of restore) callback();
  }
  expect(rows).toBe(28);
  for (const spy of [noSource, noClasses, noGc, noLinear]) expect(spy).not.toHaveBeenCalled();
}, 120000);
it("preserves ordered initializer effects and undefined defaults independently of canonical storage order", () => {
  const text =
    "function seed(x:number):number{return x;}class C{z:number=seed(1);a:number=seed(2);unset:number;read():number{return this.z+this.a;}}export function run():number{return new C().read();}";
  const { result } = source(text),
    row = result.classes![0]!;
  expect(row.shape.fields.map((f) => f.name)).toEqual(["a", "unset", "z"]);
  expect(row.fieldIntents.map((f) => [f.name, f.sourceOrdinal, f.default])).toEqual([
    ["z", 0, "undefined"],
    ["a", 1, "undefined"],
    ["unset", 2, "undefined"],
  ]);
  expect(row.fieldIntents.filter((f) => f.initializerUnitId !== null)).toHaveLength(2);
  const init = result.ir.functions.find((fn) => fn.unitId === row.constructorUnitId)!;
  const writes: string[] = [];
  for (const block of init.blocks)
    for (const root of block.instrs)
      forEachInstrDeep(root, (i) => {
        if (i.kind === "class.set") writes.push(i.fieldName);
      });
  expect(writes).toEqual(["z", "a"]);
  const p = prepared(text);
  assertPreparedIrProgram(decodePreparedIrProgram(encodePreparedIrProgram(p)));
});
it("retains recursive/forward nominal class identities, Boolean method contracts and unused original class bodies", () => {
  const text =
    "class A{next:B;constructor(next:B){this.next=next;}yes(value:boolean):boolean{return value;}}class B{next:A;constructor(next:A){this.next=next;}}export function run():number{return 7;}";
  const p = prepared(text),
    classes = p.abi.entries.filter((e) => e.contract.kind === "class");
  expect(classes).toHaveLength(2);
  expect(p.ir.functions).toHaveLength(p.inventory.terminalUnits.length);
  assertPreparedIrProgram(decodePreparedIrProgram(encodePreparedIrProgram(p)));
});
it("produces a genuine closed no-array initializer analysis and refuses foreign, reordered, omitted, literal and array-capable original fields", () => {
  const { request } = source("class C{a:number=1;b:number=2;}export function run():number{return new C().a;}");
  const declaration = request.entrySource.statements.find(ts.isClassDeclaration)!;
  const expressions = declaration.members.filter(ts.isPropertyDeclaration).map((f) => f.initializer!);
  const analysis = inferClassInitializerArrayTypes(declaration, expressions);
  expect(analysis.isResolvedVectorExpression(expressions[0]!)).toBe(false);
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
});
it("rejects actual source syntax mutation against the original class plan before body preparation", () => {
  const request = input(fixtures[1]),
    inventory = buildIrUnitInventory(request.sourceFiles, {
      checker: request.checker,
      entrySource: request.entrySource,
      wholeProgramClassConstructors: true,
    });
  const plan = classProducer.prepareSourceClassPlans(request.checker, buildIrPlanningIdentityContext(inventory));
  plan.assertCurrent();
  const declaration = request.entrySource.statements.find(ts.isClassDeclaration)!;
  const initializer = declaration.members.filter(ts.isPropertyDeclaration)[0]!.initializer!;
  Object.assign(initializer, { text: "9" });
  expect(() => plan.assertCurrent()).toThrow(/original syntax/);
});
it("rejects malformed class/default/initializer/unit/ABI DATA after warm validation before codec publication", () => {
  const p = prepared(
    "class C{z:number=1;a:number=2;read():number{return this.z+this.a;}}export function run():number{return new C().read();}",
  );
  assertPreparedIrProgram(p);
  encodePreparedIrProgram(p);
  const mutate: ((q: PreparedIrProgram) => void)[] = [
    (q) => {
      const e = classEntry(q);
      if (e.contract.kind === "class") Object.assign(e.contract, { preparation: undefined });
    },
    (q) => {
      const e = classEntry(q);
      if (e.contract.kind === "class") Object.assign(e.contract.preparation!, { extra: true });
    },
    (q) => {
      const e = classEntry(q);
      if (e.contract.kind === "class") Object.assign(e.contract.preparation!, { constructorKind: "forged" });
    },
    (q) => {
      const e = classEntry(q);
      if (e.contract.kind === "class") Object.assign(e.contract.preparation!.fieldIntents[0]!, { default: "zero" });
    },
    (q) => {
      const e = classEntry(q);
      if (e.contract.kind === "class")
        Object.assign(e.contract.preparation!.fieldIntents[0]!, { initializerUnitId: null });
    },
    (q) => {
      const e = classEntry(q);
      if (e.contract.kind === "class") Object.assign(e.contract.preparation!.fieldIntents[1]!, { sourceOrdinal: 0 });
    },
    (q) => {
      const e = classEntry(q);
      if (e.contract.kind === "class")
        Object.assign(e.contract.preparation!, { constructorUnitId: q.ir.functions.at(-1)!.unitId });
    },
    (q) => {
      const e = classEntry(q);
      if (e.contract.kind === "class")
        Object.assign(e.contract.shape.methods[0]!.placement!, { unitId: q.ir.functions.at(-1)!.unitId });
    },
    (q) => Object.assign(q, { ir: { functions: q.ir.functions.slice(1) } }),
    (q) => Object.assign(q, { abi: { entries: q.abi.entries.filter((e) => e.contract.kind !== "class") } }),
  ];
  for (const alter of mutate) {
    const q = structuredClone(p);
    alter(q);
    expect(() => assertPreparedIrProgram(q)).toThrow();
    expect(() => encodePreparedIrProgram(q)).toThrow();
  }
});
it("keeps held and unsupported source families located, with Linear evidence and physical limitations explicit", async () => {
  for (const text of [
    "class C{x:number[]=[];}export function run():number{return 7;}",
    "class C{get x():number{return 7;}}export function run():number{return 7;}",
    "class P{}class C extends P{}export function run():number{return 7;}",
  ]) {
    const result = prepareIrProgramSources(input(text));
    expect(result.kind).toBe("unsupported");
    if (result.kind !== "unsupported") throw Error("missing source frontier");
    expect(result.location).toBeDefined();
  }
  let staticRows = 0;
  for (const policy of profiles) {
    const p = prepared(fixtures[3], policy);
    assertPreparedIrProgram(decodePreparedIrProgram(encodePreparedIrProgram(p)));
    staticRows++;
    await yieldTurn();
  }
  expect(staticRows).toBe(4);
  for (const policy of profiles.slice(2)) {
    const gcSource = source(fixtures[0]).result;
    expect(() =>
      prepareTypedIrProgram(captureTypedIrProgramInput(gcSource), {
        ...typedOptions,
        policy,
        runtimePolicies: [policy],
      }),
    ).toThrow(/missing or stale ownership evidence/);
    const result = prepareWholeIrProgram(input(fixtures[2], policy));
    expect(result.kind).toBe("unsupported");
    if (result.kind !== "unsupported") throw Error("missing Linear frontier");
    expect(result.detail).toContain("declared class-evidence producer");
    expect(result.location).toBeDefined();
  }
}, 120000);
