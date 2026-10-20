// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { ts } from "../src/ts-api.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { forEachInstrDeep, type IrInstr, type IrType, type IrValueId } from "../src/ir/core/nodes.js";
import { verifyIrJsClassInstruction } from "../src/ir/runtime/js-class-verify.js";
import { prepareIrProgramRuntimeCallables } from "../src/ir/program/runtime-abi.js";
import { prepareIrProgramAbiEntries } from "../src/ir/program-abi-contracts.js";
import { nativeJsClassEvidenceDomainFromProgram } from "../src/ir/program/native-js-class-allocation-validation.js";
import { AllocSiteRegistry } from "../src/ir/analysis/alloc-registry.js";
import { analyzeNativeJsClass } from "../src/ir/analysis/allocation-evidence/native-js-class-producer.js";
import { inspectNativeJsClassNamespaces } from "../src/ir/analysis/allocation-evidence/native-js-class-profile.js";
import { verifyNativeJsClassEvidence } from "../src/ir/runtime/native-js-class-profile.js";

const cases = [
  {
    name: "actual Boolean despite Number annotation",
    source:
      "class C{x:number;constructor(x:number){this.x=x;}}export function run():number{return new C(true).x===undefined?1:0;}",
    expected: 0,
    argc: 1,
  },
  {
    name: "missing required actual USER",
    source:
      "class C{x:number;constructor(x:number){this.x=x;}}export function run():number{return new C().x===undefined?1:0;}",
    expected: 1,
    argc: 0,
  },
  {
    name: "explicit actual Undefined",
    source:
      "class C{x:number;constructor(x:number){this.x=x;}}export function run():number{return new C(undefined).x===undefined?1:0;}",
    expected: 1,
    argc: 1,
  },
  {
    name: "erased optional USER",
    source:
      "class C{x:number;constructor(x?:number){this.x=x;}}export function run():number{return new C().x===undefined?1:0;}",
    expected: 1,
    argc: 0,
  },
  {
    name: "all extra argument effects precede construction",
    source:
      "let order:number=0;function mark(v:number):number{order=order*10+v;return v;}class C{}export function run():number{new C(mark(1),mark(2));return order;}",
    expected: 12,
    argc: 2,
  },
  {
    name: "arguments then field then constructor body",
    source:
      "let order:number=0;function mark(v:number):number{order=order*10+v;return v;}class C{x:number=(order=order*10+3);constructor(x:number){order=order*10+4;}}export function run():number{new C(mark(1),mark(2));return order;}",
    expected: 1234,
    argc: 2,
  },
] as const;
const policies = [
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
] as const;
const controls = cases.flatMap((fixture) => policies.map((policy) => ({ ...fixture, policy })));
it.each(controls)("retains actual constructor values $name:$policy.backend:$policy.target", (fixture) => {
  const reference: { run?: () => number } = {};
  const js = ts.transpileModule(fixture.source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("exports", js)(reference);
  expect(reference.run!()).toBe(fixture.expected);
  const ast = analyzeMultiSource({ "./entry.ts": fixture.source }, "./entry.ts");
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
  const definition = source.jsClassDefinitions![0]!;
  const constructorBody = source.ir.functions.find((fn) => fn.unitId === definition.constructor.unitId)!;
  expect(definition.constructor.params.every((type) => type.kind === "dynamic" && type.tag === undefined)).toBe(true);
  expect(constructorBody.params.slice(4).map((p) => p.type)).toEqual(definition.constructor.params);
  const occurrences: {
    instruction: Extract<IrInstr, { kind: "js.class.construct" }>;
    types: Map<IrValueId, IrType>;
  }[] = [];
  for (const fn of source.ir.functions) {
    const types = new Map(fn.params.map((param) => [param.value, param.type]));
    for (const block of fn.blocks)
      for (const root of block.instrs)
        forEachInstrDeep(root, (instruction) => {
          if (instruction.result !== null && instruction.resultType !== null)
            types.set(instruction.result, instruction.resultType);
          if (instruction.kind === "js.class.construct") occurrences.push({ instruction, types });
        });
  }
  expect(occurrences).toHaveLength(1);
  const { instruction, types } = occurrences[0]!;
  expect(instruction.args).toHaveLength(fixture.argc);
  expect(instruction.args.every((arg) => types.get(arg)?.kind === "dynamic")).toBe(true);
  expect(verifyIrJsClassInstruction(instruction, types)).toEqual([]);
  if (instruction.args.length) {
    const scalar = new Map(types);
    scalar.set(instruction.args[0]!, { kind: "val", val: { kind: "f64" } });
    expect(verifyIrJsClassInstruction(instruction, scalar)).toContain(
      "native JS class construct requires actual tagged argument values",
    );
  }
  const input = captureTypedIrProgramInput(source);
  const outcome = prepareTypedIrProgram(input, {
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
  expect(outcome.program.ir.functions.map((fn) => fn.unitId)).toEqual(source.ir.functions.map((fn) => fn.unitId));
});

// Replay the real global/TDZ operations independently of the producer's registry.
it.each([
  "global-key",
  "global-ref",
  "global-type",
  "global-intent",
  "global-readonly",
  "global-slot",
  "error-key",
  "error-ref",
  "error-params",
  "error-slot",
])("rejects a forged captured module ABI %s", (mutation) => {
  const ast = analyzeMultiSource({ "./entry.ts": cases[5].source }, "./entry.ts");
  const source = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: policies[0],
    runtimePolicies: [policies[0]],
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  if (source.kind !== "prepared") throw Error(JSON.stringify(source));
  const captured = captureTypedIrProgramInput(source);
  const restored = AllocSiteRegistry.restorePreparationData(captured.allocations, captured);
  const input = restored.data;
  const runtime = prepareIrProgramRuntimeCallables(input);
  if (runtime.kind !== "prepared") throw Error(JSON.stringify(runtime));
  const context = { ...input, abi: { entries: prepareIrProgramAbiEntries(input, runtime.declarations) } };
  const domain = nativeJsClassEvidenceDomainFromProgram(context, input.ir);
  if (!domain) throw Error("missing genuine class domain");
  expect(analyzeNativeJsClass(input.ir, restored.allocations, domain)).toBe(true);
  const registry = restored.allocations.snapshot();
  expect(inspectNativeJsClassNamespaces(input.ir, registry, domain)?.kind).toBe("representable");
  expect(verifyNativeJsClassEvidence(input.ir, registry, domain)?.kind).toBe("verified");
  const changed: typeof context = JSON.parse(JSON.stringify(context));
  const global = changed.abi.entries.find(
    (entry) =>
      entry.contract.kind === "global" &&
      entry.contract.mutable &&
      entry.contract.type.kind === "val" &&
      entry.contract.type.val.kind === "f64",
  )!;
  const error = changed.abi.entries.find(
    (entry) =>
      entry.contract.kind === "callable" &&
      entry.contract.ref.binding.kind === "runtime" &&
      entry.contract.ref.binding.symbol === "__new_ReferenceError",
  )!;
  expect(global).toBeDefined();
  expect(error).toBeDefined();
  if (mutation === "global-key") Object.assign(global.plan, { structuralReferenceKey: "foreign" });
  if (mutation === "global-ref")
    Object.assign(global.contract, { ref: { kind: "global", binding: { kind: "source", bindingId: "foreign" } } });
  if (mutation === "global-type") Object.assign(global.contract, { type: { kind: "val", val: { kind: "i32" } } });
  if (mutation === "global-intent") Object.assign(global.plan.intent, { valueType: "f64" });
  if (mutation === "global-readonly") {
    Object.assign(global.contract, { mutable: false });
    Object.assign(global.plan.intent, { mutable: false });
  }
  if (mutation === "global-slot") Object.assign(global.plan, { slotPolicy: "none" });
  if (mutation === "error-key") Object.assign(error.plan, { structuralReferenceKey: "foreign" });
  if (mutation === "error-ref")
    Object.assign(error.contract, { ref: { kind: "func", binding: { kind: "runtime", name: "__new_TypeError" } } });
  if (mutation === "error-params") Object.assign(error.contract, { params: [] });
  if (mutation === "error-slot") Object.assign(error.plan, { slotSpace: "global" });
  const forged = { ...domain, programData: { ...domain.programData!, abiEntries: changed.abi.entries } };
  expect(() => analyzeNativeJsClass(input.ir, restored.allocations, forged)).toThrow();
  expect(inspectNativeJsClassNamespaces(input.ir, registry, forged)?.kind).toBe("invalid");
  expect(verifyNativeJsClassEvidence(input.ir, registry, forged)?.kind).toBe("invalid");
});
