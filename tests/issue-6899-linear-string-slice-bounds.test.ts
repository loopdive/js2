// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  addArrayRuntime,
  addLinearIrStringRuntime,
  addRuntime,
  addStringRuntime,
  addUint8ArrayRuntime,
  LINEAR_IR_STRING_CHAR_AT_FN,
} from "../src/codegen-linear/runtime.js";
import * as binaryEmitter from "../src/emit/binary.js";
import { resolveLayout } from "../src/emit/resolve-layout.js";
import { compile } from "../src/index.js";
import {
  LINEAR_RECORD_TAG_OFFSET,
  LINEAR_STRING_ELEMENTS_OFFSET,
  LINEAR_STRING_LENGTH_OFFSET,
  LINEAR_STRING_PAYLOAD_PREFIX_BYTES,
  LINEAR_STRING_PAYLOAD_SIZE_OFFSET,
  LINEAR_VECTOR_CAPACITY_OFFSET,
  LINEAR_VECTOR_ELEMENTS_OFFSET,
  LINEAR_VECTOR_LENGTH_OFFSET,
} from "../src/ir/analysis/linear-memory-plan.js";
import { getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";
import { forEachInstrDeep, type IrInstr } from "../src/ir/nodes.js";
import { createEmptyModule, type Instr } from "../src/ir/types.js";
import { walkInstructions } from "../src/wasm/model/instruction-walk.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const align8 = (size: number) => Math.ceil(size / 8) * 8;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const MIN = -2147483648;
const MAX = 2147483647;
const testPath = "tests/issue-6899-linear-string-slice-bounds.test.ts";
const semanticRows = new Set<string>();
const allocatorRows = new Set<string>();
let transparentRows = 0;

function record(kind: string, data: object) {
  console.log(JSON.stringify({ issue: 6899, schemaVersion: 1, kind, ...data }));
}
type Evidence = { phase: string; classification: string; [key: string]: unknown };
async function row(lane: string, id: string, action: (evidence: Evidence) => Promise<void>) {
  const evidence: Evidence = { phase: "setup", classification: "test-setup" };
  let failure: unknown;
  try {
    await action(evidence);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    (lane === "allocator-guard" ? allocatorRows : semanticRows).add(id);
    record("row", {
      lane,
      id,
      status: failure === undefined ? "passed" : "failed",
      evidence,
      failure:
        failure instanceof Error
          ? { name: failure.name, message: failure.message }
          : failure === undefined
            ? null
            : String(failure),
    });
  }
}

beforeAll(() => {
  const helper = "src/codegen-linear/runtime/string-slice.ts";
  record("provenance", {
    head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    baseline: "8f3b70b37a37d5f475f759d155391621d79ffc92",
    runtimeSha256: sha256(readFileSync("src/codegen-linear/runtime.ts")),
    helperSha256: existsSync(helper) ? sha256(readFileSync(helper)) : "absent",
    testSha256: sha256(readFileSync(testPath)),
    node: process.version,
    v8: process.versions.v8,
    execArgv: process.execArgv,
    nodeOptions: process.env.NODE_OPTIONS ?? "",
    target: "linear",
    optimize: false,
    runtimeMemoryPages: 1,
    instrumentMaximumRequest: 64,
    scope: "existing overlay/direct/runtime-only correctness; not PreparedIR coverage or Unicode slice compliance",
    expectedSemanticRows: 45,
    expectedAllocatorRows: 2,
    expectedTransparencyRows: 12,
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(() => {
  record("population", { semanticRows: [...semanticRows], allocatorRows: [...allocatorRows], transparentRows });
  expect(semanticRows.size).toBe(45);
  expect(allocatorRows.size).toBe(2);
  expect(transparentRows).toBe(12);
});

interface Runtime {
  memory: WebAssembly.Memory;
  heap: WebAssembly.Global;
  counters: WebAssembly.Global[];
  used: () => number;
  malloc: (size: number) => number;
  slice: (source: number, start: number, end: number) => number;
  charAt: (source: number, index: number) => number;
  split: (source: number, separator: number) => number;
}
async function buildRuntime(guarded: boolean): Promise<Runtime> {
  const mod = createEmptyModule();
  addRuntime(mod, { exposeArenaReset: true });
  addUint8ArrayRuntime(mod);
  addArrayRuntime(mod);
  addStringRuntime(mod);
  addLinearIrStringRuntime(mod);
  mod.memories[0].max = 1;
  const importedGlobals = mod.imports.filter((entry) => entry.desc.kind === "global").length;
  const counterIndices = ["calls", "request", "guardTrips"].map((name) => {
    const index = importedGlobals + mod.globals.length;
    mod.globals.push({
      name: `issue6899_${name}`,
      type: { kind: "i32" },
      mutable: true,
      init: [{ op: "i32.const", value: 0 }],
    });
    mod.exports.push({ name: `issue6899_${name}`, desc: { kind: "global", index } });
    return index;
  });
  const increment = (index: number): Instr[] => [
    { op: "global.get", index },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "global.set", index },
  ];
  const malloc = mod.functions.find((fn) => fn.name === "__malloc");
  if (!malloc) throw new Error("fixture missing real malloc");
  if (guarded)
    malloc.body = [
      ...increment(counterIndices[0]),
      { op: "local.get", index: 0 },
      { op: "global.set", index: counterIndices[1] },
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 64 },
      { op: "i32.gt_u" },
      { op: "if", blockType: { kind: "empty" }, then: [...increment(counterIndices[2]), { op: "unreachable" }] },
      ...malloc.body,
    ];
  const importedFunctions = mod.imports.filter((entry) => entry.desc.kind === "func").length;
  for (const name of ["__malloc", "__str_slice", "__str_split", LINEAR_IR_STRING_CHAR_AT_FN]) {
    const position = mod.functions.findIndex((fn) => fn.name === name);
    if (position < 0) throw new Error(`fixture missing ${name}`);
    mod.exports.push({ name, desc: { kind: "func", index: importedFunctions + position } });
  }
  const heap = mod.globals.findIndex((global) => global.name === "__heap_ptr");
  if (heap < 0) throw new Error("fixture missing heap observation");
  mod.exports.push({ name: "issue6899_heap", desc: { kind: "global", index: importedGlobals + heap } });
  const binary = binaryEmitter.emitBinary(mod);
  const wasmBytes = new Uint8Array(binary);
  expect(WebAssembly.validate(wasmBytes)).toBe(true);
  const { instance } = await WebAssembly.instantiate(wasmBytes);
  const e = instance.exports;
  return {
    memory: e.memory as WebAssembly.Memory,
    heap: e.issue6899_heap as WebAssembly.Global,
    counters: [e.issue6899_calls, e.issue6899_request, e.issue6899_guardTrips] as WebAssembly.Global[],
    used: e.__arena_used as Runtime["used"],
    malloc: e.__malloc as Runtime["malloc"],
    slice: e.__str_slice as Runtime["slice"],
    charAt: e[LINEAR_IR_STRING_CHAR_AT_FN] as Runtime["charAt"],
    split: e.__str_split as Runtime["split"],
  };
}
function requests(r: Runtime) {
  const [calls, requestedBytes, guardTrips] = r.counters.map((global) => Number(global.value) >>> 0);
  return { calls, requestedBytes, guardTrips };
}
function resetObservations(r: Runtime) {
  for (const global of r.counters) global.value = 0;
}
type Region = { name: string; pointer: number; size: number };
function sourceRecord(r: Runtime, text: string): Region {
  const bytes = encoder.encode(text);
  expect(bytes.length).toBeLessThanOrEqual(16);
  const size = align8(LINEAR_STRING_ELEMENTS_OFFSET + bytes.length);
  const pointer = r.malloc(LINEAR_STRING_ELEMENTS_OFFSET + bytes.length) >>> 0;
  expect(pointer + size).toBeLessThanOrEqual(r.memory.buffer.byteLength);
  const view = new DataView(r.memory.buffer);
  expect(view.getUint32(pointer + LINEAR_RECORD_TAG_OFFSET, true)).toBe(0);
  view.setUint32(pointer + LINEAR_STRING_PAYLOAD_SIZE_OFFSET, bytes.length + LINEAR_STRING_PAYLOAD_PREFIX_BYTES, true);
  view.setUint32(pointer + LINEAR_STRING_LENGTH_OFFSET, bytes.length, true);
  new Uint8Array(r.memory.buffer, pointer + LINEAR_STRING_ELEMENTS_OFFSET, bytes.length).set(bytes);
  return { name: `source:${text}`, pointer, size };
}
function neighbor(r: Runtime): Region {
  const pointer = r.malloc(32) >>> 0;
  new Uint8Array(r.memory.buffer, pointer, 32).fill(0x93);
  return { name: "occupied-neighbor", pointer, size: 32 };
}
function snapshot(r: Runtime, regions: Region[]) {
  const bytes = new Uint8Array(r.memory.buffer).slice();
  return {
    heap: Number(r.heap.value) >>> 0,
    used: r.used(),
    memoryBytes: bytes.length,
    memorySha256: sha256(bytes),
    regions: regions.map((region) => ({
      ...region,
      bytes: Array.from(bytes.slice(region.pointer, region.pointer + region.size)),
    })),
    bytes,
  };
}
type Snapshot = ReturnType<typeof snapshot>;
function printable(state: Snapshot) {
  const { bytes: _bytes, ...rest } = state;
  return rest;
}
interface StringOutput {
  pointer: number;
  header?: number;
  payloadSize?: number;
  length?: number;
  bytes?: number[];
  text?: string;
  malformed?: string;
}
function readString(memory: WebAssembly.Memory, pointer: number): StringOutput {
  const output: StringOutput = { pointer };
  if (!Number.isInteger(pointer) || pointer < 0 || pointer + LINEAR_STRING_ELEMENTS_OFFSET > memory.buffer.byteLength)
    return { ...output, malformed: "record pointer outside bounded memory" };
  const view = new DataView(memory.buffer);
  output.header = view.getUint32(pointer + LINEAR_RECORD_TAG_OFFSET, true);
  output.payloadSize = view.getUint32(pointer + LINEAR_STRING_PAYLOAD_SIZE_OFFSET, true);
  output.length = view.getUint32(pointer + LINEAR_STRING_LENGTH_OFFSET, true);
  if (output.length > 64 || pointer + LINEAR_STRING_ELEMENTS_OFFSET + output.length > memory.buffer.byteLength)
    return { ...output, malformed: "refused oversized/out-of-memory host payload view" };
  output.bytes = Array.from(new Uint8Array(memory.buffer, pointer + LINEAR_STRING_ELEMENTS_OFFSET, output.length));
  try {
    output.text = decoder.decode(new Uint8Array(output.bytes));
  } catch (error) {
    output.malformed = `invalid UTF-8: ${String(error)}`;
  }
  return output;
}
function invoke(call: () => number) {
  try {
    return { pointer: call(), error: undefined };
  } catch (error) {
    return { pointer: undefined, error };
  }
}
function errorRecord(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message, runtimeError: error instanceof WebAssembly.RuntimeError }
    : null;
}

async function observeString(
  text: string,
  expected: string,
  guarded: boolean,
  call: (r: Runtime, pointer: number) => number,
) {
  const r = await buildRuntime(guarded);
  const source = sourceRecord(r, text);
  const occupied = neighbor(r);
  const delta = align8(LINEAR_STRING_ELEMENTS_OFFSET + encoder.encode(expected).length);
  const start = Number(r.heap.value) >>> 0;
  new Uint8Array(r.memory.buffer, start, delta + 64).fill(0xa5);
  const guard = { name: "post-result-poison", pointer: start + delta, size: 64 };
  resetObservations(r); // Observation reset only; never __arena_reset.
  const before = snapshot(r, [source, occupied, guard]);
  const outcome = invoke(() => call(r, source.pointer));
  const after = snapshot(r, [source, occupied, guard]);
  const output = outcome.pointer === undefined ? null : readString(r.memory, outcome.pointer);
  return { r, source, delta, start, before, after, outcome, output, observedRequests: requests(r) };
}
type StringObservation = Awaited<ReturnType<typeof observeString>>;
function stringEvidence(observation: StringObservation) {
  return {
    before: printable(observation.before),
    after: printable(observation.after),
    output: observation.output,
    requested: observation.observedRequests,
    error: errorRecord(observation.outcome.error),
  };
}
function assertString(observation: StringObservation, expected: string, guarded: boolean) {
  const { before, after, output, source, start, delta } = observation;
  expect(observation.outcome.error).toBeUndefined();
  expect(output).not.toBeNull();
  if (!output) throw new Error("missing string result");
  expect(output.malformed).toBeUndefined();
  expect(output).toMatchObject({
    header: 0,
    payloadSize: encoder.encode(expected).length + LINEAR_STRING_PAYLOAD_PREFIX_BYTES,
    length: encoder.encode(expected).length,
    bytes: Array.from(encoder.encode(expected)),
    text: expected,
  });
  expect(output.pointer).toBe(start);
  expect(output.pointer).not.toBe(source.pointer);
  expect(output.pointer % 8).toBe(0);
  expect(output.pointer + LINEAR_STRING_ELEMENTS_OFFSET + (output.length ?? 0)).toBeLessThanOrEqual(start + delta);
  expect(start + delta).toBeLessThanOrEqual(after.memoryBytes);
  expect(after.used - before.used).toBe(delta);
  expect(after.heap - before.heap).toBe(delta);
  expect(after.memoryBytes).toBe(65536);
  expect(after.regions).toEqual(before.regions);
  expect(after.bytes.slice(0, start)).toEqual(before.bytes.slice(0, start));
  expect(after.bytes.slice(start + LINEAR_STRING_ELEMENTS_OFFSET + encoder.encode(expected).length)).toEqual(
    before.bytes.slice(start + LINEAR_STRING_ELEMENTS_OFFSET + encoder.encode(expected).length),
  );
  if (guarded)
    expect(observation.observedRequests).toEqual({
      calls: 1,
      requestedBytes: LINEAR_STRING_ELEMENTS_OFFSET + encoder.encode(expected).length,
      guardTrips: 0,
    });
}

const runtimeCases: [string, number, number][] = [
  ...[
    [1, 4],
    [0, 6],
    [2, 2],
    [5, 2],
    [-2, 6],
    [1, -1],
    [-4, -1],
    [-20, 3],
    [2, 20],
    [20, 30],
    [0, -20],
    [-20, -10],
    [MIN, 6],
    [0, MAX],
    [MIN, MAX],
    [MAX, MIN],
    [MAX, MAX],
  ].map(([start, end]): [string, number, number] => ["abcdef", start, end]),
  ["", MIN, MAX],
];
describe("real __str_slice: guarded ASCII signed-i32 bounds", () => {
  it.each(runtimeCases)("%j slice(%s,%s)", async (text, start, end) =>
    row("runtime", `runtime:${JSON.stringify(text)}:${start}:${end}`, async (evidence) => {
      const expected = text.slice(start, end);
      const actual = await observeString(text, expected, true, (r, pointer) => r.slice(pointer, start, end));
      Object.assign(evidence, {
        phase: "semantic assertions",
        classification: actual.observedRequests.guardTrips
          ? "instrumentation-bounded-baseline-failure"
          : "runtime-semantics",
        text,
        start,
        end,
        expected,
        ...stringEvidence(actual),
      });
      if (start !== MIN && start !== MAX && end !== MIN && end !== MAX) {
        const plain = await observeString(text, expected, false, (r, pointer) => r.slice(pointer, start, end));
        transparentRows++;
        record("allocator-transparency", {
          id: `transparent:${start}:${end}`,
          guarded: stringEvidence(actual),
          unmodifiedAllocator: stringEvidence(plain),
          countedAsSemanticRow: false,
        });
        expect(plain.output).toEqual(actual.output);
        expect(errorRecord(plain.outcome.error)).toEqual(errorRecord(actual.outcome.error));
        expect(printable(plain.before)).toEqual(printable(actual.before));
        expect(printable(plain.after)).toEqual(printable(actual.after));
        expect(plain.after.bytes).toEqual(actual.after.bytes);
      }
      assertString(actual, expected, true);
    }),
  );
});

describe("allocator safety instrument: real body retained", () => {
  it.each([16, 65])("malloc(%s)", async (size) =>
    row("allocator-guard", `guard:${size}`, async (evidence) => {
      const r = await buildRuntime(true);
      new Uint8Array(r.memory.buffer, Number(r.heap.value), 80).fill(0xa5);
      resetObservations(r);
      const before = snapshot(r, []);
      const outcome = invoke(() => r.malloc(size));
      const after = snapshot(r, []);
      Object.assign(evidence, {
        phase: "guard assertions",
        classification: "allocator-instrument-control",
        size,
        before: printable(before),
        after: printable(after),
        requested: requests(r),
        pointer: outcome.pointer ?? null,
        error: errorRecord(outcome.error),
      });
      expect(requests(r)).toEqual({ calls: 1, requestedBytes: size, guardTrips: size === 65 ? 1 : 0 });
      if (size === 65) {
        expect(outcome.error).toBeInstanceOf(WebAssembly.RuntimeError);
        expect(printable(after)).toEqual(printable(before));
        expect(after.bytes).toEqual(before.bytes);
      } else {
        expect(outcome.error).toBeUndefined();
        expect(outcome.pointer).toBe(before.heap);
        expect(after.heap - before.heap).toBe(16);
        expect(after.used - before.used).toBe(16);
        expect(Array.from(after.bytes.slice(before.heap, before.heap + 4))).toEqual([0, 0, 0, 0]);
        expect(after.bytes.slice(0, before.heap)).toEqual(before.bytes.slice(0, before.heap));
        expect(after.bytes.slice(before.heap + 4)).toEqual(before.bytes.slice(before.heap + 4));
      }
    }),
  );
});

describe("unchanged runtime callers and byte ABI", () => {
  it.each([-1, 0, 5, 6, MIN, MAX])("charAt(%s)", async (index) =>
    row("charAt", `charAt:${index}`, async (evidence) => {
      const expected = "abcdef".charAt(index);
      const actual = await observeString("abcdef", expected, true, (r, pointer) => r.charAt(pointer, index));
      Object.assign(evidence, {
        phase: "caller assertions",
        classification: "unchanged-charAt-caller",
        index,
        expected,
        ...stringEvidence(actual),
      });
      assertString(actual, expected, true);
    }),
  );
  it("preserves UTF-8 byte interval [0,2) rather than claiming JS Unicode slicing", async () =>
    row("byte-ABI", "byte-ABI:éx:0:2", async (evidence) => {
      const actual = await observeString("éx", "é", true, (r, pointer) => r.slice(pointer, 0, 2));
      Object.assign(evidence, {
        phase: "byte ABI assertions",
        classification: "runtime-only-UTF8-byte-ABI",
        ...stringEvidence(actual),
      });
      assertString(actual, "é", true);
    }));
  it.each([
    ["a,b,c", ","],
    ["abc", "|"],
  ])("split(%j,%j)", async (text, separator) =>
    row("split", `split:${text}:${separator}`, async (evidence) => {
      // split legitimately requests a 144-byte array; no <=64 slice guard here.
      const r = await buildRuntime(false);
      const source = sourceRecord(r, text);
      const delimiter = sourceRecord(r, separator);
      const occupied = neighbor(r);
      const expected = text.split(separator);
      const delta =
        144 +
        expected.reduce((sum, item) => sum + align8(LINEAR_STRING_ELEMENTS_OFFSET + encoder.encode(item).length), 0);
      const start = Number(r.heap.value) >>> 0;
      new Uint8Array(r.memory.buffer, start, delta + 64).fill(0xa5);
      const guard = { name: "post-split-poison", pointer: start + delta, size: 64 };
      const before = snapshot(r, [source, delimiter, occupied, guard]);
      const outcome = invoke(() => r.split(source.pointer, delimiter.pointer));
      const after = snapshot(r, [source, delimiter, occupied, guard]);
      Object.assign(evidence, {
        phase: "split decoding",
        classification: "unmodified-allocator-split-control",
        text,
        separator,
        expected,
        before: printable(before),
        after: printable(after),
        error: errorRecord(outcome.error),
        pointer: outcome.pointer ?? null,
      });
      expect(outcome.error).toBeUndefined();
      if (outcome.pointer === undefined) throw new Error("missing split output");
      const pointer = outcome.pointer;
      expect(pointer + LINEAR_VECTOR_ELEMENTS_OFFSET).toBeLessThanOrEqual(r.memory.buffer.byteLength);
      const view = new DataView(r.memory.buffer);
      const length = view.getUint32(pointer + LINEAR_VECTOR_LENGTH_OFFSET, true);
      const capacity = view.getUint32(pointer + LINEAR_VECTOR_CAPACITY_OFFSET, true);
      Object.assign(evidence, { length, capacity, components: [] });
      if (length > 8 || pointer + LINEAR_VECTOR_ELEMENTS_OFFSET + length * 8 > r.memory.buffer.byteLength)
        throw new Error("refused oversized split host view");
      const components = Array.from({ length }, (_, index) =>
        readString(r.memory, view.getUint32(pointer + LINEAR_VECTOR_ELEMENTS_OFFSET + index * 8, true)),
      );
      evidence.components = components;
      evidence.phase = "split assertions";
      expect(pointer).toBe(start);
      expect(length).toBe(expected.length);
      expect(capacity).toBe(16);
      for (const [index, output] of components.entries()) {
        expect(output.malformed).toBeUndefined();
        expect(output).toMatchObject({
          header: 0,
          text: expected[index],
          bytes: Array.from(encoder.encode(expected[index])),
          length: encoder.encode(expected[index]).length,
          payloadSize: encoder.encode(expected[index]).length + LINEAR_STRING_PAYLOAD_PREFIX_BYTES,
        });
        expect(output.pointer).toBeGreaterThanOrEqual(start + 144);
        expect(output.pointer + LINEAR_STRING_ELEMENTS_OFFSET + (output.length ?? 0)).toBeLessThanOrEqual(
          start + delta,
        );
      }
      expect(after.used - before.used).toBe(delta);
      expect(after.heap - before.heap).toBe(delta);
      expect(after.memoryBytes).toBe(65536);
      expect(after.regions).toEqual(before.regions);
      expect(after.bytes.slice(0, start)).toEqual(before.bytes.slice(0, start));
      expect(after.bytes.slice(start + delta)).toEqual(before.bytes.slice(start + delta));
    }),
  );
});

const publicCases = [
  [-2, 6],
  [1, -1],
  [-4, -1],
  [-20, 3],
  [2, 20],
  [20, 30],
  [1, 4],
  [5, 2],
];
const originalSource = `export function run(start: number, end: number): number {
  return "abcdef".slice(start, end) === "ef" ? 1 : 0;
}`;
async function publicRow(mode: "overlay" | "direct", source: string, args: number[], evidence: Evidence) {
  vi.stubEnv("JS2WASM_LINEAR_IR", mode === "overlay" ? "1" : "0");
  const options = { target: "linear", optimize: false, emitWat: true } as const;
  Object.assign(evidence, {
    phase: "compilation",
    classification: "compilation/admission",
    source,
    args,
    options,
    flags: { JS2WASM_LINEAR_IR: process.env.JS2WASM_LINEAR_IR },
  });
  const emission = vi.spyOn(binaryEmitter, "emitBinary");
  const result = await compile(source, options);
  const report = getLastLinearIrReport();
  const mod = emission.mock.calls.at(-1)?.[0];
  const emitted = emission.mock.results.at(-1);
  const emittedSha256 = emitted?.type === "return" ? sha256(emitted.value) : null;
  emission.mockRestore();
  const wasmBytes = new Uint8Array(result.binary);
  Object.assign(evidence, {
    success: result.success,
    errors: result.errors,
    compiled: report?.compiled ?? null,
    rejected: report?.rejected ?? null,
    ownerEvidence: report?.ownerEvidence ?? null,
    binaryValidated: WebAssembly.validate(wasmBytes),
    binarySha256: sha256(result.binary),
    emittedSha256,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(evidence.binaryValidated).toBe(true);
  expect(emittedSha256).toBe(sha256(result.binary));
  const { instance } = await WebAssembly.instantiate(wasmBytes, result.importObject);
  const memory = instance.exports.memory as WebAssembly.Memory;
  const before = new Uint8Array(memory.buffer).slice();
  const outcome = invoke(() => (instance.exports.run as (...values: number[]) => number)(...args));
  const after = new Uint8Array(memory.buffer).slice();
  Object.assign(evidence, {
    phase: "admission and binding assertions",
    actual:
      outcome.pointer === undefined
        ? null
        : Number.isFinite(outcome.pointer)
          ? outcome.pointer
          : String(outcome.pointer),
    expected: 1,
    error: errorRecord(outcome.error),
    beforeMemoryBytes: before.length,
    afterMemoryBytes: after.length,
    beforeMemorySha256: sha256(before),
    afterMemorySha256: sha256(after),
  });
  if (mode === "overlay") {
    expect(report?.compiled).toContain("run");
    expect(report?.rejected.filter((item) => item.func === "run")).toEqual([]);
    if (!report || !mod) throw new Error("missing actual overlay report/emission");
    const owner = report.irModule.functions.find((func) => func.name === "run");
    if (!owner) throw new Error("missing admitted run owner");
    const instructions: IrInstr[] = [];
    for (const block of owner.blocks)
      for (const instruction of block.instrs)
        forEachInstrDeep(instruction, (nested) => {
          instructions.push(nested);
        });
    const calls = instructions.filter(
      (instruction) => instruction.kind === "call" && instruction.target.name === "__str_slice",
    );
    evidence.irSliceCalls = calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ target: { binding: { kind: "intrinsic", symbol: "__str_slice" } } });
    expect(report.ownerEvidence).toContainEqual({ outcome: "compiled", ownerUnitId: owner.unitId, legacyName: "run" });
    const body = report.funcs.get(owner.unitId);
    if (!body) throw new Error("missing actual overlay-lowered owner body");
    const imported = mod.imports.filter((item) => item.desc.kind === "func").length;
    const position = mod.functions.findIndex((func) => func.name === "__str_slice");
    const layout = resolveLayout(mod);
    const slot = report.legacySlots.find((entry) => entry.ownerUnitId === owner.unitId);
    const exported = mod.exports.find((entry) => entry.name === "run" && entry.desc.kind === "func");
    if (!slot || !exported) throw new Error("missing actual run owner/export association");
    const runIndex = layout.func(exported.desc.index);
    const emittedRun = mod.functions[runIndex - imported];
    evidence.actualOwnerExport = { slot, runIndex };
    expect(layout.func(slot.funcIdx)).toBe(runIndex);
    expect(emittedRun?.body).toEqual(body.body);
    const targets: number[] = [];
    walkInstructions(body.body, (instruction) => {
      if (instruction.op === "call") targets.push(layout.func(instruction.funcIdx));
    });
    Object.assign(evidence, {
      ownerUnitId: owner.unitId,
      emittedSliceIndex: imported + position,
      actualOwnerCallTargets: targets,
    });
    expect(position).toBeGreaterThanOrEqual(0);
    expect(targets.filter((index) => index === imported + position)).toHaveLength(1);
  }
  evidence.phase = "public result assertions";
  evidence.classification = "public-runtime-semantics";
  expect(outcome.error).toBeUndefined();
  expect(outcome.pointer).toBe(1);
}
describe("existing public overlay and direct routes", () => {
  for (const mode of ["overlay", "direct"] as const) {
    it.each(publicCases)(`${mode} slice(%s,%s)`, async (start, end) =>
      row(`public-${mode}`, `public:${mode}:${start}:${end}`, async (evidence) => {
        const expected = "abcdef".slice(start, end);
        const source =
          start === -2 && end === 6
            ? originalSource
            : `export function run(start: number, end: number): number {
  return "abcdef".slice(start, end) === ${JSON.stringify(expected)} ? 1 : 0;
}`;
        await publicRow(mode, source, [start, end], evidence);
      }),
    );
    it(`${mode} omitted end`, async () =>
      row(`omitted-${mode}`, `omitted:${mode}`, async (evidence) => {
        await publicRow(
          mode,
          `export function run(): number {
  return "abcdef".slice(-2) === "ef" ? 1 : 0;
}`,
          [],
          evidence,
        );
      }));
  }
});
