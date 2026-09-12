// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ts } from "../src/ts-api.js";
import {
  prepareIrProgramSources,
  captureTypedIrProgramInput,
  type IrProgramSourceInput,
  type IrProgramSourcePreparation,
} from "../src/ir/program-source.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { ownTypedIrProgramInput } from "../src/ir/program/input.js";
import { PreparedIrProgramInvariantError } from "../src/ir/program/errors.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { forEachInstrDeep, type IrInstr } from "../src/ir/core/nodes.js";
import { irUnitFuncRef, irRuntimeFuncRef } from "../src/ir/callable-bindings.js";
import * as fromAst from "../src/ir/from-ast.js";
import * as certification from "../src/ir/promise-delay.js";
import { IR_NATIVE_PROMISE_DELAY_FN } from "../src/ir/promise-delay-lowering.js";
import * as delayLowering from "../src/ir/promise-delay-lowering.js";
import { sourceInput, typedOptions } from "./helpers/typed-program-fixtures.js";
import { encodeTypedPacket, decodeTypedPacket } from "./helpers/typed-program-transport.mjs";

// Read the unchanged existing physical fixture, without executing its test suite.
const fixtureFile = ts.createSourceFile(
  "fixture.ts",
  readFileSync(new URL("./issue-4573-standalone-native-promise-delay.test.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const exactDeclaration = fixtureFile.statements
  .flatMap((statement) => (ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []))
  .find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "EXACT_DELAY");
if (!exactDeclaration?.initializer || !ts.isNoSubstitutionTemplateLiteral(exactDeclaration.initializer))
  throw new Error("missing exact delay fixture");
const EXACT_DELAY = exactDeclaration.initializer.text;
const promiseType = { kind: "extern", className: "Promise" };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function input(
  source = EXACT_DELAY,
  projection: IrProgramSourceInput["promiseDelayProjection"] = "standalone-native",
): IrProgramSourceInput {
  return {
    ...sourceInput({ "./entry.ts": source }),
    ...(projection === undefined ? {} : { promiseDelayProjection: projection }),
  };
}
function prepared(value: ReturnType<typeof prepareIrProgramSources>): IrProgramSourcePreparation {
  expect(value.kind, JSON.stringify(value)).toBe("prepared");
  if (value.kind !== "prepared") throw new Error(value.detail);
  return value;
}
function instructions(source: IrProgramSourcePreparation) {
  const rows: IrInstr[] = [];
  for (const fn of source.ir.functions)
    for (const block of fn.blocks)
      for (const instruction of block.instrs) forEachInstrDeep(instruction, (value) => rows.push(value));
  return rows;
}
function originalInventory(value: IrProgramSourceInput) {
  return buildIrUnitInventory(value.sourceFiles, {
    entrySource: value.entrySource,
    checker: value.checker,
    ...value.inventoryOptions,
  });
}
function location(inventory: ReturnType<typeof originalInventory>, name = "delay") {
  const owner = inventory.terminalUnits.find((unit) => unit.displayName === name)!;
  expect(owner).toBeDefined();
  return {
    unitId: owner.id,
    sourceFile: inventory.sources.find((source) => source.id === owner.sourceId)!.sourceKey,
    location: {
      sourceId: owner.sourceId,
      line: owner.line,
      column: owner.column,
      declarationStart: owner.declarationStart,
      declarationEnd: owner.declarationEnd,
    },
  };
}
function invalid(run: () => unknown) {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PreparedIrProgramInvariantError);
  expect(caught).toMatchObject({ code: "invalid-prepared-data" });
}

describe("explicit certified native delay source admission", () => {
  it("pins the exact existing source and admits one body without losing either original arrow", () => {
    expect(createHash("sha256").update(EXACT_DELAY).digest("hex")).toBe(
      "3339bafcba469f92760d6661a4b1f0fddede19013ceaaeacc088e4b9c9e60002",
    );
    const request = input();
    const before = originalInventory(request);
    const source = prepared(prepareIrProgramSources(request));
    expect(source.inventory).toEqual(before);
    expect(source.inventory.allUnits).toHaveLength(3);
    expect(source.inventory.terminalUnits).toHaveLength(1);
    expect(source.ir.functions).toHaveLength(1);
    expect(source.derivedUnits).toEqual([]);
    expect(source.inventory.allUnits.filter((unit) => !unit.terminal).map((unit) => unit.kind)).toEqual([
      "arrow-function",
      "arrow-function",
    ]);
    expect(source.ir.functions[0]!.resultTypes).toEqual([promiseType]);
    const calls = instructions(source).filter((instruction) => instruction.kind === "call");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      target: { binding: { kind: "runtime", symbol: IR_NATIVE_PROMISE_DELAY_FN } },
      resultType: promiseType,
    });
    expect(calls[0]!.args).toHaveLength(2);
    expect(source.ir.functions[0]!.params.map((param) => param.type)).toEqual([
      { kind: "val", val: { kind: "f64" } },
      { kind: "val", val: { kind: "f64" } },
    ]);
    expect(instructions(source).some((instruction) => instruction.kind === "closure.new")).toBe(false);
    expect(source.allocations.snapshot().size).toBe(0);
  });

  it.each(["omitted", "disabled"] as const)(
    "keeps %s historical lowering and does not certify or pass delay plans",
    (mode) => {
      const request = {
        ...sourceInput({ "./entry.ts": EXACT_DELAY }),
        ...(mode === "disabled" ? { promiseDelayProjection: "disabled" as const } : {}),
      };
      const resolver = vi.spyOn(certification, "makeIrPromiseDelayResolver");
      const lower = vi.spyOn(fromAst, "lowerFunctionAstToIr");
      const result = prepareIrProgramSources(request);
      expect(result).toMatchObject({
        kind: "unsupported",
        code: "unknown-class-construction",
        stage: "build",
        ...location(originalInventory(request)),
      });
      expect(resolver).not.toHaveBeenCalled();
      expect(lower).toHaveBeenCalledTimes(1);
      expect(Object.hasOwn(lower.mock.calls[0]![1], "promiseDelays")).toBe(false);
    },
  );

  it.each(["garbage", "host-executor", null, true, 0])(
    "rejects invalid projection %s before source planning",
    (projection) => {
      const request = input();
      Reflect.set(request, "promiseDelayProjection", projection);
      const resolver = vi.spyOn(certification, "makeIrPromiseDelayResolver");
      invalid(() => prepareIrProgramSources(request));
      expect(resolver).not.toHaveBeenCalled();
    },
  );
  it.each([
    { backend: "wasmgc", target: "host" },
    { backend: "wasmgc", target: "wasi" },
    { backend: "wasmgc", target: "strict-no-host" },
    { backend: "linear", target: "standalone" },
  ] as const)("rejects explicit native source selection under $backend:$target", (policy) => {
    invalid(() => prepareIrProgramSources({ ...input(), policy }));
  });
  it.each([
    { backend: "wasmgc", target: "host" },
    { backend: "wasmgc", target: "wasi" },
    { backend: "linear", target: "standalone" },
  ] as const)("rejects an additional $backend:$target runtime projection", (policy) => {
    invalid(() => prepareWholeIrProgram({ ...input(), runtimePolicies: [typedOptions.policy, policy] }));
  });
  it("retains duplicate-policy and missing-source-policy checks", () => {
    const request = input();
    for (const runtimePolicies of [
      [request.policy, request.policy],
      [],
      [{ backend: "wasmgc" as const, target: "host" as const }],
    ])
      expect(() => prepareWholeIrProgram({ ...request, runtimePolicies })).toThrow(
        "runtime policies duplicate a backend/target pair or omit the source preparation policy",
      );
  });

  it("captures and decodes the complete typed packet without treating transport as prepared authority", () => {
    const request = input();
    const source = prepared(prepareIrProgramSources(request));
    const packet = captureTypedIrProgramInput(source);
    const encoded = encodeTypedPacket(packet);
    const decoded = decodeTypedPacket(encoded);
    expect(encodeTypedPacket(decoded)).toBe(encoded);
    expect(decoded).toEqual(packet);
    expect(packet.inventory).toEqual(originalInventory(request));
    expect(decoded.inventory.allUnits).toHaveLength(3);
    expect(decoded.derivedUnits).toEqual([]);
    expect(Object.hasOwn(packet, "promiseDelayProjection")).toBe(false);
    expect(ownTypedIrProgramInput(decoded).input.inventory).toEqual(packet.inventory);
    for (const candidate of [packet, decoded]) {
      const outcome = prepareTypedIrProgram(candidate, typedOptions);
      expect(outcome).toMatchObject({
        kind: "invariant",
        code: "unknown-function-ref",
        stage: "resolve",
        ...location(source.inventory),
      });
      if (outcome.kind === "prepared") throw new Error("missing canonical native delay provider was accepted");
      expect(outcome.detail).toContain(IR_NATIVE_PROMISE_DELAY_FN);
    }
    expect(prepareWholeIrProgram(request)).toMatchObject({
      kind: "invariant",
      code: "unknown-function-ref",
      stage: "resolve",
      ...location(source.inventory),
    });
  });

  it("resolves once, keeps same-name source owners distinct, and preserves input-order-independent capture", () => {
    const files = {
      "./a.ts": EXACT_DELAY,
      "./b.ts": EXACT_DELAY,
      "./entry.ts":
        'import { delay as a } from "./a"; import { delay as b } from "./b"; export function start(): void { a(1, 2); b(3, 4); }',
    };
    const resolver = vi.spyOn(certification, "makeIrPromiseDelayResolver");
    const forward = prepared(
      prepareIrProgramSources({ ...sourceInput(files), promiseDelayProjection: "standalone-native" }),
    );
    expect(resolver).toHaveBeenCalledTimes(1);
    const reverse = prepared(
      prepareIrProgramSources({ ...sourceInput(files, true), promiseDelayProjection: "standalone-native" }),
    );
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(captureTypedIrProgramInput(reverse)).toEqual(captureTypedIrProgramInput(forward));
    const owners = forward.inventory.terminalUnits.filter((unit) => unit.displayName === "delay");
    expect(owners).toHaveLength(2);
    expect(owners[0]!.id).not.toBe(owners[1]!.id);
    expect(forward.inventory.allUnits.filter((unit) => unit.kind === "arrow-function")).toHaveLength(4);
    const calls = instructions(forward).filter(
      (instruction) => instruction.kind === "call" && instruction.target.binding.kind === "unit",
    );
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.resultType)).toEqual([promiseType, promiseType]);
    expect(
      new Set(calls.map((call) => (call.target.binding.kind === "unit" ? call.target.binding.unitId : ""))),
    ).toEqual(new Set(owners.map((unit) => unit.id)));
    expect(forward.derivedUnits).toEqual([]);
  });

  it.each([
    [
      "concise executor",
      EXACT_DELAY.replace(
        "(resolve) => {\n    setTimeout(() => resolve(value), ms);\n  }",
        "(resolve) => setTimeout(() => resolve(value), ms)",
      ),
    ],
    ["wrong captured value", EXACT_DELAY.replace("resolve(value)", "resolve(ms)")],
    ["extra effect", EXACT_DELAY.replace("return new", "value = value + 1; return new")],
    ["shadowed timer", "function setTimeout(callback: () => void, ms: number): void {}\n" + EXACT_DELAY],
    [
      "shadowed Promise",
      "class Promise<T> { constructor(executor: (resolve: (value: T) => void) => void) {} }\n" + EXACT_DELAY,
    ],
  ])("does not certify the %s near miss", (_name, source) => {
    const request = input(source);
    const lower = vi.spyOn(fromAst, "lowerFunctionAstToIr");
    const result = prepareIrProgramSources(request);
    expect(result.kind).not.toBe("prepared");
    for (const [, options] of lower.mock.calls) expect(options.promiseDelays?.constructions.size ?? 0).toBe(0);
    expect(prepareIrProgramSources({ ...request, promiseDelayProjection: "disabled" })).toEqual(result);
  });

  it("retains the complete async family and its separate array-parameter limitation", () => {
    const source = readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8");
    const request = input(source);
    const inventory = originalInventory(request);
    expect(
      inventory.terminalUnits.filter((unit) =>
        ["delay", "fetchUser", "fetchAllSequential", "fetchAllParallel", "main"].includes(unit.displayName),
      ),
    ).toHaveLength(5);
    expect(source).toContain("fetchAllSequential(ids: number[]): Promise<number>");
    expect(source).toContain("const pending: Promise<number>[]");
    const result = prepareIrProgramSources(request);
    expect(result).toMatchObject({
      kind: "unsupported",
      code: "type-resolution-unsupported",
      stage: "build",
      ...location(inventory, "fetchAllSequential"),
    });
  });

  it("allows actual string constants and debug names equal to a support ID", () => {
    const seed = originalInventory(input());
    const supportId = seed.allUnits.find((unit) => unit.kind === "arrow-function")!.id;
    const request = input(EXACT_DELAY + `\nexport function label(): string { return ${JSON.stringify(supportId)}; }`);
    const lower = fromAst.lowerFunctionAstToIr;
    vi.spyOn(fromAst, "lowerFunctionAstToIr").mockImplementation((node, options) => {
      const output = lower(node, options);
      for (const block of output.main.blocks)
        for (const instruction of block.instrs)
          if (instruction.kind === "call") {
            expect(Reflect.set(instruction, "target", irRuntimeFuncRef(IR_NATIVE_PROMISE_DELAY_FN, supportId))).toBe(
              true,
            );
            // These names carry no constructor semantics without the exact
            // fnctor-shape discriminator. Preserve ordinary debug data.
            expect(
              Reflect.set(instruction, "debugLabel", {
                kind: "debug",
                constructorUnitId: supportId,
                constructorIdentity: { unitId: supportId },
              }),
            ).toBe(true);
          }
      return output;
    });
    const result = prepared(prepareIrProgramSources(request));
    expect(result.inventory.allUnits.some((unit) => unit.id === supportId && !unit.terminal)).toBe(true);
    expect(
      instructions(result).some(
        (instruction) => instruction.kind === "string.const" && instruction.value === supportId,
      ),
    ).toBe(true);
    expect(
      instructions(result).some((instruction) => instruction.kind === "call" && instruction.target.name === supportId),
    ).toBe(true);
  });

  it.each([
    "body",
    "provenance",
    "direct reference",
    "nested provider",
    "derived reference",
    "map",
    "set",
    "fnctor constructorUnitId",
    "fnctor constructorIdentity.unitId",
  ] as const)("rejects a produced %s targeting elided support", (mode) => {
    const lower = fromAst.lowerFunctionAstToIr;
    vi.spyOn(fromAst, "lowerFunctionAstToIr").mockImplementation((node, options) => {
      const output = lower(node, options);
      const plan = [...(options.promiseDelays?.constructions.values() ?? [])][0];
      if (!plan || options.ownerUnitId !== plan.ownerUnitId) return output;
      const supportId = options.identityContext!.unitIdByDeclaration.get(plan.timerCallback)!;
      const ref = irUnitFuncRef({ unitId: supportId, name: "timer" });
      if (mode === "body") return { ...output, lifted: [{ ...output.main, unitId: supportId }] };
      if (mode === "provenance")
        return {
          ...output,
          liftedUnitProvenance: [
            { id: supportId, parentId: plan.ownerUnitId, role: "lifted-closure", ordinal: 0, sourceUnit: true },
          ],
        };
      const instruction = output.main.blocks
        .flatMap((block) => block.instrs)
        .find((instruction) => instruction.kind === "call")!;
      if (mode === "direct reference") Reflect.set(instruction, "target", ref);
      else if (mode === "fnctor constructorUnitId" || mode === "fnctor constructorIdentity.unitId")
        Reflect.set(instruction, "adversarialNestedReference", {
          kind: "fnctor-shape",
          constructorUnitId: mode === "fnctor constructorUnitId" ? supportId : plan.ownerUnitId,
          constructorIdentity: {
            unitId: mode === "fnctor constructorIdentity.unitId" ? supportId : plan.ownerUnitId,
            paramIndex: 0,
          },
        });
      else
        Reflect.set(
          instruction,
          "adversarialNestedReference",
          mode === "map"
            ? new Map([[ref, 1]])
            : mode === "set"
              ? new Set([ref])
              : {
                  body: [
                    { provider: { kind: "callable", target: mode === "derived reference" ? plan.timerTarget : ref } },
                  ],
                },
        );
      return output;
    });
    const request = input();
    const outcome = prepareIrProgramSources(request);
    expect(outcome).toMatchObject({ kind: "invariant", stage: "build", ...location(originalInventory(request)) });
    if (outcome.kind === "prepared") throw new Error("dangling support accepted");
    expect(outcome.detail).toMatch(/fabricated support|reference to elided support/);
  });

  it("rejects a source-produced global binding whose owner points to elided support", () => {
    const request = input(EXACT_DELAY + "\nexport var cell: number = 1;");
    const inventory = originalInventory(request);
    const supportId = inventory.allUnits.find((unit) => unit.kind === "arrow-function")!.id;
    const storage = inventory.terminalUnits.find((unit) => unit.kind === "module-init")!;
    expect(storage).toBeDefined();
    const push = Array.prototype.push;
    let mutations = 0;
    let changed = false;
    let outcome: ReturnType<typeof prepareIrProgramSources>;
    // Intercept only the actual compiler-created global root as it is retained.
    // Resolver/module-init inputs are copies and cannot test this separate owner.
    Array.prototype.push = function (this: unknown[], ...entries: unknown[]): number {
      for (const entry of entries) {
        if (entry === null || typeof entry !== "object") continue;
        const binding = Object.getOwnPropertyDescriptor(entry, "binding")?.value;
        const identity = Object.getOwnPropertyDescriptor(entry, "identity")?.value;
        if (binding?.globalName === "cell" && identity?.storageOwnerUnitId === storage.id) {
          mutations++;
          changed = Reflect.set(binding, "ownerUnitId", supportId);
        }
      }
      return Reflect.apply(push, this, entries);
    };
    try {
      outcome = prepareIrProgramSources(request);
    } finally {
      Array.prototype.push = push;
    }
    expect(mutations).toBe(1);
    expect(changed).toBe(true);
    expect(outcome).toMatchObject({ kind: "invariant", stage: "build", ...location(inventory, "<module-init>") });
    if (outcome.kind === "prepared") throw new Error("foreign global owner accepted");
    expect(outcome.detail).toContain(`reference to elided support ${supportId}`);
  });

  it.each(["clear all", "remove one owner", "replace plan object", "replace map object"] as const)(
    "rejects post-lowering certified population mutation: %s",
    (mode) => {
      const request = input(EXACT_DELAY + EXACT_DELAY.replace("function delay(", "function second("));
      const lower = fromAst.lowerFunctionAstToIr;
      let mutations = 0;
      let before: number[] = [];
      let changed = false;
      vi.spyOn(fromAst, "lowerFunctionAstToIr").mockImplementation((node, options) => {
        const output = lower(node, options);
        if (node.name?.text !== "second") return output;
        const plans = options.promiseDelays!;
        before = [plans.constructions.size, plans.timers.size, plans.resolves.size];
        const removed = [...plans.constructions.values()].find((plan) => plan.ownerName === "delay")!;
        mutations++;
        if (mode === "replace map object") changed = Reflect.set(plans, "timers", new Map(plans.timers));
        else {
          const replacement = { ...removed };
          for (const [map, site] of [
            [plans.constructions, removed.construction],
            [plans.timers, removed.timerCall],
            [plans.resolves, removed.resolveCall],
          ] as const) {
            if (!(map instanceof Map)) throw new Error("expected mutable producer map for fault injection");
            if (mode === "clear all") Map.prototype.clear.call(map);
            else if (mode === "remove one owner") Map.prototype.delete.call(map, site);
            else Map.prototype.set.call(map, site, replacement);
          }
          changed = true;
        }
        return output;
      });
      const outcome = prepareIrProgramSources(request);
      expect(before).toEqual([2, 2, 2]);
      expect(mutations).toBe(1);
      expect(changed).toBe(true);
      expect(outcome).toMatchObject({ kind: "invariant", stage: "build", ...location(originalInventory(request)) });
      if (outcome.kind === "prepared") throw new Error("lost certified population accepted");
      expect(outcome.detail).toMatch(/certified Promise-delay plan (population|identity) changed during lowering/);
    },
  );

  it("compares the post-lowering support population against its independently saved original records", () => {
    const validate = delayLowering.validateNativePromiseDelaySupportByIdentity;
    let calls = 0;
    const observed: number[] = [];
    vi.spyOn(delayLowering, "validateNativePromiseDelaySupportByIdentity").mockImplementation((...args) => {
      const result = validate(...args);
      observed.push(result.length);
      return ++calls === 2 ? [] : result;
    });
    const request = input();
    const outcome = prepareIrProgramSources(request);
    expect(calls).toBe(2);
    expect(observed).toEqual([2, 2]);
    expect(outcome).toMatchObject({ kind: "invariant", stage: "build", ...location(originalInventory(request)) });
    if (outcome.kind === "prepared") throw new Error("missing retained support accepted");
    expect(outcome.detail).toBe("certified Promise-delay support population changed during lowering");
  });

  it("permits a legitimately empty initial certification population", () => {
    const request = input("export function scalar(value: number): number { return value + 1; }");
    const validate = vi.spyOn(delayLowering, "validateNativePromiseDelaySupportByIdentity");
    const native = prepared(prepareIrProgramSources(request));
    expect(validate).toHaveBeenCalledTimes(2);
    expect(validate.mock.results.map((result) => result.value)).toEqual([[], []]);
    const disabled = prepared(prepareIrProgramSources({ ...request, promiseDelayProjection: "disabled" }));
    expect(captureTypedIrProgramInput(native)).toEqual(captureTypedIrProgramInput(disabled));
  });
});
