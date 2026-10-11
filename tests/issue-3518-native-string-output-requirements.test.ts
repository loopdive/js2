// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import {
  collectNativeStringValueDemands,
  type NativeStringValueDemands,
} from "../src/ir/program/native-string-value-demands.js";
import {
  assertNativeStringOutputRequirementsCurrent,
  deriveNativeStringOutputRequirements,
  type NativeStringOutputRequirements,
  type NativeStringOutputUse,
} from "../src/ir/program/native-string-output-requirements.js";
import {
  nativeAsyncCallableValueTypes,
  NATIVE_ASYNC_CALLABLE_DECLARATIONS,
} from "../src/ir/runtime/native-async-callables.js";
import { irIntrinsicFuncRef } from "../src/ir/core/callable-bindings.js";
import { IR_STRING_CONCAT_FN, irStringConcatManySymbol } from "../src/ir/core/string-callables.js";
import {
  forEachInstrDeep,
  type IrFunction,
  type IrInstr,
  type IrInstrCall,
  type IrInstrStringConcat,
} from "../src/ir/core/nodes.js";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";
import { captureNativeFamilyRuntimeSupport } from "./helpers/native-family-runtime-support.js";
import { sourceInput, typedOptions, requireProgram, startupFiles } from "./helpers/typed-program-fixtures.js";

const ORIGINAL = readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8");
const policy = {
  backend: "wasmgc",
  target: "standalone",
  stringConst: { storage: "native" },
  stringConcat: { concat: "native" },
} as const;
const prepared = new Map<string, PreparedIrProgram>();
let artifactDirectory: string;

function callCounts(fn: IrFunction) {
  const count = (instructions: readonly IrInstr[]): number => {
    let total = 0;
    for (const root of instructions)
      forEachInstrDeep(root, (instruction) => {
        if (instruction.kind === "call") total++;
      });
    return total;
  };
  return {
    unitId: fn.unitId,
    name: fn.name,
    blockCalls: fn.blocks.reduce((sum, block) => sum + count(block.instrs), 0),
    asyncPlanCalls: fn.asyncPlan?.states.reduce((sum, state) => sum + count(state.body), 0) ?? 0,
  };
}

function prepare(
  gvnMode: "off" | "on",
  files = { "./entry.ts": ORIGINAL },
  family = true,
  selectedPolicy: typeof policy & { readonly stringLen?: { readonly len: "native" } } = policy,
): PreparedIrProgram {
  const source = prepareIrProgramSources({
    ...sourceInput(files),
    policy: selectedPolicy,
    ...(family
      ? { promiseDelayProjection: "standalone-native" as const, asyncFamilyProjection: "standalone-native" as const }
      : {}),
  });
  if (source.kind !== "prepared") throw new Error(`${source.kind}: ${source.detail}`);
  if (family) {
    expect(source.ir.functions).toHaveLength(5);
    writeFileSync(
      `${artifactDirectory}/${gvnMode}-source-stage.json`,
      JSON.stringify(
        {
          sourceSha256: createHash("sha256").update(ORIGINAL).digest("hex"),
          inventory: source.inventory,
          functions: source.ir.functions,
          callCounts: source.ir.functions.map(callCounts),
        },
        null,
        2,
      ),
    );
  }
  const packet = family
    ? captureNativeFamilyRuntimeSupport(source, selectedPolicy)
    : captureTypedIrProgramInput(source);
  const program = requireProgram(
    prepareTypedIrProgram(packet, {
      ...typedOptions,
      policy: selectedPolicy,
      runtimePolicies: [selectedPolicy],
      controls: { ...typedOptions.controls, gvnMode },
    }),
  );
  assertPreparedIrProgram(program);
  return program;
}
function census(program: PreparedIrProgram): NativeStringValueDemands {
  return collectNativeStringValueDemands(program, program.runtime[0]!);
}
function requireOutput(demands: NativeStringValueDemands, emptyIdentity = false): NativeStringOutputRequirements {
  const result = deriveNativeStringOutputRequirements(demands, { emptyIdentity });
  if (!("demands" in result)) throw new Error(`${result.kind}: ${result.detail}`);
  assertNativeStringOutputRequirementsCurrent(result);
  return result;
}
/** Isolated copies of real prepared bodies, for positive-first corruption probes only. */
function editable(original = prepared.get("off:original")!) {
  const old = original.runtime[0]!;
  const projection = {
    ...old,
    prepared: {
      ...old.prepared,
      functions: structuredClone(old.prepared.functions),
      manifest: structuredClone(old.prepared.manifest),
    },
  };
  const program = {
    ...original,
    ir: { ...original.ir, functions: structuredClone(original.ir.functions) },
    allocations: structuredClone(original.allocations),
    runtime: [projection],
  };
  const demands = census(program);
  const positive = requireOutput(demands);
  return { program, projection, demands, positive };
}
function selectedInstruction<K extends NativeStringOutputUse["kind"]>(
  data: ReturnType<typeof editable>,
  kind: K,
): K extends "binary-concat" ? IrInstrStringConcat : IrInstrCall {
  const use = data.positive.uses.find((row) => row.kind === kind);
  expect(use, `positive ${kind} selection`).toBeDefined();
  const instruction = data.demands.occurrences[use!.occurrence]!.instruction;
  expect(instruction.kind).toBe(kind === "binary-concat" ? "string.concat" : "call");
  // The assertions above authenticate the discriminator for this test helper.
  return instruction as K extends "binary-concat" ? IrInstrStringConcat : IrInstrCall;
}
function failure(program: PreparedIrProgram, expected: RegExp): void {
  const result = deriveNativeStringOutputRequirements(census(program), { emptyIdentity: false });
  expect(result).toMatchObject({ kind: "unsupported", code: "body-shape-rejected", stage: "build" });
  if ("demands" in result) throw new Error("unexpected admission");
  expect(result.detail).toMatch(expected);
  expect(result.unitId).toBeTruthy();
  const source = program.inventory.sources.find((row) => row.id === result.location.sourceId);
  expect(source).toBeDefined();
  expect(source!.sourceKey).toBe("entry.ts");
  expect(result.sourceFile).toBe(source!.sourceKey);
  expect(result.location.line).toBeGreaterThan(0);
}
function record(name: string, demands: NativeStringValueDemands, output?: NativeStringOutputRequirements): void {
  writeFileSync(
    `${artifactDirectory}/${name}.json`,
    JSON.stringify(
      {
        sourceSha256: createHash("sha256").update(ORIGINAL).digest("hex"),
        inventory: demands.program.inventory,
        derivedUnits: demands.program.derivedUnits,
        owners: demands.owners.map((owner) => ({ id: owner.unitId, name: owner.programFunction.name })),
        buffers: demands.buffers.map(({ instructions, ...coordinate }) => ({
          ...coordinate,
          length: instructions.length,
        })),
        occurrences: demands.occurrences,
        uses: output?.uses,
        batchArities: output?.batchArities,
      },
      null,
      2,
    ),
  );
}

beforeAll(() => {
  mkdirSync(".tmp", { recursive: true });
  artifactDirectory = mkdtempSync(".tmp/native-string-output-requirements-");
  writeFileSync(`${artifactDirectory}/source.ts`, ORIGINAL);
  for (const gvn of ["off", "on"] as const) {
    const original = prepare(gvn);
    prepared.set(`${gvn}:original`, original);
    const encoded = encodePreparedIrProgram(original);
    writeFileSync(`${artifactDirectory}/${gvn}-prepared.json`, encoded);
    writeFileSync(
      `${artifactDirectory}/${gvn}-prepared-call-counts.json`,
      JSON.stringify(
        {
          semantic: original.ir.functions.map(callCounts),
          projection: original.runtime[0]!.prepared.functions.map(callCounts),
        },
        null,
        2,
      ),
    );
    prepared.set(`${gvn}:decoded`, decodePreparedIrProgram(encoded));
    for (const view of ["original", "decoded"])
      record(`${gvn}-${view}-before`, census(prepared.get(`${gvn}:${view}`)!));
  }
}, 35000);

// Give the fork's IPC task updates a turn between the synchronous graph checks.
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

describe("native string output requirements over the complete prepared family", () => {
  for (const gvn of ["off", "on"] as const)
    for (const view of ["original", "decoded"])
      it.each([false, true])(`authenticates unchanged family gvn=${gvn} ${view} emptyIdentity=%s`, (emptyIdentity) => {
        expect(createHash("sha256").update(ORIGINAL).digest("hex")).toBe(
          "6bc4fc96cc65881c9919a39b840afaf1001dfd3d0e05ef0cc141441a051f7915",
        );
        const program = prepared.get(`${gvn}:${view}`)!;
        const demands = census(program);
        expect(program.inventory.allUnits).toHaveLength(7);
        expect(program.inventory.terminalUnits.map((row) => row.displayName)).toEqual([
          "delay",
          "fetchUser",
          "fetchAllSequential",
          "fetchAllParallel",
          "main",
        ]);
        expect(program.derivedUnits).toHaveLength(11);
        expect(demands.owners).toHaveLength(16);
        expect(demands.buffers).toHaveLength(80);
        expect(demands.occurrences).toHaveLength(216);
        expect(demands.buffers.filter((row) => row.path.length > 0)).toHaveLength(12);
        expect(demands.allocations).toBe(program.allocations);
        expect(new Set(demands.buffers.map((row) => row.root.kind))).toEqual(
          new Set(["block", "async-plan", "async-runtime"]),
        );
        expect(demands.buffers.some((row) => row.path.length > 0)).toBe(true);
        const output = requireOutput(demands, emptyIdentity);
        record(`${gvn}-${view}-${emptyIdentity}-after`, demands, output);
        expect(output.demands).toBe(demands);
        expect(output.options).toEqual({ emptyIdentity });
        expect(output.binaryConcat).toBe(true);
        expect(output.stdout).toBe(true);
        expect(output.batchArities).toEqual([5]);
        expect(output.uses).toHaveLength(8);
        expect(output.uses.filter((row) => row.kind === "binary-concat")).toHaveLength(2);
        expect(output.uses.filter((row) => row.kind === "batched-concat")).toHaveLength(2);
        expect(output.uses.filter((row) => row.kind === "stdout-append")).toHaveLength(4);
        expect(new Set(output.uses.map((row) => row.kind))).toEqual(
          new Set(["binary-concat", "batched-concat", "stdout-append"]),
        );
        expect(new Set(output.uses.map((row) => row.occurrence)).size).toBe(output.uses.length);
        expect(output.uses.map((row) => row.occurrence)).toEqual(
          output.uses.map((row) => row.occurrence).toSorted((a, b) => a - b),
        );
        for (const use of output.uses) {
          const row = demands.occurrences[use.occurrence]!;
          const buffer = demands.buffers[row.bufferIndex]!;
          expect(row.instruction).toBe(buffer.instructions[row.instructionIndex]);
          expect(buffer.view).toBe("projection");
          expect(buffer.root.kind).not.toBe("async-plan");
          expect(Object.isFrozen(use)).toBe(true);
        }
        expect(Object.isFrozen(output)).toBe(true);
        expect(Object.isFrozen(output.options)).toBe(true);
        expect(Object.isFrozen(output.uses)).toBe(true);
        expect(Object.isFrozen(output.batchArities)).toBe(true);
      });

  it.each(["scalar", "startup"])("keeps genuine no-output %s programs empty including initializer owners", (kind) => {
    const files =
      kind === "startup"
        ? startupFiles
        : { "./entry.ts": "export function identity(x: number): number { return x + 1; }" };
    const program = prepare("off", files, false);
    const output = requireOutput(census(program));
    expect(output.uses).toEqual([]);
    expect(output.batchArities).toEqual([]);
    expect(output.binaryConcat).toBe(false);
    expect(output.stdout).toBe(false);
    expect(output.demands.owners).toHaveLength(program.inventory.terminalUnits.length + program.derivedUnits.length);
  });

  it("does not impose output SSA validation on unrelated no-output bodies", () => {
    const original = prepare(
      "off",
      { "./entry.ts": "export function identity(x: number): number { return x + 1; }" },
      false,
    );
    const data = editable(original);
    expect(data.positive.uses).toEqual([]);
    for (const fn of [data.program.ir.functions[0]!, data.projection.prepared.functions[0]!]) {
      const result = fn.blocks.flatMap((block) => block.instrs).find((instruction) => instruction.result !== null)!;
      Object.assign(result, { result: fn.params[0]!.value, resultType: { kind: "string" } });
      expect(() => nativeAsyncCallableValueTypes(fn)).toThrow(/conflicting SSA type/);
    }
    expect(requireOutput(census(data.program)).uses).toEqual([]);
  });

  it.each(["missing", "duplicate", "symbol", "signature", "policy"])(
    "rejects a %s selected provider after a positive",
    (mutation) => {
      const data = editable();
      const manifest = data.projection.prepared.manifest;
      const canonical = manifest.providers.find((row) => row.feature === "js.string.concat")!;
      expect(canonical).toBeDefined();
      if (mutation === "missing")
        Object.assign(manifest, { providers: manifest.providers.filter((row) => row !== canonical) });
      if (mutation === "duplicate") Object.assign(manifest, { providers: [...manifest.providers, canonical] });
      if (mutation === "symbol")
        Object.assign(canonical, { implementation: { kind: "runtime-callable", symbol: "__foreign_concat" } });
      if (mutation === "signature") Object.assign(canonical, { signature: { params: [], results: [] } });
      if (mutation === "policy") Object.assign(manifest.policy, { stringConcat: { concat: "host" } });
      expect(() => deriveNativeStringOutputRequirements(census(data.program), { emptyIdentity: false })).toThrow(
        /provider|native concatenation/,
      );
    },
  );

  it.each(["missing", "wrong-binding", "same-binding-renamed"])("rejects %s binary provider attachment", (mutation) => {
    const data = editable();
    const instruction = selectedInstruction(data, "binary-concat");
    if (mutation === "missing") {
      const id = data.positive.uses.find((row) => row.kind === "binary-concat")!.occurrence;
      const buffer = data.demands.buffers[data.demands.occurrences[id]!.bufferIndex]!;
      const original = data.demands.owners.find((owner) => owner.unitId === buffer.ownerUnitId)!.programFunction;
      const peer = original.blocks[buffer.root.index]!.instrs[data.demands.occurrences[id]!.instructionIndex]!;
      Object.assign(peer, { provider: irIntrinsicFuncRef(IR_STRING_CONCAT_FN) });
      Object.assign(instruction, { provider: irIntrinsicFuncRef(IR_STRING_CONCAT_FN) });
      requireOutput(census(data.program));
      Reflect.deleteProperty(instruction, "provider");
    }
    if (mutation === "wrong-binding") Object.assign(instruction, { provider: irIntrinsicFuncRef("foreign.concat") });
    if (mutation === "same-binding-renamed")
      Object.assign(instruction, { provider: { ...irIntrinsicFuncRef(IR_STRING_CONCAT_FN), name: "__str_concat" } });
    expect(() => deriveNativeStringOutputRequirements(census(data.program), { emptyIdentity: false })).toThrow(
      /attachment|provider/,
    );
  });

  it.each(["arity", "result", "argument"])("refuses canonical batch with wrong logical %s", (mutation) => {
    const data = editable();
    const instruction = selectedInstruction(data, "batched-concat");
    if (mutation === "arity") Object.assign(instruction, { args: instruction.args.slice(1) });
    if (mutation === "result") Object.assign(instruction, { resultType: { kind: "val", val: { kind: "f64" } } });
    if (mutation === "argument") {
      const use = data.positive.uses.find((row) => row.kind === "batched-concat")!;
      const buffer = data.demands.buffers[data.demands.occurrences[use.occurrence]!.bufferIndex]!;
      const fn = data.demands.owners.find((owner) => owner.unitId === buffer.ownerUnitId)!.projectedFunction;
      const numeric = [...nativeAsyncCallableValueTypes(fn)].find(
        ([, type]) => type.kind === "val" && type.val.kind === "f64",
      );
      expect(numeric).toBeDefined();
      Object.assign(instruction, { args: [numeric![0], ...instruction.args.slice(1)] });
    }
    failure(data.program, /native string output call/);
  });

  it("rejects a canonical stdout call carrying a value result", () => {
    const data = editable();
    const instruction = selectedInstruction(data, "stdout-append");
    Object.assign(instruction, { result: instruction.args[0], resultType: { kind: "string" } });
    failure(data.program, /void callable has a result/);
  });

  it("rejects a name-only batch lookalike without granting output ownership", () => {
    const data = editable();
    const instruction = selectedInstruction(data, "batched-concat");
    Object.assign(instruction, { target: { ...irIntrinsicFuncRef("foreign.batch"), name: instruction.target.name } });
    expect(() => deriveNativeStringOutputRequirements(census(data.program), { emptyIdentity: false })).toThrow(
      /differs across prepared views/,
    );
  });

  it("reconciles exact operands across views instead of accepting signature equality", () => {
    const data = editable();
    const instruction = selectedInstruction(data, "batched-concat");
    expect(instruction.args[0]).not.toBe(instruction.args[1]);
    Object.assign(instruction, { args: [instruction.args[1], instruction.args[0], ...instruction.args.slice(2)] });
    expect(() => deriveNativeStringOutputRequirements(census(data.program), { emptyIdentity: false })).toThrow(
      /instruction differs across prepared views/,
    );
  });

  it.each(["missing", "extra"])("rejects matching views with a %s original owner", (mutation) => {
    const data = editable();
    if (mutation === "missing") {
      Object.assign(data.program.ir, { functions: data.program.ir.functions.slice(1) });
      Object.assign(data.projection.prepared, { functions: data.projection.prepared.functions.slice(1) });
    } else {
      const nonterminal = data.program.inventory.allUnits.find((row) => !row.terminal)!;
      Object.assign(data.program.ir, {
        functions: [...data.program.ir.functions, { ...data.program.ir.functions[0]!, unitId: nonterminal.id }],
      });
      Object.assign(data.projection.prepared, {
        functions: [
          ...data.projection.prepared.functions,
          { ...data.projection.prepared.functions[0]!, unitId: nonterminal.id },
        ],
      });
    }
    expect(() => deriveNativeStringOutputRequirements(census(data.program), { emptyIdentity: false })).toThrow(
      /missing or extra original\/derived/,
    );
  });

  it("refuses copied census instructions even when their data is equal", () => {
    const data = editable();
    const detached = {
      ...data.demands,
      occurrences: data.demands.occurrences.map((row) => ({ ...row, instruction: { ...row.instruction } })),
    };
    expect(() => deriveNativeStringOutputRequirements(detached, { emptyIdentity: false })).toThrow(/detached borrowed/);
  });

  it("authenticates exact issued requirements and caller-owned option values", () => {
    const data = editable();
    const options = { emptyIdentity: true };
    const output = deriveNativeStringOutputRequirements(data.demands, options);
    if (!("demands" in output)) throw new Error(output.detail);
    assertNativeStringOutputRequirementsCurrent(output);
    expect(() => assertNativeStringOutputRequirementsCurrent({ ...output })).toThrow(/unissued/);
    options.emptyIdentity = false;
    expect(() => assertNativeStringOutputRequirementsCurrent(output)).toThrow(/stale output selections or options/);
    expect(() => assertNativeStringOutputRequirementsCurrent(data.positive)).not.toThrow();
  });

  it("rejects in-place instruction mutation after successful derivation", () => {
    const data = editable();
    const instruction = selectedInstruction(data, "binary-concat");
    Object.assign(instruction, { rhs: instruction.lhs });
    expect(() => assertNativeStringOutputRequirementsCurrent(data.positive)).toThrow(/changed after selection/);
  });

  it("preserves unknown allocation metadata and refuses its later mutation", () => {
    const data = editable();
    expect(data.program.allocations.metadata.length).toBeGreaterThan(0);
    const row = data.program.allocations.metadata[0]!;
    const payload = { nested: { value: 17 }, explicit: undefined, nan: NaN, negativeZero: -0 };
    Object.assign(row, { entries: [...row.entries, ["test.output.unknown", payload]] });
    const demands = census(data.program);
    const positive = requireOutput(demands);
    expect(positive.demands.allocations).toBe(data.program.allocations);
    expect(row.entries.at(-1)![1]).toBe(payload);
    payload.nested.value = 18;
    expect(() => assertNativeStringOutputRequirementsCurrent(positive)).toThrow(/changed after selection/);
  });

  it("rejects equal-data replacement of an unknown metadata payload", () => {
    const data = editable();
    const row = data.program.allocations.metadata[0]!;
    const payload = { nested: { value: 17 } };
    const pair = ["test.output.unknown", payload] as const;
    Object.assign(row, { entries: [...row.entries, pair] });
    const positive = requireOutput(census(data.program));
    Object.assign(payload, { nested: { value: 17 } });
    expect(() => assertNativeStringOutputRequirementsCurrent(positive)).toThrow(/metadata identity changed/);
  });

  it("rejects allocation snapshot identity replacement after a positive", () => {
    const data = editable();
    Object.assign(data.program, { allocations: structuredClone(data.program.allocations) });
    expect(() => assertNativeStringOutputRequirementsCurrent(data.positive)).toThrow(/detached borrowed/);
  });

  it("retains the located owned-append refusal", () => {
    const data = editable();
    Object.assign(selectedInstruction(data, "binary-concat"), { concatMode: "owned-append" });
    failure(data.program, /owned string concatenation/);
  });

  it("retains a real source-produced string-length refusal", () => {
    const positive = prepare("off", { "./entry.ts": 'export function value(): string { return "abc"; }' }, false);
    expect(requireOutput(census(positive)).uses).toEqual([]);
    const unsupported = prepare(
      "off",
      { "./entry.ts": "export function value(s: string): number { return s.length; }" },
      false,
      { ...policy, stringLen: { len: "native" } },
    );
    failure(unsupported, /string.len has no native string output/);
  });

  it("keeps closed batch arities in first-use order without trusting a name prefix", () => {
    const data = editable();
    const canonical = NATIVE_ASYNC_CALLABLE_DECLARATIONS.find((row) => row.feature === "js.string.concat.many")!;
    const order = [8, 3, 6, 4, 7, 5];
    for (const [view, functions] of [
      ["program", data.program.ir.functions],
      ["projection", data.projection.prepared.functions],
    ] as const) {
      const demands = census(data.program);
      const buffers = demands.buffers.filter(
        (buffer) => buffer.view === view && buffer.root.kind === "block" && buffer.path.length === 0,
      );
      let inserted = false;
      for (const buffer of buffers) {
        const index = buffer.instructions.findIndex(
          (instruction) =>
            instruction.kind === "call" && JSON.stringify(instruction.target) === JSON.stringify(canonical.ref),
        );
        if (index < 0 || inserted) continue;
        const original = buffer.instructions[index]!;
        if (original.kind !== "call") throw new Error("missing genuine batch call");
        const fn = functions.find((candidate) => candidate.unitId === buffer.ownerUnitId)!;
        const block = fn.blocks[buffer.root.index]!;
        const expanded: IrInstr[] = order.map((arity) => ({
          ...original,
          target: irIntrinsicFuncRef(irStringConcatManySymbol(arity)),
          args: Array.from({ length: arity }, (_, i) => original.args[i % original.args.length]!),
        }));
        Object.assign(block, {
          instrs: [...block.instrs.slice(0, index), ...expanded, ...block.instrs.slice(index + 1)],
        });
        inserted = true;
      }
      expect(inserted).toBe(true);
    }
    const selected = requireOutput(census(data.program));
    expect(selected.batchArities).toEqual(order);
    expect(selected.binaryConcat).toBe(true);
  });
});
