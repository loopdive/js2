// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it } from "vitest";
import { setImmediate as yieldTestLoop } from "node:timers/promises";
import { analyzeMultiSource } from "../src/checker/index.js";
import { captureTypedIrProgramInput, prepareIrProgramSources } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import {
  collectNativeProgramClassRequirements,
  nativeProgramClassLegality,
} from "../src/ir/program/native-program-resource-requirements.js";
import {
  assertNativeJsClassLegalityCurrent,
  createNativeJsClassRepresentability,
  nativeJsClassInstructionIsAdmitted,
  nativeJsClassTypeIsAdmitted,
  type NativeJsClassLegalityContext,
} from "../src/ir/analysis/allocation-evidence/native-js-class-legality.js";
import { copyIrPreparationData } from "../src/ir/analysis/alloc-registry.js";
import { forEachInstrDeep, forEachNestedBuffer, type IrInstr, type IrFunction } from "../src/ir/core/nodes.js";

const policies = [
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
] as const;
const texts = {
  tdz: "let seen:number=0;class C{constructor(){}x:number=0;m(){seen=seen+1;this.x=7;return this.x;}}export function run():number{return new C().m()===7?seen:0;}",
  tagged: "class C{constructor(){}m():number{throw 7;}}export function run():number{new C();return 0;}",
};
afterEach(() => yieldTestLoop());
function instructions(fn: IrFunction): IrInstr[] {
  const found: IrInstr[] = [];
  for (const block of fn.blocks)
    for (const root of block.instrs) forEachInstrDeep(root, (instruction) => found.push(instruction));
  return found;
}
function genuine(policy: (typeof policies)[number], kind: keyof typeof texts) {
  const ast = analyzeMultiSource({ "./entry.ts": texts[kind] }, "./entry.ts");
  const source = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    runtimePolicies: [policy],
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  if (source.kind !== "prepared") throw Error(JSON.stringify(source));
  const result = prepareTypedIrProgram(captureTypedIrProgramInput(source), {
    policy,
    runtimePolicies: [policy],
    controls: {
      gvnMode: "off",
      ownership: false,
      escape: false,
      verifyIntermediateAllocations: false,
      verifyDominanceNaive: false,
    },
  });
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  const encoded = encodePreparedIrProgram(result.program),
    program = decodePreparedIrProgram(encoded);
  expect(encodePreparedIrProgram(program)).toBe(encoded);
  const projection = program.runtime[0]!;
  const requirements = collectNativeProgramClassRequirements(program, projection);
  if (!requirements) throw Error("actual class requirements absent");
  const contexts: NativeJsClassLegalityContext[] = program.ir.functions.map((fn) => ({
    original: program.ir,
    selected: program.ir,
    registry: program.allocations,
    domain: requirements.domain,
    function: fn,
    backend: policy.backend,
  }));
  return { program, projection, contexts };
}
function removeActualInstructions(context: NativeJsClassLegalityContext, remove: (instruction: IrInstr) => boolean) {
  const visit = (buffer: readonly IrInstr[]) => {
    for (const instruction of [...buffer]) forEachNestedBuffer(instruction, visit);
    for (let index = buffer.length - 1; index >= 0; index--)
      if (remove(buffer[index]!)) Reflect.apply(Array.prototype.splice, buffer, [index, 1]);
  };
  for (const block of context.function.blocks) visit(block.instrs);
}
function errorContext(kind: keyof typeof texts = "tdz") {
  const fixture = genuine(policies[0], kind);
  const context = fixture.contexts.find((row) => {
    const actual = instructions(row.function);
    return kind === "tagged"
      ? actual.some((instruction) => instruction.kind === "coerce.to_externref") &&
          actual.some((instruction) => instruction.kind === "js.class.frame.new")
      : actual.some((instruction) => instruction.kind === "call" && instruction.target.binding.kind === "runtime") &&
          actual.some((instruction) => instruction.kind === "global.set") &&
          actual.some((instruction) => instruction.kind === "js.class.property.set");
  });
  if (!context) throw Error("actual exception transport missing");
  const mutable = structuredClone(context);
  createNativeJsClassRepresentability(mutable);
  return mutable;
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object") throw Error("actual DATA record absent");
  return value as Record<string, unknown>;
}
function errorCall(context: NativeJsClassLegalityContext) {
  const call = instructions(context.function).find(
    (instruction) => instruction.kind === "call" && instruction.target.binding.kind === "runtime",
  );
  if (!call || call.kind !== "call") throw Error("actual canonical error call absent");
  return call;
}
it.each(policies)("genuine TDZ transport retains current original/selected proof $backend:$target", (policy) => {
  const { program, projection, contexts } = genuine(policy, "tdz");
  let count = 0;
  for (const context of contexts) {
    const use = createNativeJsClassRepresentability(context);
    assertNativeJsClassLegalityCurrent(use, context.function, policy.backend);
    count += instructions(context.function).filter(
      (instruction) => instruction.kind === "call" && instruction.target.binding.kind === "runtime",
    ).length;
  }
  expect(count).toBeGreaterThan(0);
  for (const fn of projection.prepared.functions) {
    const use = nativeProgramClassLegality(program, projection, fn);
    if (use) assertNativeJsClassLegalityCurrent(use, fn, policy.backend);
  }
});
it.each(policies)("genuine tagged throw gets no generic type/opcode waiver $backend:$target", (policy) => {
  const { program, projection, contexts } = genuine(policy, "tagged");
  let count = 0;
  for (const context of contexts) {
    const use = createNativeJsClassRepresentability(context);
    for (const instruction of instructions(context.function)) {
      if (instruction.kind !== "coerce.to_externref") continue;
      count++;
      expect(nativeJsClassInstructionIsAdmitted(use, context.function, policy.backend, instruction)).toBe(false);
      expect(
        nativeJsClassTypeIsAdmitted(use, context.function, policy.backend, instruction, instruction.resultType!),
      ).toBe(false);
    }
  }
  expect(count).toBeGreaterThan(0);
  for (const fn of projection.prepared.functions) {
    const use = nativeProgramClassLegality(program, projection, fn);
    if (use) assertNativeJsClassLegalityCurrent(use, fn, policy.backend);
  }
});
const mutations = [
  "null-type",
  "null-type-ref",
  "call-type-ref",
  "wrong-binding",
  "wrong-arity",
  "wrong-ABI",
  "extern-signature",
  "extern-slot",
  "null-return",
  "error-return",
  "null-branch",
  "error-global",
  "error-receiver",
  "unused-error",
  "unused-null",
] as const;
it.each(mutations)("closed exception transport refuses actual %s drift", (mutation) => {
  const context = errorContext(),
    call = errorCall(context);
  const payload = instructions(context.function).find((instruction) => instruction.result === call.args[0]);
  if (!payload || payload.kind !== "const" || payload.value.kind !== "null") throw Error("real null payload absent");
  const block = context.function.blocks[0]!;
  if (mutation === "null-type") Object.assign(payload.value, { ty: { kind: "val", val: { kind: "f64" } } });
  if (mutation === "null-type-ref") Object.assign(payload.value.ty, { typeRef: {} });
  if (mutation === "call-type-ref") Object.assign(call.resultType!, { typeRef: {} });
  if (mutation === "wrong-binding") Object.assign(call.target, { name: "foreign" });
  if (mutation === "wrong-arity") Object.assign(call, { args: [] });
  if (mutation === "wrong-ABI") {
    const entry = context.domain.programData!.abiEntries.find((row) => {
      const contract = record(record(row).contract);
      return contract.kind === "callable" && record(contract.ref).name === call.target.name;
    });
    if (!entry) throw Error("real callable ABI absent");
    Object.assign(record(record(entry).contract), { params: [] });
  }
  if (mutation === "extern-signature") Object.assign(context.function, { resultTypes: [call.resultType] });
  if (mutation === "extern-slot") Object.assign(context.function, { slots: [{ id: 0, type: { kind: "externref" } }] });
  if (mutation === "null-return" || mutation === "error-return")
    Object.assign(block, {
      terminator: { kind: "return", values: [mutation === "null-return" ? payload.result : call.result] },
    });
  if (mutation === "null-branch")
    Object.assign(block, { terminator: { kind: "br", branch: { target: block.id, args: [payload.result] } } });
  if (mutation === "error-global" || mutation === "error-receiver") {
    const instruction = instructions(context.function).find((row) =>
      mutation === "error-global" ? row.kind === "global.set" : row.kind === "js.class.property.set",
    );
    if (!instruction) throw Error("genuine use mutation absent");
    Object.assign(instruction, mutation === "error-global" ? { value: call.result } : { receiver: call.result });
  }
  if (mutation === "unused-error" || mutation === "unused-null")
    removeActualInstructions(
      context,
      (instruction) =>
        (instruction.kind === "throw" && instruction.value === call.result) ||
        (mutation === "unused-null" && instruction === call),
    );
  expect(() => createNativeJsClassRepresentability(context)).toThrow();
});
it.each(["raw-f64", "managed", "return", "type-ref", "box-payload"] as const)(
  "tagged conversion rejects %s transport",
  (mutation) => {
    const context = errorContext("tagged"),
      conversion = instructions(context.function).find((instruction) => instruction.kind === "coerce.to_externref");
    if (!conversion || conversion.kind !== "coerce.to_externref") throw Error("actual conversion absent");
    if (mutation === "return")
      Object.assign(context.function.blocks[0]!, { terminator: { kind: "return", values: [conversion.result] } });
    if (mutation === "type-ref") Object.assign(conversion.resultType!, { typeRef: {} });
    if (mutation === "box-payload") {
      const box = instructions(context.function).find((instruction) => instruction.kind === "box");
      if (!box || box.kind !== "box") throw Error("actual box absent");
      Object.assign(box, { value: conversion.result });
    }
    if (mutation === "raw-f64" || mutation === "managed") {
      const value = instructions(context.function).find(
        (instruction) =>
          instruction.result !== null &&
          (mutation === "raw-f64"
            ? instruction.resultType?.kind === "val" && instruction.resultType.val.kind === "f64"
            : instruction.resultType?.kind === "support-ref"),
      );
      if (!value) throw Error("genuine operand for mutation absent");
      Object.assign(conversion, { value: value.result });
    }
    expect(() => createNativeJsClassRepresentability(context)).toThrow();
  },
);
it("copies, foreign uses, staleness and DATA getters cannot mint capability", () => {
  const context = errorContext(),
    use = createNativeJsClassRepresentability(context);
  const copied = copyIrPreparationData(use);
  expect(() => assertNativeJsClassLegalityCurrent(copied, copied.context.function, copied.context.backend)).toThrow();
  expect(() => assertNativeJsClassLegalityCurrent(use, context.function, "foreign")).toThrow();
  const foreign = copyIrPreparationData(context.function);
  expect(() => assertNativeJsClassLegalityCurrent(use, foreign, context.backend)).toThrow();
  const call = errorCall(context);
  Object.assign(call.target, { name: "changed" });
  expect(() => assertNativeJsClassLegalityCurrent(use, context.function, context.backend)).toThrow();
  let reads = 0;
  const hostile = { ...context };
  Object.defineProperty(hostile, "selected", {
    enumerable: true,
    get() {
      reads++;
      return context.selected;
    },
  });
  expect(() => createNativeJsClassRepresentability(hostile)).toThrow();
  expect(reads).toBe(0);
});

it.each([
  "host",
  "missing-provider",
  "implementation",
  "backend",
  "missing-declaration",
  "signature",
  "selected-drift",
] as const)("canonical codec owner independently refuses %s provider/ABI drift", (mutation) => {
  const fixture = genuine(policies[0], "tdz");
  const data: unknown = JSON.parse(encodePreparedIrProgram(fixture.program));
  const program = record(record(data).program),
    runtime = program.runtime;
  if (!Array.isArray(runtime)) throw Error("actual encoded runtime absent");
  const projection = record(runtime[0]),
    prepared = record(projection.prepared),
    manifest = record(prepared.manifest);
  const providers = manifest.providers;
  if (!Array.isArray(providers)) throw Error("actual encoded providers absent");
  const provider = providers.find((row) => record(row).feature === "error.reference.construct");
  if (!provider) throw Error("actual ReferenceError provider absent");
  if (mutation === "host") Object.assign(provider, { hostCapabilities: ["error.reference.construct"] });
  if (mutation === "missing-provider")
    Object.assign(manifest, { providers: providers.filter((row) => row !== provider) });
  if (mutation === "implementation")
    Object.assign(provider, { implementation: { kind: "runtime-callable", symbol: "foreign" } });
  if (mutation === "backend") Object.assign(provider, { supportedBackends: ["linear"] });
  if (mutation === "missing-declaration" || mutation === "signature") {
    const abi = record(program.abi),
      entries = abi.entries;
    if (!Array.isArray(entries)) throw Error("actual encoded ABI absent");
    const entry = entries.find((row) => {
      const contract = record(record(row).contract);
      return contract.kind === "callable" && record(contract.ref).name === "__new_ReferenceError";
    });
    if (!entry) throw Error("actual ABI declaration absent");
    if (mutation === "missing-declaration") Object.assign(abi, { entries: entries.filter((row) => row !== entry) });
    else Object.assign(record(record(entry).contract), { results: [] });
  }
  if (mutation === "selected-drift") {
    const functions = prepared.functions;
    if (!Array.isArray(functions)) throw Error("actual encoded selected bodies absent");
    const fn = functions.find(
      (row) => Array.isArray(record(row).resultTypes) && (record(row).resultTypes as unknown[]).length > 0,
    );
    if (!fn) throw Error("genuine nonempty selected signature absent");
    Object.assign(record(fn), { resultTypes: [] });
  }
  expect(() => decodePreparedIrProgram(JSON.stringify(data))).toThrow();
});

// Deliberately malformed DATA below keeps real source-owned bodies and SSA objects.
function maskedDateFunction(context: NativeJsClassLegalityContext) {
  const original = context.function;
  const replacement = new Date(0);
  Object.setPrototypeOf(replacement, Object.getPrototypeOf(original));
  Object.defineProperties(replacement, Object.getOwnPropertyDescriptors(original));
  const seen = new Set<object>();
  const replace = (value: unknown): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw Error("healthy DATA descriptor absent");
      if (descriptor.value === original) Object.defineProperty(value, key, { ...descriptor, value: replacement });
      else replace(descriptor.value);
    }
  };
  const before = instructions(original);
  replace(context);
  expect(Object.is(context.function, replacement)).toBe(true);
  expect(context.original.functions.some((fn) => fn === context.function)).toBe(true);
  expect(context.selected.functions.some((fn) => fn === context.function)).toBe(true);
  const keys = Reflect.ownKeys(original);
  expect(Reflect.ownKeys(replacement)).toEqual(keys);
  for (const key of keys) {
    const beforeDescriptor = Object.getOwnPropertyDescriptor(original, key)!;
    const afterDescriptor = Object.getOwnPropertyDescriptor(replacement, key)!;
    expect(afterDescriptor.value === beforeDescriptor.value).toBe(true);
    expect(afterDescriptor.enumerable).toBe(beforeDescriptor.enumerable);
    expect(afterDescriptor.writable).toBe(beforeDescriptor.writable);
    expect(afterDescriptor.configurable).toBe(beforeDescriptor.configurable);
  }
  expect(Reflect.apply(Date.prototype.getTime, replacement, [])).toBe(0);
  expect(instructions(context.function).length).toBe(before.length);
  before.forEach((instruction, index) => expect(instructions(context.function)[index] === instruction).toBe(true));
  return original;
}
it.each(["issuer", "current", "type", "instruction"] as const)(
  "masked Date actual function cannot pass %s legality boundary",
  (query) => {
    const context = errorContext();
    const use = createNativeJsClassRepresentability(context);
    const instruction = instructions(context.function).find(
      (row) => row.kind.startsWith("js.class.") && row.resultType?.kind === "support-ref",
    );
    if (!instruction || !instruction.resultType) throw Error("genuine admitted class result absent");
    expect(nativeJsClassInstructionIsAdmitted(use, context.function, context.backend, instruction)).toBe(true);
    expect(
      nativeJsClassTypeIsAdmitted(use, context.function, context.backend, instruction, instruction.resultType),
    ).toBe(true);
    assertNativeJsClassLegalityCurrent(use, context.function, context.backend);
    const previous = maskedDateFunction(context);
    expect(context.function === previous).toBe(false);
    const action = () => {
      if (query === "issuer") return createNativeJsClassRepresentability(context);
      if (query === "current") return assertNativeJsClassLegalityCurrent(use, context.function, context.backend);
      if (query === "type")
        return nativeJsClassTypeIsAdmitted(
          use,
          context.function,
          context.backend,
          instruction,
          instruction.resultType!,
        );
      return nativeJsClassInstructionIsAdmitted(use, context.function, context.backend, instruction);
    };
    expect(action).toThrow("invalid preparation data: unsupported Date instance");
  },
);
it("current legality refuses an added DATA accessor without reading it", () => {
  const context = errorContext();
  const use = createNativeJsClassRepresentability(context);
  assertNativeJsClassLegalityCurrent(use, context.function, context.backend);
  let reads = 0;
  Object.defineProperty(context.function, "hostile", {
    enumerable: true,
    get() {
      reads++;
      return 0;
    },
  });
  expect(Object.getOwnPropertyDescriptor(context.function, "hostile")?.get).toBeTypeOf("function");
  expect(() => assertNativeJsClassLegalityCurrent(use, context.function, context.backend)).toThrow();
  expect(reads).toBe(0);
});
