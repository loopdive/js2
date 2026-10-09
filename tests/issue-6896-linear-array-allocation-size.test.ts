// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { addArrayRuntime, addRuntime } from "../src/codegen-linear/runtime.js";
import * as binaryEmitter from "../src/emit/binary.js";
import { resolveLayout } from "../src/emit/resolve-layout.js";
import { compile } from "../src/index.js";
import {
  LINEAR_ARRAY_FORWARDING,
  LINEAR_VECTOR_CAPACITY_OFFSET,
  LINEAR_VECTOR_ELEMENTS_OFFSET,
  LINEAR_VECTOR_LENGTH_OFFSET,
  planLinearVectorLayout,
} from "../src/ir/analysis/linear-memory-plan.js";
import { getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";
import { forEachInstrDeep, irVal, type IrInstr } from "../src/ir/nodes.js";
import { createEmptyModule, type Instr } from "../src/ir/types.js";
import { walkInstructions } from "../src/wasm/model/instruction-walk.js";

const vectorLayout = planLinearVectorLayout(irVal({ kind: "f64" }));
const B = vectorLayout.elementsOffset;
const S = vectorLayout.elementStride;
const C = Math.floor((0xffffffff - B) / S);
const H = Math.floor(C / 2);
const fractional = -17.625;
const parentSource =
  "export function run(a:number,b:number):number { const values=[a,b]; return values[0]+values[1]+values.length; }";
// Same source bytes and runtime inputs as baseline-ir-control.json, but this
// usage-measured control explicitly adds arena-reset and disables optimization.
// The parent's original preprobe used the default allocator, not arena-reset.
const sourceOptions = { target: "linear", optimize: false, allocator: "arena-reset" } as const;
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function record(lane: string, caseId: string, actual: unknown) {
  console.log(JSON.stringify({ issue: 6896, lane, caseId, actual }));
}

beforeAll(() => {
  const root = new URL("../", import.meta.url);
  const helper = new URL("src/codegen-linear/runtime/array-allocation.ts", root);
  record("provenance", "identical-test-bytes", {
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: fileURLToPath(root), encoding: "utf8" }).trim(),
    runtimeSha256: sha256(readFileSync(new URL("src/codegen-linear/runtime.ts", root))),
    helperSha256: existsSync(helper) ? sha256(readFileSync(helper)) : "absent",
    testSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    node: process.version,
    v8: process.versions.v8,
    execArgv: process.execArgv,
    nodeOptions: process.env.NODE_OPTIONS ?? null,
    linearIrFlag: process.env.JS2WASM_LINEAR_IR ?? null,
    harness: "real-emitted-wasm / nonallocating-malloc-observer / actual-source-IR",
    runtimeOptions: { exposeArenaReset: true },
    sourceOptions,
    sourceControlConfigurationNote:
      "Extra usage-measured configuration: arena-reset and optimize:false; original parent baseline control used the default allocator.",
    layout: { B, S, C, H },
    retainedParentReportingLimitation: "The earlier BigInt reporting/setup error is not an overflow trap.",
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

interface Runtime {
  memory: WebAssembly.Memory;
  heap: WebAssembly.Global;
  used: () => number;
  malloc: (size: number) => number;
  newArray: (capacity: number) => number;
  grow: (pointer: number, minimum: number) => number;
  set: (pointer: number, index: number, value: number) => void;
  resolve: (pointer: number) => number;
}

async function runtime(observer?: (size: number) => never): Promise<Runtime> {
  const mod = createEmptyModule();
  // Install this import BEFORE runtime registration so all generated calls see
  // the real imported-function offset. No host allocation is possible here.
  if (observer) {
    const typeIdx = mod.types.length;
    mod.types.push({ kind: "func", params: [{ kind: "i32" }], results: [{ kind: "i32" }] });
    mod.imports.push({ module: "issue6896", name: "observeAllocationSize", desc: { kind: "func", typeIdx } });
  }
  addRuntime(mod, { exposeArenaReset: true });
  addArrayRuntime(mod);
  const importedFunctions = mod.imports.filter((entry) => entry.desc.kind === "func").length;
  if (observer) {
    const malloc = mod.functions.find((fn) => fn.name === "__malloc");
    if (!malloc) throw new Error("fixture missing real __malloc definition");
    // Only this UNIT fixture replaces the allocator body, keeping its existing
    // signature, registration and handle. The observer always throws before
    // the runtime can store a header or copy bytes.
    malloc.body = [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: 0 },
    ];
  }
  for (const name of ["__malloc", "__arr_new", "__arr_grow", "__arr_set", "__arr_resolve"]) {
    const position = mod.functions.findIndex((fn) => fn.name === name);
    if (position < 0) throw new Error(`fixture missing ${name}`);
    mod.exports.push({ name, desc: { kind: "func", index: importedFunctions + position } });
  }
  const heapPosition = mod.globals.findIndex((global) => global.name === "__heap_ptr");
  if (heapPosition < 0) throw new Error("fixture missing __heap_ptr");
  const importedGlobals = mod.imports.filter((entry) => entry.desc.kind === "global").length;
  mod.exports.push({ name: "issue6896_heap", desc: { kind: "global", index: importedGlobals + heapPosition } });
  const binary = binaryEmitter.emitBinary(mod);
  expect(WebAssembly.validate(binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(
    binary,
    observer ? { issue6896: { observeAllocationSize: observer } } : {},
  );
  const e = instance.exports;
  return {
    memory: e.memory as WebAssembly.Memory,
    heap: e.issue6896_heap as WebAssembly.Global,
    used: e.__arena_used as Runtime["used"],
    malloc: e.__malloc as Runtime["malloc"],
    newArray: e.__arr_new as Runtime["newArray"],
    grow: e.__arr_grow as Runtime["grow"],
    set: e.__arr_set as Runtime["set"],
    resolve: e.__arr_resolve as Runtime["resolve"],
  };
}

type Region = { name: string; pointer: number; bytes: number };
function snapshot(r: Runtime, regions: Region[]) {
  // Copy the entire small memory, not a live view that would change with it.
  const bytes = new Uint8Array(r.memory.buffer).slice();
  return {
    heap: Number(r.heap.value) >>> 0,
    used: r.used() >>> 0,
    memoryBytes: bytes.length,
    memorySha256: sha256(bytes),
    regions: regions.map((region) => ({
      ...region,
      data: Array.from(bytes.slice(region.pointer, region.pointer + region.bytes)),
    })),
    bytes,
  };
}
function printable(state: ReturnType<typeof snapshot>) {
  const { bytes: _bytes, ...result } = state;
  return result;
}
function unchanged(before: ReturnType<typeof snapshot>, after: ReturnType<typeof snapshot>) {
  expect(printable(after)).toEqual(printable(before));
  expect(after.bytes).toEqual(before.bytes);
}
function sentinel(r: Runtime): Region {
  const pointer = r.malloc(32) >>> 0;
  new Uint8Array(r.memory.buffer, pointer, 32).set(Array.from({ length: 32 }, (_, i) => 0xa0 + i));
  return { name: "allocated-neighbor", pointer, bytes: 32 };
}
function header(r: Runtime, pointer: number) {
  const view = new DataView(r.memory.buffer);
  return {
    tag: view.getUint32(pointer, true),
    word4: view.getUint32(pointer + 4, true),
    length: view.getUint32(pointer + LINEAR_VECTOR_LENGTH_OFFSET, true),
    capacity: view.getUint32(pointer + LINEAR_VECTOR_CAPACITY_OFFSET, true),
  };
}
function capture(call: () => number) {
  try {
    return { returned: call() >>> 0, error: undefined };
  } catch (error) {
    return { returned: undefined, error };
  }
}
function errorRecord(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message, runtimeTrap: error instanceof WebAssembly.RuntimeError }
    : { value: error === undefined ? "none" : String(error), runtimeTrap: false };
}

describe("#6896 real-runtime allocation size and unchanged small controls", () => {
  for (const capacity of [0x20000000, 0x20000001, -1]) {
    it(`rejects original wrapped __arr_new(${capacity}) before any allocation or store`, async () => {
      const r = await runtime();
      const regions = [sentinel(r)];
      const before = snapshot(r, regions);
      const outcome = capture(() => r.newArray(capacity));
      const after = snapshot(r, regions);
      record("real-runtime", `parent-new-${capacity}`, {
        capacity,
        unsignedCapacity: capacity >>> 0,
        mathematicalBytes: B + (capacity >>> 0) * S,
        returned: outcome.returned ?? null,
        error: errorRecord(outcome.error),
        before: printable(before),
        after: printable(after),
      });
      expect(outcome.error).toBeInstanceOf(WebAssembly.RuntimeError);
      expect(outcome.returned).toBeUndefined();
      unchanged(before, after);
    });
  }

  it("rejects the original wrapped grow minimum while preserving source and neighbor", async () => {
    const r = await runtime();
    const old = r.newArray(4) >>> 0;
    r.set(old, 0, fractional);
    const regions = [{ name: "source-header-and-first-slot", pointer: old, bytes: B + S }, sentinel(r)];
    const before = snapshot(r, regions);
    const beforeHeader = header(r, old);
    const outcome = capture(() => r.grow(old, 0x20000000));
    const after = snapshot(r, regions);
    record("real-runtime", "parent-grow-4-to-0x20000000", {
      old,
      oldCapacity: 4,
      minimum: 0x20000000,
      fractional,
      returned: outcome.returned ?? null,
      error: errorRecord(outcome.error),
      beforeHeader,
      afterHeader: header(r, old),
      before: printable(before),
      after: printable(after),
    });
    expect(beforeHeader).toMatchObject({ tag: 1, length: 1, capacity: 4 });
    expect(outcome.error).toBeInstanceOf(WebAssembly.RuntimeError);
    expect(outcome.returned).toBeUndefined();
    unchanged(before, after);
  });

  for (const capacity of [0, 4]) {
    it(`preserves small new capacity ${capacity} without the source minimum clamp`, async () => {
      const r = await runtime();
      const neighbor = sentinel(r);
      const before = snapshot(r, [neighbor]);
      const pointer = r.newArray(capacity) >>> 0;
      const after = snapshot(r, [neighbor, { name: "new-header", pointer, bytes: B }]);
      const actualHeader = header(r, pointer);
      record("real-runtime", `small-new-${capacity}`, {
        capacity,
        pointer,
        actualHeader,
        before: printable(before),
        after: printable(after),
      });
      expect(pointer % 8).toBe(0);
      expect(actualHeader).toEqual({ tag: 1, word4: 0, length: 0, capacity });
      expect(after.used - before.used).toBe(B + capacity * S);
      expect(after.heap - before.heap).toBe(B + capacity * S);
      expect(after.memoryBytes).toBe(before.memoryBytes);
      expect(after.regions[0]).toEqual(before.regions[0]);
    });
  }

  for (const [oldCapacity, minimum, expectedCapacity] of [
    [0, 1, 4],
    [4, 5, 8],
    [4, 12, 12],
  ]) {
    it(`preserves small grow ${oldCapacity}/${minimum} -> ${expectedCapacity}, copy and forwarding`, async () => {
      const r = await runtime();
      const old = r.newArray(oldCapacity) >>> 0;
      const length = oldCapacity === 0 ? 0 : 1;
      if (length) r.set(old, 0, fractional);
      const neighbor = sentinel(r);
      const regions = [{ name: "old-record", pointer: old, bytes: B + oldCapacity * S }, neighbor];
      const before = snapshot(r, regions);
      const pointer = r.grow(old, minimum) >>> 0;
      const after = snapshot(r, [...regions, { name: "new-record", pointer, bytes: B + expectedCapacity * S }]);
      const view = new DataView(r.memory.buffer);
      const payload = Array.from({ length }, (_, i) => view.getFloat64(pointer + B + i * S, true));
      record("real-runtime", `small-grow-${oldCapacity}-${minimum}`, {
        oldCapacity,
        minimum,
        expectedCapacity,
        old,
        pointer,
        length,
        payload,
        oldHeader: header(r, old),
        newHeader: header(r, pointer),
        before: printable(before),
        after: printable(after),
      });
      expect(pointer).not.toBe(old);
      expect(pointer % 8).toBe(0);
      expect(header(r, pointer)).toEqual({ tag: 1, word4: 0, length, capacity: expectedCapacity });
      expect(payload).toEqual(length ? [fractional] : []);
      expect(after.used - before.used).toBe(B + expectedCapacity * S);
      expect(after.heap - before.heap).toBe(B + expectedCapacity * S);
      expect(after.memoryBytes).toBe(before.memoryBytes);
      expect(after.regions[1]).toEqual(before.regions[1]);
      expect(Array.from(after.bytes.slice(old + B, old + B + oldCapacity * S))).toEqual(
        Array.from(before.bytes.slice(old + B, old + B + oldCapacity * S)),
      );
      expect(view.getUint32(old + LINEAR_ARRAY_FORWARDING.tagOffset, true)).toBe(LINEAR_ARRAY_FORWARDING.tag);
      expect(view.getUint32(old + LINEAR_ARRAY_FORWARDING.pointerOffset, true)).toBe(pointer);
      expect(header(r, old)).toMatchObject({ length, capacity: oldCapacity });
      expect(r.resolve(old) >>> 0).toBe(pointer);
    });
  }
});

// These are arithmetic units, NOT successful production giant allocations or
// source-IR evidence. Their malloc observer throws before allocation/copy.
const observerCases = [
  { id: "new-C-minus-1", capacity: C - 1, size: B + (C - 1) * S },
  { id: "new-C", capacity: C, size: B + C * S },
  { id: "new-C-plus-1", capacity: C + 1, size: null },
  { id: "new-product-wrap-zero", capacity: 0x20000000, size: null },
  { id: "new-product-wrap-one", capacity: 0x20000001, size: null },
  { id: "new-negative-one", capacity: -1, size: null },
  { id: "grow-min-C", oldCapacity: 4, minimum: C, size: B + C * S },
  { id: "grow-min-C-plus-1", oldCapacity: 4, minimum: C + 1, size: null },
  { id: "grow-old-H", oldCapacity: H, minimum: 0, size: B + 2 * H * S },
  { id: "grow-old-H-plus-1", oldCapacity: H + 1, minimum: 0, size: null },
  { id: "grow-old-high-bit", oldCapacity: 0x80000000, minimum: 4, size: null },
] as const;

describe("#6896 unit-nonallocating-observer boundary matrix", () => {
  for (const entry of observerCases) {
    it(entry.id, async () => {
      const observedSizes: number[] = [];
      const observerError = new Error(`issue6896 allocation observer ${entry.id}`);
      const r = await runtime((size) => {
        observedSizes.push(size >>> 0);
        throw observerError;
      });
      const old = 64;
      const neighbor = { name: "synthetic-neighbor", pointer: 128, bytes: 32 };
      new Uint8Array(r.memory.buffer, neighbor.pointer, neighbor.bytes).fill(0xb7);
      const regions = [neighbor];
      if ("oldCapacity" in entry) {
        const view = new DataView(r.memory.buffer);
        view.setUint32(old, 1, true);
        view.setUint32(old + LINEAR_VECTOR_LENGTH_OFFSET, 1, true);
        view.setUint32(old + LINEAR_VECTOR_CAPACITY_OFFSET, entry.oldCapacity, true);
        view.setFloat64(old + LINEAR_VECTOR_ELEMENTS_OFFSET, fractional, true);
        regions.push({ name: "synthetic-old-header-and-one-slot", pointer: old, bytes: B + S });
      }
      const before = snapshot(r, regions);
      const outcome = capture(() => ("capacity" in entry ? r.newArray(entry.capacity) : r.grow(old, entry.minimum)));
      const after = snapshot(r, regions);
      record("unit-nonallocating-observer", entry.id, {
        input: entry,
        expectedUnsignedSize: entry.size,
        observedSizes,
        observerCount: observedSizes.length,
        exactObserverError: outcome.error === observerError,
        error: errorRecord(outcome.error),
        returned: outcome.returned ?? null,
        before: printable(before),
        after: printable(after),
      });
      if (entry.size === null) {
        expect(outcome.error).toBeInstanceOf(WebAssembly.RuntimeError);
        expect(outcome.error).not.toBe(observerError);
        expect(observedSizes).toEqual([]);
      } else {
        expect(outcome.error).toBe(observerError);
        expect(outcome.error).not.toBeInstanceOf(WebAssembly.RuntimeError);
        expect(observedSizes).toEqual([entry.size]);
      }
      expect(outcome.returned).toBeUndefined();
      unchanged(before, after);
    });
  }
});

describe("#6896 actual source-IR normal allocation control", () => {
  it("preserves the parent runtime-input fixture, canonical arena144 site, actual arr_new call and result1.25", async () => {
    vi.stubEnv("JS2WASM_LINEAR_IR", "1");
    const emission = vi.spyOn(binaryEmitter, "emitBinary");
    const result = await compile(parentSource, sourceOptions);
    const report = getLastLinearIrReport();
    const mod = emission.mock.calls.at(-1)?.[0];
    const emitted = emission.mock.results.at(-1);
    const emittedSha256 = emitted?.type === "return" ? sha256(emitted.value) : null;
    emission.mockRestore();
    record("source-IR", "parent-compile", {
      source: parentSource,
      sourceSha256: sha256(parentSource),
      options: sourceOptions,
      configurationRole: "extra usage-measured source control, not the original default-allocator preprobe",
      linearIrFlag: process.env.JS2WASM_LINEAR_IR,
      success: result.success,
      errors: result.errors,
      compiled: report?.compiled ?? null,
      rejected: report?.rejected ?? null,
      ownerEvidence: report?.ownerEvidence ?? null,
      legacySlots: report?.legacySlots ?? null,
      memoryPlan: report?.memoryPlan.toJSON() ?? null,
      capturedActualEmission: !!mod,
      emittedSha256,
      returnedBinarySha256: sha256(result.binary),
    });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    if (!result.success || !report || !mod) throw new Error("missing actual source compilation/report/emission");
    expect(emittedSha256).toBe(sha256(result.binary));
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(report.compiled).toEqual(["run"]);
    expect(report.rejected).toEqual([]);
    const owner = report.irModule.functions.find((fn) => fn.name === "run");
    if (!owner) throw new Error("missing actual run IR owner");
    const instructions: IrInstr[] = [];
    for (const block of owner.blocks)
      for (const instr of block.instrs)
        forEachInstrDeep(instr, (nested) => {
          instructions.push(nested);
        });
    const vectors = instructions.filter((instr) => instr.kind === "vec.new_fixed");
    const allocations = report.memoryPlan.allocations.filter((site) => site.ownerFunction === "run");
    expect(vectors).toHaveLength(1);
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({
      allocationKind: "array",
      allocationClass: "arena",
      layoutId: "vector:scalar:f64",
      size: { kind: "constant", bytes: 144 },
    });
    expect(vectors[0].alloc).toBe(allocations[0].id);
    expect(report.memoryPlan.layoutForVector(irVal({ kind: "f64" }))).toMatchObject({
      elementsOffset: 16,
      elementStride: 8,
      minimumCapacity: 16,
    });
    const slot = report.legacySlots.find((entry) => entry.ownerUnitId === owner.unitId);
    expect(report.ownerEvidence).toContainEqual({ outcome: "compiled", ownerUnitId: owner.unitId, legacyName: "run" });
    if (!slot) throw new Error("missing actual compiled owner slot");
    const importedFunctions = mod.imports.filter((entry) => entry.desc.kind === "func").length;
    const arrPosition = mod.functions.findIndex((fn) => fn.name === "__arr_new");
    const runExport = mod.exports.find((entry) => entry.name === "run" && entry.desc.kind === "func");
    if (arrPosition < 0 || !runExport) throw new Error("missing actual defined arr_new or run export");
    const layout = resolveLayout(mod);
    const exportIndex = layout.func(runExport.desc.index);
    const runIndex = layout.func(slot.funcIdx);
    const runBody = mod.functions[runIndex - importedFunctions];
    if (!runBody) throw new Error("compiled owner slot does not bind an actual defined function");
    const exportBody = mod.functions[exportIndex - importedFunctions];
    if (!exportBody) throw new Error("run export does not bind an actual defined function");
    // arena-reset installs a host-entry wrapper. Prove that the executed export
    // calls this exact reported owner, rather than mistaking wrapper IR for it.
    const exportCalls: number[] = [];
    walkInstructions(exportBody.body, (op) => {
      if (op.op === "call") exportCalls.push(layout.func(op.funcIdx));
    });
    expect(exportCalls.filter((index) => index === runIndex)).toHaveLength(1);
    expect(report.funcs.get(owner.unitId)?.body).toEqual(runBody.body);
    const ops: Instr[] = [];
    walkInstructions(runBody.body, (op) => {
      ops.push(op);
    });
    const arrIndex = importedFunctions + arrPosition;
    const calls = ops.flatMap((op, index) =>
      op.op === "call" && layout.func(op.funcIdx) === arrIndex ? [{ index, preceding: ops[index - 1] }] : [],
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].preceding).toMatchObject({ op: "i32.const", value: 16 });
    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
    const used = instance.exports.__arena_used as () => number;
    const beforeUsed = used();
    const actual = (instance.exports.run as (a: number, b: number) => number)(1.5, -2.25);
    const afterUsed = used();
    record("source-IR", "parent-run", {
      inputs: [1.5, -2.25],
      actual,
      expected: 1.25,
      beforeUsed,
      afterUsed,
      ownerUnitId: owner.unitId,
      slot,
      vectorNodes: vectors,
      allocations,
      actualEmittedBinding: {
        name: mod.functions[arrPosition].name,
        arrIndex,
        runIndex,
        exportIndex,
        exportCalls,
        calls,
      },
      binarySha256: sha256(result.binary),
    });
    expect(actual).toBe(1.25);
    expect(beforeUsed).toBe(0);
    expect(afterUsed).toBe(144);
  });
});
