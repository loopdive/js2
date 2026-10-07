// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as linearCodegen from "../src/codegen-linear/index.js";
import * as runtime from "../src/codegen-linear/runtime.js";
import { walkInstructions } from "../src/codegen/walk-instructions.js";
import { emitBinary } from "../src/emit/binary.js";
import { resolveLayout } from "../src/emit/resolve-layout.js";
import { compile } from "../src/index.js";
import { getLastLinearIrReport, type LinearIrResult } from "../src/ir/backend/linear-integration.js";
import { assertFrozenIrBodyBatch, type FrozenIrBodyBatch } from "../src/ir/frozen-body-batch.js";
import { forEachInstrDeep, type IrFunction, type IrInstr } from "../src/ir/nodes.js";
import {
  LINEAR_STRING_ELEMENTS_OFFSET as DATA,
  LINEAR_STRING_LENGTH_OFFSET as LENGTH,
  LINEAR_STRING_PAYLOAD_SIZE_OFFSET as SIZE,
  LINEAR_STRING_PAYLOAD_PREFIX_BYTES as PREFIX,
} from "../src/ir/analysis/linear-memory-plan.js";
import { createEmptyModule, type Instr, type WasmFunction, type WasmModule } from "../src/ir/types.js";

type Consumption = {
  batch: FrozenIrBodyBatch;
  backend: string;
  moduleSession: object | undefined;
  completed: boolean;
  outputs: { ownerUnitId: string; func: IrFunction; body: unknown }[];
  failure?: unknown;
};
const captures = vi.hoisted(() => ({
  modules: [] as WasmModule[],
  consumers: [] as Consumption[],
  restorers: [] as (() => void)[],
}));
// Transparent observation, not an alternate implementation or lowering adapter.
vi.mock("../src/codegen-linear/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/codegen-linear/runtime.js")>();
  const original = actual.addLinearIrStringRuntime;
  const spy = vi.spyOn(actual, "addLinearIrStringRuntime").mockImplementation(function (this: unknown, ...args) {
    captures.modules.push(args[0]);
    return Reflect.apply(original, this, args);
  });
  captures.restorers.push(() => spy.mockRestore());
  return { ...actual, addLinearIrStringRuntime: spy };
});
vi.mock("../src/ir/backend/frozen-body-consumer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/backend/frozen-body-consumer.js")>();
  const original = actual.consumeFrozenIrBodyBatchWithFactories;
  const spy = vi.spyOn(actual, "consumeFrozenIrBodyBatchWithFactories").mockImplementation(function <B, V>(
    this: unknown,
    ...args: Parameters<typeof original<B, V>>
  ) {
    const input = args[0];
    const receipt: Consumption = {
      batch: input.batch,
      backend: input.backend,
      moduleSession: input.factories.moduleSession,
      completed: false,
      outputs: [],
    };
    captures.consumers.push(receipt);
    try {
      const result: ReturnType<typeof original<B, V>> = Reflect.apply(original<B, V>, this, args);
      receipt.outputs = result.map((output) => ({
        ownerUnitId: output.ownerUnitId,
        func: output.func,
        body: output.lowered.body,
      }));
      receipt.completed = true;
      return result;
    } catch (error) {
      receipt.failure = error;
      throw error;
    }
  });
  captures.restorers.push(() => spy.mockRestore());
  return { ...actual, consumeFrozenIrBodyBatchWithFactories: spy };
});

const TEST_PATH = "tests/issue-6915-linear-owned-ascii-append-copy-kernel.test.ts";
const SOURCE_PATH = "website/public/benchmarks/competitive/programs/string-hash.js";
const FIXTURE_SHA = "66a15148fdd960dcbe5d87c25a28d870e8db9d00865483d708f0ca4e6e6e335c";
const BASELINE = "c41bca2bc07e9d8fddbb38ca77904dd1f0cac438";
const OPTIONS = { target: "linear", allocator: "bump", fileName: SOURCE_PATH } as const;
const APPEND = runtime.LINEAR_IR_STRING_APPEND_ASCII_FN;
const numbered = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(2, "0")}`);
const IDS = [
  ...numbered("Runtime", 22),
  ...numbered("Source", 4),
  ...numbered("Import", 2),
  ...numbered("Negative", 8),
];
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const align8 = (size: number) => Math.ceil(size / 8) * 8;
const observed: string[] = [];
const failures: string[] = [];

type Artifact = { binaryBase64: string; sha256: string; byteLength: number; valid: boolean };
type MemoryState = { memoryBase64: string; byteLength: number; heap: number };
type Carrier = { pointer: number; header: number[]; capacity: number; length: number; payload: number[] };
type Construction = {
  kind: "C" | "S";
  bytes: number[];
  rawPointer: number;
  pointer: number;
  seedEmptyPointer: number | null;
};
type Transition = {
  before: MemoryState;
  after: MemoryState;
  left: Carrier;
  right: Carrier;
  result: Carrier;
  heapDelta: number;
  inferredAllocations: number;
  allocationCountAuthority: "installed-single-growth-malloc-call";
};
type Binding = { index: number; imports: number; helper: WasmFunction; mallocIndex: number };
type RuntimeProof = {
  kind: "runtime";
  module: WasmModule;
  artifact: Artifact;
  binding: Binding;
  construction: Construction[];
  transitions: Transition[];
  hostCalls: { unrelated: number; namesake: number };
  imported: boolean;
};
type SourceProof = {
  kind: "source";
  source: string;
  sourceSha256: string;
  options: typeof OPTIONS;
  input: number;
  expected: number;
  native: number;
  actual: number;
  module: WasmModule;
  artifact: Artifact;
  binding: Binding;
  // Detached projection excludes unrelated preparation plans containing cyclic ASTs.
  // The batch/module/function references remain the actual compiler-owned objects.
  report: Pick<LinearIrResult, "compiled" | "rejected" | "ownerEvidence" | "irModule" | "frozenBodyBatch" | "funcs">;
  receipt: Consumption;
  registrationModules: WasmModule[];
  logical: IrFunction;
  physical: WasmFunction;
  ownerUnitId: string;
  callIndices: number[];
  appendExecutionAuthority: "physical-call-binding-not-dynamic-counter";
};
type Positive = RuntimeProof | SourceProof;
type SourceProgress = {
  stage: "source";
  input: number;
  expected: number;
  sourceSha256: string;
  compile?: { success: boolean; errors: unknown };
  artifact?: Artifact;
  report?: {
    compiled: readonly string[];
    rejected: LinearIrResult["rejected"];
    ownerEvidence: LinearIrResult["ownerEvidence"];
  };
  consumers?: {
    digest: string;
    completed: boolean;
    backend: string;
    owners: FrozenIrBodyBatch["owners"];
    failure: string | null;
  }[];
};
type RuntimeProgress = {
  stage: "runtime";
  artifact?: Artifact;
  construction: Construction[];
  transitions: Transition[];
};
type NegativeProof = {
  stage: "negative";
  mutation: string;
  original: Positive;
  corrupted: Positive;
  rejected: boolean;
  rejection: string | null;
};
type Progress = { stage: "setup" } | SourceProgress | RuntimeProgress | Positive | NegativeProof;
type Journal = { evidence: Progress };
type RecordRow =
  | {
      kind: "provenance";
      schema: "6915-append-baseline-v1";
      issue: 6915;
      head: string;
      sourceTree: string;
      baseline: string;
      baselineSourceTree: string;
      sourceDirty: string;
      testSha256: string;
      fixtureSha256: string;
      productionHashes: { runtime: string; consumer: string; integration: string };
      options: typeof OPTIONS;
      node: string;
      v8: string;
      execArgv: string[];
      argv: string[];
      nodeOptions: string | null;
      linearIrFlag: string | null;
      command: string | null;
      ids: string[];
      expectedObservations: 36;
    }
  | { kind: "observation"; id: string; passed: boolean; evidence: Progress; failure: string | null }
  | {
      kind: "completion";
      ids: string[];
      duplicates: string[];
      missing: string[];
      unexpected: string[];
      failures: string[];
      expectedObservations: 36;
    };

function emit(row: RecordRow): void {
  console.log(
    JSON.stringify(row, (_key, value: unknown) => {
      if (value instanceof Map) return [...value.entries()];
      if (value instanceof Set) return [...value];
      if (value instanceof Uint8Array) return [...value];
      if (value instanceof Error) return { name: value.name, message: value.message };
      return value;
    }),
  );
}
async function observation(id: string, action: (journal: Journal) => Promise<void>): Promise<void> {
  const journal: Journal = { evidence: { stage: "setup" } };
  let passed = false;
  let failure: unknown;
  try {
    await action(journal);
    passed = true;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    observed.push(id);
    if (!passed) failures.push(id);
    emit({ kind: "observation", id, passed, evidence: journal.evidence, failure: passed ? null : String(failure) });
    expect(IDS).toContain(id);
    expect(observed.filter((entry) => entry === id)).toHaveLength(1);
  }
}
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
beforeAll(() => {
  const provenance: Extract<RecordRow, { kind: "provenance" }> = {
    kind: "provenance",
    schema: "6915-append-baseline-v1",
    issue: 6915,
    head: git("rev-parse", "HEAD"),
    sourceTree: git("rev-parse", "HEAD:src"),
    baseline: BASELINE,
    baselineSourceTree: "68296a0d34ceea94dbc9ca9398f71bc8a1b742b8",
    sourceDirty: git("status", "--porcelain", "--", "src"),
    testSha256: sha256(readFileSync(TEST_PATH)),
    fixtureSha256: sha256(readFileSync(SOURCE_PATH)),
    productionHashes: {
      runtime: sha256(readFileSync("src/codegen-linear/runtime.ts")),
      consumer: sha256(readFileSync("src/ir/backend/frozen-body-consumer.ts")),
      integration: sha256(readFileSync("src/ir/backend/linear-integration.ts")),
    },
    options: OPTIONS,
    node: process.version,
    v8: process.versions.v8,
    execArgv: process.execArgv,
    argv: process.argv,
    nodeOptions: process.env.NODE_OPTIONS ?? null,
    linearIrFlag: process.env.JS2WASM_LINEAR_IR ?? null,
    command: process.env.JS2WASM_APPEND_TEST_COMMAND ?? null,
    ids: IDS,
    expectedObservations: 36,
  };
  emit(provenance);
  expect(provenance.fixtureSha256).toBe(FIXTURE_SHA);
  expect(provenance.sourceDirty).toBe("");
  expect(provenance.testSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(IDS).toHaveLength(36);
  expect(new Set(IDS).size).toBe(36);
});
afterEach(() => {
  captures.modules.length = 0;
  captures.consumers.length = 0;
  vi.unstubAllEnvs();
});
afterAll(() => {
  for (const restore of captures.restorers.reverse()) restore();
  const duplicates = observed.filter((id, i) => observed.indexOf(id) !== i);
  const missing = IDS.filter((id) => !observed.includes(id));
  const unexpected = observed.filter((id) => !IDS.includes(id));
  emit({ kind: "completion", ids: observed, duplicates, missing, unexpected, failures, expectedObservations: 36 });
  expect(duplicates).toEqual([]);
  expect(missing).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(observed).toHaveLength(36);
});

function artifact(binary: Uint8Array): Artifact {
  return {
    binaryBase64: base64(binary),
    sha256: sha256(binary),
    byteLength: binary.byteLength,
    valid: WebAssembly.validate(new Uint8Array(binary)),
  };
}
function validateArtifact(value: Artifact): void {
  const bytes = new Uint8Array(Buffer.from(value.binaryBase64, "base64"));
  expect(bytes.byteLength).toBeGreaterThan(0);
  expect(value.byteLength).toBe(bytes.byteLength);
  expect(value.sha256).toBe(sha256(bytes));
  expect(value.valid).toBe(true);
  expect(WebAssembly.validate(bytes)).toBe(true);
}
function defined(module: WasmModule, name: string): Binding {
  const position = module.functions.findIndex((fn) => fn.name === name);
  const helper = module.functions[position];
  if (!helper) throw new Error(`missing defined ${name}`);
  const imports = module.imports.filter((entry) => entry.desc.kind === "func").length;
  const mallocPosition = module.functions.findIndex((fn) => fn.name === "__malloc");
  if (mallocPosition < 0) throw new Error("missing real allocator");
  return { helper, imports, index: imports + position, mallocIndex: imports + mallocPosition };
}
function calls(body: Instr[]): Extract<Instr, { op: "call" }>[] {
  const result: Extract<Instr, { op: "call" }>[] = [];
  walkInstructions(body, (instruction) => {
    if (instruction.op === "call") result.push(instruction);
  });
  return result;
}
function validateBinding(module: WasmModule, binding: Binding): void {
  const actual = defined(module, APPEND);
  expect(binding.index).toBe(actual.index);
  expect(binding.imports).toBe(actual.imports);
  expect(binding.helper).toBe(actual.helper);
  expect(binding.mallocIndex).toBe(actual.mallocIndex);
  const signature = module.types[binding.helper.typeIdx];
  if (!signature || signature.kind !== "func") throw new Error("append helper signature is not a function");
  expect(signature.params).toEqual([{ kind: "i32" }, { kind: "i32" }]);
  expect(signature.results).toEqual([{ kind: "i32" }]);
  expect(binding.helper.locals).toHaveLength(7);
  const layout = resolveLayout(module);
  const mallocCalls = calls(binding.helper.body).filter((entry) => layout.func(entry.funcIdx) === binding.mallocIndex);
  expect(mallocCalls).toHaveLength(1);
  const growth = binding.helper.body.find((entry) => entry.op === "if");
  if (!growth || growth.op !== "if") throw new Error("missing structural growth branch");
  expect(calls(growth.then).filter((entry) => layout.func(entry.funcIdx) === binding.mallocIndex)).toHaveLength(1);
  expect(calls(growth.else ?? []).filter((entry) => layout.func(entry.funcIdx) === binding.mallocIndex)).toHaveLength(
    0,
  );
}
function call(exports: WebAssembly.Exports, name: string, ...args: number[]): number {
  const fn = exports[name];
  if (typeof fn !== "function") throw new Error(`missing callable export ${name}`);
  const value: unknown = fn(...args);
  if (typeof value !== "number") throw new Error(`${name} did not return a number`);
  return value;
}
function bounds(bytes: Uint8Array, pointer: number, length: number): void {
  expect(Number.isSafeInteger(pointer)).toBe(true);
  expect(Number.isSafeInteger(length)).toBe(true);
  expect(pointer).toBeGreaterThanOrEqual(0);
  expect(length).toBeGreaterThanOrEqual(0);
  expect(pointer + length).toBeLessThanOrEqual(bytes.byteLength);
}
function carrier(bytes: Uint8Array, pointer: number): Carrier {
  bounds(bytes, pointer, DATA);
  expect(pointer % 8).toBe(0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const capacity = view.getUint32(pointer + SIZE, true) - PREFIX;
  const length = view.getUint32(pointer + LENGTH, true);
  expect(length).toBeLessThanOrEqual(capacity);
  bounds(bytes, pointer + DATA, capacity);
  return {
    pointer,
    header: [...bytes.slice(pointer, pointer + DATA)],
    capacity,
    length,
    payload: [...bytes.slice(pointer + DATA, pointer + DATA + length)],
  };
}
function validateTransition(step: Transition): void {
  const before = new Uint8Array(Buffer.from(step.before.memoryBase64, "base64"));
  const after = new Uint8Array(Buffer.from(step.after.memoryBase64, "base64"));
  expect(before.byteLength).toBe(step.before.byteLength);
  expect(after.byteLength).toBe(step.after.byteLength);
  expect(step.left).toEqual(carrier(before, step.left.pointer));
  expect(step.right).toEqual(carrier(before, step.right.pointer));
  expect(step.result).toEqual(carrier(after, step.result.pointer));
  const payload = [...step.left.payload, ...step.right.payload];
  const growing = payload.length > step.left.capacity;
  const capacity = growing ? Math.max(2 * step.left.capacity, 16, payload.length) : step.left.capacity;
  const pointer = growing ? step.before.heap : step.left.pointer;
  const usage = growing ? align8(DATA + capacity) : 0;
  expect(step.result.pointer).toBe(pointer);
  expect(step.result.capacity).toBe(capacity);
  expect(step.result.length).toBe(payload.length);
  expect(step.result.payload).toEqual(payload);
  expect(step.heapDelta).toBe(usage);
  expect(step.after.heap - step.before.heap).toBe(usage);
  expect(step.inferredAllocations).toBe(growing ? 1 : 0);
  expect(step.allocationCountAuthority).toBe("installed-single-growth-malloc-call");
  expect(after.byteLength).toBe(Math.max(before.byteLength, Math.ceil(step.after.heap / 65536) * 65536));
  const expected = new Uint8Array(after.byteLength);
  expected.set(before);
  bounds(expected, pointer, DATA + capacity);
  const view = new DataView(expected.buffer);
  if (growing) {
    view.setUint32(pointer, 0, true); // Oracle only: real allocator cleared the actual fresh header.
    view.setUint32(pointer + SIZE, capacity + PREFIX, true);
  }
  view.setUint32(pointer + LENGTH, payload.length, true);
  expected.set(payload, pointer + DATA);
  // Includes padding, spare capacity, old allocations, cache bits, RHS and every untouched byte.
  expect(step.after.memoryBase64).toBe(base64(expected));
}
function validatePositive(proof: Positive): void {
  validateArtifact(proof.artifact);
  validateBinding(proof.module, proof.binding);
  if (proof.kind === "runtime") {
    expect(typeof proof.imported).toBe("boolean");
    expect(proof.construction.length).toBeGreaterThanOrEqual(2);
    expect(proof.transitions.length).toBeGreaterThan(0);
    for (const step of proof.transitions) validateTransition(step);
    expect(proof.hostCalls).toEqual({ unrelated: 0, namesake: 0 });
    expect(proof.binding.imports).toBe(proof.imported ? 2 : 0);
    if (proof.imported) {
      expect(proof.module.imports.map((entry) => ({ name: entry.name, kind: entry.desc.kind }))).toEqual([
        { name: "unused", kind: "func" },
        { name: "table", kind: "table" },
        { name: APPEND, kind: "func" },
      ]);
    }
  } else validateSource(proof);
}
function validateSource(proof: SourceProof): void {
  expect(
    [proof.input, proof.expected, proof.native, proof.actual].every(
      (value) => typeof value === "number" && Number.isFinite(value),
    ),
  ).toBe(true);
  expect([
    [0, 0],
    [1, 96500],
    [100, 36729899],
    [20000, 862771296],
  ]).toContainEqual([proof.input, proof.expected]);
  expect(proof.appendExecutionAuthority).toBe("physical-call-binding-not-dynamic-counter");
  expect(proof.sourceSha256).toBe(FIXTURE_SHA);
  expect(sha256(proof.source)).toBe(FIXTURE_SHA);
  expect(proof.options).toEqual(OPTIONS);
  expect(proof.native).toBe(proof.expected);
  expect(proof.actual).toBe(proof.expected);
  expect(proof.registrationModules).toContain(proof.module);
  assertFrozenIrBodyBatch(proof.receipt.batch);
  expect(proof.report.frozenBodyBatch).toBe(proof.receipt.batch);
  expect(proof.report.irModule).toBe(proof.receipt.batch.module);
  expect(proof.receipt.moduleSession).toBe(proof.module);
  expect(proof.receipt.backend).toBe("linear");
  expect(proof.receipt.completed).toBe(true);
  expect(proof.receipt.failure).toBeUndefined();
  expect(proof.report.compiled).toEqual(["run"]);
  expect(proof.report.rejected).toEqual([]);
  expect(proof.logical.name).toBe("run");
  expect(proof.logical.unitId).toBe(proof.ownerUnitId);
  expect(proof.receipt.batch.module.functions).toContain(proof.logical);
  expect(proof.receipt.batch.owners).toContainEqual(
    expect.objectContaining({ ownerUnitId: proof.ownerUnitId, legacyName: "run", outcome: "built" }),
  );
  const output = proof.receipt.outputs.find((entry) => entry.ownerUnitId === proof.ownerUnitId);
  if (!output) throw new Error("missing actual completed run owner output");
  expect(output.func).toBe(proof.logical);
  expect(proof.report.ownerEvidence).toContainEqual({
    outcome: "compiled",
    ownerUnitId: proof.logical.unitId,
    legacyName: "run",
  });
  expect(proof.report.funcs.get(proof.logical.unitId)).toBe(proof.physical);
  expect(proof.module.functions).toContain(proof.physical);
  expect(proof.physical.body).toBe(output.body);
  const instructions: IrInstr[] = [];
  for (const block of proof.logical.blocks)
    for (const instr of block.instrs)
      forEachInstrDeep(instr, (nested) => {
        instructions.push(nested);
      });
  const concats = instructions.filter((instr) => instr.kind === "string.concat");
  expect(concats).toHaveLength(3);
  expect(concats.every((instr) => instr.concatMode === "owned-append" && instr.encodingEvidence === "ascii")).toBe(
    true,
  );
  const layout = resolveLayout(proof.module);
  const indices = calls(proof.physical.body).map((entry) => layout.func(entry.funcIdx));
  expect(proof.callIndices).toEqual(indices);
  expect(indices.filter((index) => index === proof.binding.index).length).toBeGreaterThan(0);
  expect(proof.module.functions[proof.binding.index - proof.binding.imports]).toBe(proof.binding.helper);
}

type RuntimeInstance = {
  module: WasmModule;
  artifact: Artifact;
  binding: Binding;
  exports: WebAssembly.Exports;
  memory: WebAssembly.Memory;
  heap: WebAssembly.Global;
  construction: Construction[];
  hostCalls: { unrelated: number; namesake: number };
  imported: boolean;
};
async function runtimeInstance(imported = false, progress?: RuntimeProgress): Promise<RuntimeInstance> {
  const module = createEmptyModule();
  if (imported) {
    module.types.push(
      { kind: "func", params: [], results: [] },
      { kind: "func", params: [{ kind: "i32" }, { kind: "i32" }], results: [{ kind: "i32" }] },
    );
    module.imports.push(
      { module: "probe", name: "unused", desc: { kind: "func", typeIdx: 0 } },
      { module: "probe", name: "table", desc: { kind: "table", elementType: "funcref", min: 1 } },
      { module: "probe", name: APPEND, desc: { kind: "func", typeIdx: 1 } },
    );
  }
  runtime.addRuntime(module);
  // Real string builder dependencies, in the production registration order.
  runtime.addUint8ArrayRuntime(module);
  runtime.addArrayRuntime(module);
  runtime.addStringRuntime(module);
  runtime.addLinearIrStringRuntime(module);
  for (const name of ["__malloc", "__str_from_data", "__str_is_ascii", APPEND]) {
    module.exports.push({ name, desc: { kind: "func", index: defined(module, name).index } });
  }
  const heapIndex = module.globals.findIndex((entry) => entry.name === "__heap_ptr");
  if (heapIndex < 0) throw new Error("missing actual allocator usage global");
  module.exports.push({ name: "heap", desc: { kind: "global", index: heapIndex } });
  const binary = emitBinary(module);
  const witness = artifact(binary);
  if (progress) progress.artifact = witness;
  validateArtifact(witness);
  const hostCalls = { unrelated: 0, namesake: 0 };
  const imports: WebAssembly.Imports = imported
    ? {
        probe: {
          unused: () => {
            hostCalls.unrelated++;
            throw new Error("wrong unrelated import called");
          },
          [APPEND]: () => {
            hostCalls.namesake++;
            throw new Error("wrong append namesake called");
          },
          table: new WebAssembly.Table({ element: "anyfunc", initial: 1 }),
        },
      }
    : {};
  const { instance } = await WebAssembly.instantiate(new Uint8Array(binary), imports);
  const memory = instance.exports.memory;
  const heap = instance.exports.heap;
  if (!(memory instanceof WebAssembly.Memory) || !(heap instanceof WebAssembly.Global))
    throw new Error("missing real runtime memory/heap exports");
  return {
    module,
    artifact: witness,
    binding: defined(module, APPEND),
    exports: instance.exports,
    memory,
    heap,
    construction: [],
    hostCalls,
    imported,
  };
}
function state(instance: RuntimeInstance): MemoryState {
  const heap: unknown = instance.heap.value;
  if (typeof heap !== "number" || !Number.isSafeInteger(heap) || heap < 0) throw new Error("invalid actual heap value");
  const bytes = new Uint8Array(instance.memory.buffer);
  bounds(bytes, heap, 0);
  return { heap, byteLength: bytes.byteLength, memoryBase64: base64(bytes) };
}
function construct(instance: RuntimeInstance, kind: "C" | "S", text: string): number {
  const bytes = new TextEncoder().encode(text);
  expect([...bytes].every((byte) => byte < 128)).toBe(true);
  const rawPointer = call(instance.exports, "__malloc", bytes.length);
  const memory = new Uint8Array(instance.memory.buffer);
  bounds(memory, rawPointer, bytes.length);
  expect(rawPointer % 8).toBe(0);
  memory.set(bytes, rawPointer); // Only raw input bytes: no record/header fabrication.
  const canonical = call(instance.exports, "__str_from_data", rawPointer, bytes.length);
  const initial = carrier(new Uint8Array(instance.memory.buffer), canonical);
  expect(initial.capacity).toBe(bytes.length);
  expect(initial.payload).toEqual([...bytes]);
  expect(initial.header.slice(0, 4)).toEqual([0, 0, 0, 0]);
  let pointer = canonical;
  let seedEmptyPointer: number | null = null;
  if (kind === "S") {
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.length).toBeLessThanOrEqual(16);
    seedEmptyPointer = construct(instance, "C", "");
    pointer = call(instance.exports, APPEND, seedEmptyPointer, canonical);
    expect(carrier(new Uint8Array(instance.memory.buffer), pointer).capacity).toBe(16);
  }
  instance.construction.push({ kind, bytes: [...bytes], rawPointer, pointer, seedEmptyPointer });
  return pointer;
}
function transition(instance: RuntimeInstance, leftPointer: number, rightPointer: number, steps: Transition[]): number {
  const before = state(instance);
  const beforeBytes = new Uint8Array(Buffer.from(before.memoryBase64, "base64"));
  const left = carrier(beforeBytes, leftPointer);
  const right = carrier(beforeBytes, rightPointer);
  const resultPointer = call(instance.exports, APPEND, leftPointer, rightPointer);
  const after = state(instance);
  const result = carrier(new Uint8Array(instance.memory.buffer), resultPointer);
  const step: Transition = {
    before,
    after,
    left,
    right,
    result,
    heapDelta: after.heap - before.heap,
    inferredAllocations: left.length + right.length > left.capacity ? 1 : 0,
    allocationCountAuthority: "installed-single-growth-malloc-call",
  };
  steps.push(step); // Retain the actual failed witness before any oracle assertion.
  validateTransition(step);
  return resultPointer;
}
const pattern = (length: number, start: number) =>
  Array.from({ length }, (_, i) => String.fromCharCode(start + (i % 13))).join("");
type RuntimeCase = {
  id: string;
  label: string;
  leftKind: "C" | "S";
  left: string;
  right: string;
  self?: boolean;
  cached?: boolean;
};
const RUNTIME_CASES: RuntimeCase[] = [
  { id: "Runtime01", label: "empty + empty", leftKind: "C", left: "", right: "" },
  { id: "Runtime02", label: "empty + one", leftKind: "C", left: "", right: "q" },
  { id: "Runtime03", label: "empty + seventeen", leftKind: "C", left: "", right: pattern(17, 97) },
  { id: "Runtime04", label: "canonical nonempty + empty", leftKind: "C", left: "ABC", right: "" },
  ...([3, 3, 3, 3, 6, 7, 8, 14, 15, 15] as const).map(
    (length, index): RuntimeCase => ({
      id: `Runtime${String(index + 5).padStart(2, "0")}`,
      label: `boundary ${length}+${index === 2 || index === 3 ? 4 : index === 9 ? 2 : 1}`,
      leftKind: index === 1 || index === 3 ? "C" : "S",
      left: pattern(length, 65),
      right: pattern(index === 2 || index === 3 ? 4 : index === 9 ? 2 : 1, 97),
    }),
  ),
  { id: "Runtime15", label: "self with spare capacity", leftKind: "S", left: "ABCD", right: "ABCD", self: true },
  { id: "Runtime16", label: "self with growth", leftKind: "C", left: "ABCDEFGHI", right: "ABCDEFGHI", self: true },
  { id: "Runtime17", label: "distinct equal content", leftKind: "S", left: "ABCD", right: "ABCD" },
  { id: "Runtime18", label: "ASCII NUL", leftKind: "S", left: "A\0", right: "\0B" },
  { id: "Runtime19", label: "bounded long payload", leftKind: "C", left: pattern(4096, 65), right: pattern(4097, 97) },
  { id: "Runtime20", label: "cached no growth", leftKind: "S", left: "ABCD", right: "q", cached: true },
  { id: "Runtime21", label: "cached growth", leftKind: "C", left: "ABCD", right: "q", cached: true },
];
async function runtimeCase(entry: RuntimeCase, journal: Journal, imported = false): Promise<RuntimeProof> {
  const progress: RuntimeProgress = { stage: "runtime", construction: [], transitions: [] };
  journal.evidence = progress;
  const instance = await runtimeInstance(imported, progress);
  progress.artifact = instance.artifact;
  progress.construction = instance.construction;
  const left = construct(instance, entry.leftKind, entry.left);
  const right = entry.self ? left : construct(instance, "C", entry.right);
  if (!entry.self) expect(right).not.toBe(left);
  if (entry.cached) {
    expect(call(instance.exports, "__str_is_ascii", left)).toBe(1);
    expect(carrier(new Uint8Array(instance.memory.buffer), left).header[1]).toBe(1);
  }
  transition(instance, left, right, progress.transitions);
  const proof: RuntimeProof = {
    kind: "runtime",
    module: instance.module,
    artifact: instance.artifact,
    binding: instance.binding,
    construction: instance.construction,
    transitions: progress.transitions,
    hostCalls: instance.hostCalls,
    imported,
  };
  journal.evidence = proof;
  validatePositive(proof);
  return proof;
}

async function sourceCase(input: number, expected: number, journal: Journal): Promise<SourceProof> {
  const source = readFileSync(SOURCE_PATH, "utf8");
  const progress: SourceProgress = { stage: "source", input, expected, sourceSha256: sha256(source) };
  journal.evidence = progress;
  const hadFlag = Object.hasOwn(process.env, "JS2WASM_LINEAR_IR");
  const oldFlag = process.env.JS2WASM_LINEAR_IR;
  const generate = vi.spyOn(linearCodegen, "generateLinearModule");
  try {
    expect(sha256(source)).toBe(FIXTURE_SHA);
    const nativeModule: unknown = await import(pathToFileURL(`${process.cwd()}/${SOURCE_PATH}`).href);
    if (
      !nativeModule ||
      typeof nativeModule !== "object" ||
      !("run" in nativeModule) ||
      typeof nativeModule.run !== "function"
    )
      throw new Error("unchanged native fixture run absent");
    const native: unknown = nativeModule.run(input);
    if (typeof native !== "number") throw new Error("native fixture returned non-number");
    expect(native).toBe(expected);
    vi.stubEnv("JS2WASM_LINEAR_IR", "1");
    const result = await compile(source, OPTIONS);
    progress.compile = { success: result.success, errors: result.errors };
    progress.artifact = artifact(result.binary);
    const report = getLastLinearIrReport();
    if (report)
      progress.report = { compiled: report.compiled, rejected: report.rejected, ownerEvidence: report.ownerEvidence };
    progress.consumers = captures.consumers.map((entry) => ({
      digest: entry.batch.digest,
      completed: entry.completed,
      backend: entry.backend,
      owners: entry.batch.owners,
      failure: entry.failure === undefined ? null : String(entry.failure),
    }));
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(generate).toHaveBeenCalledOnce();
    const generated = generate.mock.results[0];
    if (!generated || generated.type !== "return") throw new Error("missing real generator return");
    const module = generated.value;
    if (!report) throw new Error("missing actual compiler report");
    const receipt = captures.consumers.find(
      (entry) => entry.batch === report.frozenBodyBatch && entry.moduleSession === module,
    );
    if (!receipt) throw new Error("no exact current frozen batch/module consumer join");
    const logical = report.irModule.functions.find((entry) => entry.name === "run");
    if (!logical) throw new Error("unchanged run was not IR-admitted");
    const physical = report.funcs.get(logical.unitId);
    if (!physical) throw new Error("missing actual owned run body");
    validateArtifact(progress.artifact);
    const { instance } = await WebAssembly.instantiate(new Uint8Array(result.binary), result.importObject ?? {});
    const layout = resolveLayout(module);
    const proof: SourceProof = {
      kind: "source",
      source,
      sourceSha256: sha256(source),
      options: OPTIONS,
      input,
      expected,
      native,
      actual: call(instance.exports, "run", input),
      module,
      artifact: progress.artifact,
      binding: defined(module, APPEND),
      report: {
        compiled: report.compiled,
        rejected: report.rejected,
        ownerEvidence: report.ownerEvidence,
        irModule: report.irModule,
        frozenBodyBatch: report.frozenBodyBatch,
        funcs: report.funcs,
      },
      receipt,
      registrationModules: [...captures.modules],
      logical,
      physical,
      ownerUnitId: logical.unitId,
      callIndices: calls(physical.body).map((entry) => layout.func(entry.funcIdx)),
      appendExecutionAuthority: "physical-call-binding-not-dynamic-counter",
    };
    journal.evidence = proof;
    validatePositive(proof);
    return proof;
  } finally {
    generate.mockRestore();
    vi.unstubAllEnvs();
    expect(Object.hasOwn(process.env, "JS2WASM_LINEAR_IR")).toBe(hadFlag);
    expect(process.env.JS2WASM_LINEAR_IR).toBe(oldFlag);
  }
}

describe("#6915 independently owned append baseline", () => {
  for (const entry of RUNTIME_CASES)
    it(`${entry.id}: ${entry.label}`, () =>
      observation(entry.id, async (journal) => {
        await runtimeCase(entry, journal);
      }));
  it("Runtime22: all 33 one-byte repeated-growth transitions", () =>
    observation("Runtime22", async (journal) => {
      const instance = await runtimeInstance();
      const proof: RuntimeProof = {
        kind: "runtime",
        module: instance.module,
        artifact: instance.artifact,
        binding: instance.binding,
        construction: instance.construction,
        transitions: [],
        hostCalls: instance.hostCalls,
        imported: false,
      };
      journal.evidence = proof;
      let left = construct(instance, "C", "");
      const right = construct(instance, "C", "q");
      for (let i = 0; i < 33; i++) left = transition(instance, left, right, proof.transitions);
      expect(proof.transitions).toHaveLength(33);
      expect(proof.transitions.map((step) => step.result.length)).toEqual(Array.from({ length: 33 }, (_, i) => i + 1));
      expect(proof.transitions.map((step) => step.result.capacity)).toEqual([
        ...Array<number>(16).fill(16),
        ...Array<number>(16).fill(32),
        64,
      ]);
      validatePositive(proof);
    }));
  for (const [i, input, expected] of [
    [1, 0, 0],
    [2, 1, 96500],
    [3, 100, 36729899],
    [4, 20000, 862771296],
  ] as const) {
    const id = `Source0${i}`;
    it(
      `${id}: unchanged string-hash(${input})`,
      () =>
        observation(id, async (journal) => {
          await sourceCase(input, expected, journal);
        }),
      120_000,
    );
  }
  for (const [id, kind] of [
    ["Import01", "S"],
    ["Import02", "C"],
  ] as const) {
    it(`${id}: ${kind === "S" ? "no growth" : "growth"} with function/table import custody`, () =>
      observation(id, async (journal) => {
        await runtimeCase({ id, label: "import custody", leftKind: kind, left: "ABCD", right: "q" }, journal, true);
      }));
  }
  const mutations = [
    "result/payload",
    "owner identity",
    "consumer completion",
    "helper binding",
    "heap delta",
    "header bytes",
    "untouched memory",
    "import binding",
  ] as const;
  for (const [index, mutation] of mutations.entries()) {
    const id = `Negative${String(index + 1).padStart(2, "0")}`;
    it(
      `${id}: same validator rejects ${mutation}`,
      () =>
        observation(id, async (journal) => {
          const original: Positive =
            index >= 1 && index <= 3
              ? await sourceCase(1, 96500, journal)
              : await runtimeCase(
                  { id, label: mutation, leftKind: "S", left: "ABCD", right: "q" },
                  journal,
                  index === 7,
                );
          validatePositive(original);
          const corrupted = corrupt(original, index);
          const negative: NegativeProof = {
            stage: "negative",
            mutation,
            original,
            corrupted,
            rejected: false,
            rejection: null,
          };
          journal.evidence = negative;
          try {
            validatePositive(corrupted);
          } catch (error) {
            negative.rejected = true;
            negative.rejection = String(error);
          }
          expect(negative.rejected).toBe(true);
          expect(negative.rejection).not.toBeNull();
          validatePositive(original);
        }),
      120_000,
    );
  }
});
function corrupt(proof: Positive, index: number): Positive {
  if (proof.kind === "source") {
    if (index === 1) return { ...proof, ownerUnitId: "foreign-owner" };
    if (index === 2) return { ...proof, receipt: { ...proof.receipt, completed: false } };
    if (index === 3) return { ...proof, binding: { ...proof.binding, index: proof.binding.index + 1 } };
    throw new Error("unmapped source negative control");
  }
  const transitions = structuredClone(proof.transitions);
  const step = transitions[0];
  if (!step) throw new Error("negative control has no positive transition");
  if (index === 0) step.result.payload[0] ^= 1;
  else if (index === 4) step.heapDelta++;
  else if (index === 5) {
    const bytes = new Uint8Array(Buffer.from(step.after.memoryBase64, "base64"));
    bytes[step.result.pointer] ^= 1;
    step.after.memoryBase64 = base64(bytes);
    step.result = carrier(bytes, step.result.pointer);
  } else if (index === 6) {
    const bytes = new Uint8Array(Buffer.from(step.after.memoryBase64, "base64"));
    bytes[0] ^= 1;
    step.after.memoryBase64 = base64(bytes);
  } else if (index === 7) return { ...proof, binding: { ...proof.binding, index: 1 } };
  else throw new Error("unmapped runtime negative control");
  return { ...proof, transitions };
}
