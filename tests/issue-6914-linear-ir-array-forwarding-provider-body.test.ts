// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import * as linearCodegen from "../src/codegen-linear/index.js";
import * as runtime from "../src/codegen-linear/runtime.js";
import { walkInstructions } from "../src/codegen/walk-instructions.js";
import { emitBinary } from "../src/emit/binary.js";
import { resolveLayout } from "../src/emit/resolve-layout.js";
import { compile } from "../src/index.js";
import { getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";
import { assertFrozenIrBodyBatch, type FrozenIrBodyBatch } from "../src/ir/frozen-body-batch.js";
import type { IrFunction } from "../src/ir/nodes.js";
import {
  LINEAR_ARRAY_FORWARDING,
  LINEAR_VECTOR_LENGTH_OFFSET,
  LINEAR_VECTOR_CAPACITY_OFFSET,
  LINEAR_VECTOR_ELEMENTS_OFFSET,
} from "../src/ir/analysis/linear-memory-plan.js";
import { createEmptyModule, type Instr, type WasmModule } from "../src/ir/types.js";

type Consumption = {
  batch: FrozenIrBodyBatch;
  backend: string;
  moduleSession: object | undefined;
  completed: boolean;
  outputs: { ownerUnitId: string; func: IrFunction; body: unknown }[];
  failure?: unknown;
};
const captures = vi.hoisted(() => {
  const modules: WasmModule[] = [];
  const consumers: Consumption[] = [];
  const restorers: (() => void)[] = [];
  return { modules, consumers, restorers };
});
// Call-through observation only: retain the original receiver, arguments, return and errors.
vi.mock("../src/codegen-linear/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/codegen-linear/runtime.js")>();
  const original = actual.addArrayRuntime;
  const spy = vi.spyOn(actual, "addArrayRuntime").mockImplementation(function (this: unknown, ...args) {
    captures.modules.push(args[0]);
    return Reflect.apply(original, this, args);
  });
  captures.restorers.push(() => spy.mockRestore());
  return { ...actual, addArrayRuntime: spy };
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

const SOURCES = [
  {
    id: "source-alias31",
    source:
      "export function run(): number { const values=[1.5,-2.25]; const alias=values; alias[31]=3.75; return values[31]; }",
    expected: 3.75,
    name: "run",
    options: { target: "linear", abi: "c", optimize: false },
    native: () => {
      const values = [1.5, -2.25];
      const alias = values;
      alias[31] = 3.75;
      return values[31];
    },
  },
  {
    id: "source-push31",
    source:
      "\n      export function test(): number {\n        const a = [7];\n        for (let i = 1; i <= 30; i++) a.push(i);\n        return a[0] + a[1] + a[30] + a.length;\n      }\n    ",
    expected: 69,
    name: "test",
    options: { target: "linear" },
    native: () => {
      const a = [7];
      for (let i = 1; i <= 30; i++) a.push(i);
      return a[0] + a[1] + a[30] + a.length;
    },
  },
  {
    id: "source-alias-push21",
    source:
      "\n      export function test(): number {\n        const a = [1];\n        const b = a;\n        for (let i = 0; i < 20; i++) a.push(i);\n        return b.length + b[20];\n      }\n    ",
    expected: 40,
    name: "test",
    options: { target: "linear" },
    native: () => {
      const a = [1];
      const b = a;
      for (let i = 0; i < 20; i++) a.push(i);
      return b.length + b[20];
    },
  },
] as const;
const IMPORT_SOURCE = "export function test(): number { const a=[1.5]; a[31]=3.75; return a[31]; }";
const IMPORT_OPTIONS = {
  externImports: [
    { module: "probe", name: "unused", params: [], results: [] },
    { module: "probe", name: "__arr_resolve", params: [{ kind: "i32" }], results: [{ kind: "i32" }] },
  ],
} satisfies Parameters<typeof linearCodegen.generateLinearModule>[1];
const IDS = [
  "source-alias31",
  "source-push31",
  "source-alias-push21",
  "source-import-custody",
  "resolve-zero-hop",
  "resolve-one-hop",
  "resolve-three-hop",
  "legacy-u8-forwarded",
  "registration-array-first",
  "registration-u8-first",
  "installed-exact-body-abi",
  "import-offset-artifact",
  "fresh-object-custody",
];
const TEST_PATH = "tests/issue-6914-linear-ir-array-forwarding-provider-body.test.ts";
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
type Evidence = { phase: string; [key: string]: unknown };
const observed = new Set<string>();
function record(kind: string, data: object) {
  console.log(
    JSON.stringify({ issue: 6914, schemaVersion: 1, kind, ...data }, (_key, value) => {
      if (value instanceof Error) return { name: value.name, message: value.message };
      if (typeof value === "number" && Number.isNaN(value)) return { kind: "nan" };
      if (typeof value === "number" && Object.is(value, -0)) return { kind: "number", value: "-0" };
      return value;
    }),
  );
}
async function observation(id: string, lane: string, action: (evidence: Evidence) => Promise<void>) {
  const evidence: Evidence = { phase: "setup" };
  let passed = false;
  let failure: unknown;
  try {
    await action(evidence);
    passed = true;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const duplicate = observed.has(id);
    observed.add(id);
    record("observation", {
      id,
      lane,
      status: passed ? "passed" : "failed",
      evidence,
      failure: passed
        ? null
        : failure instanceof Error
          ? { name: failure.name, message: failure.message }
          : String(failure),
    });
    expect(duplicate).toBe(false);
  }
}
beforeAll(() =>
  record("provenance", {
    head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    baseline: "3146af9a349bb20a5a398fba37e8b69b16fb4ab9",
    dirty: execFileSync("git", ["-c", "filter.lfs.process=", "-c", "filter.lfs.required=false", "status", "--short"], {
      encoding: "utf8",
    }),
    testSha256: sha256(readFileSync(TEST_PATH)),
    runtimeSha256: sha256(readFileSync("src/codegen-linear/runtime.ts")),
    layoutSha256: sha256(readFileSync("src/ir/analysis/linear-memory-plan.ts")),
    sourceFixtures: [
      ...SOURCES.map(({ id, source, options }) => ({ id, source, sourceSha256: sha256(source), options })),
      {
        id: "source-import-custody",
        source: IMPORT_SOURCE,
        sourceSha256: sha256(IMPORT_SOURCE),
        options: IMPORT_OPTIONS,
      },
    ],
    node: process.version,
    v8: process.versions.v8,
    execArgv: process.execArgv,
    argv: process.argv,
    nodeOptions: process.env.NODE_OPTIONS ?? "",
    linearIrFlag: process.env.JS2WASM_LINEAR_IR ?? null,
    command: process.env.JS2WASM_FORWARDING_TEST_COMMAND ?? null,
    deadline: process.env.JS2WASM_FORWARDING_TEST_DEADLINE ?? null,
    expectedObservations: 13,
    ids: IDS,
  }),
);
afterEach(() => {
  captures.modules.length = 0;
  captures.consumers.length = 0;
  vi.unstubAllEnvs();
});
afterAll(() => {
  for (const restore of captures.restorers.reverse()) restore();
  expect([...observed].sort()).toEqual([...IDS].sort());
  expect(observed.size).toBe(13);
});

// Literal full-tree oracle only; never installed as a substitute runtime body.
const EXPECTED_BODY: Instr[] = [
  {
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          { op: "local.get", index: 0 },
          { op: "i32.load8_u", align: 0, offset: LINEAR_ARRAY_FORWARDING.tagOffset },
          { op: "i32.const", value: LINEAR_ARRAY_FORWARDING.tag },
          { op: "i32.ne" },
          { op: "br_if", depth: 1 },
          { op: "local.get", index: 0 },
          { op: "i32.load", align: 2, offset: LINEAR_ARRAY_FORWARDING.pointerOffset },
          { op: "local.set", index: 0 },
          { op: "br", depth: 0 },
        ],
      },
    ],
  },
  { op: "local.get", index: 0 },
];
function defined(module: WasmModule, name: string) {
  const position = module.functions.findIndex((fn) => fn.name === name);
  if (position < 0) throw new Error(`missing actual defined ${name}`);
  const imports = module.imports.filter((entry) => entry.desc.kind === "func").length;
  return { fn: module.functions[position], index: imports + position, imports };
}
function helperWitness(module: WasmModule) {
  const { fn, index, imports } = defined(module, "__arr_resolve");
  return {
    index,
    importedFunctions: imports,
    name: fn.name,
    typeIdx: fn.typeIdx,
    type: module.types[fn.typeIdx],
    locals: fn.locals,
    exported: fn.exported,
    body: fn.body,
  };
}
function binaryArtifact(binary: Uint8Array) {
  const bytes = new Uint8Array(binary);
  return {
    bytes,
    witness: {
      binaryBase64: Buffer.from(binary).toString("base64"),
      sha256: sha256(binary),
      byteLength: binary.byteLength,
      valid: WebAssembly.validate(bytes),
    },
  };
}
function calls(body: Instr[]) {
  const entries: Extract<Instr, { op: "call" }>[] = [];
  walkInstructions(body, (instruction) => {
    if (instruction.op === "call") entries.push(instruction);
  });
  return entries;
}
function call(exports: WebAssembly.Exports, name: string, ...args: number[]): number {
  const fn = exports[name];
  if (typeof fn !== "function") throw new Error(`missing actual export ${name}`);
  const value: unknown = fn(...args);
  if (typeof value !== "number") throw new Error(`${name} returned a non-number`);
  return value;
}
function invoke(exports: WebAssembly.Exports, name: string, ...args: number[]) {
  const fn = exports[name];
  if (typeof fn !== "function") throw new Error(`missing actual export ${name}`);
  fn(...args);
}
function assertCaller(module: WasmModule, name: string, evidence: Evidence) {
  const report = getLastLinearIrReport();
  evidence.report = report
    ? { compiled: report.compiled, rejected: report.rejected, ownerEvidence: report.ownerEvidence }
    : null;
  evidence.registrationCount = captures.modules.length;
  evidence.consumption = captures.consumers.map((receipt) => ({
    backend: receipt.backend,
    completed: receipt.completed,
    digest: receipt.batch.digest,
    owners: receipt.batch.owners,
    outputs: receipt.outputs.map((output) => ({
      ownerUnitId: output.ownerUnitId,
      func: output.func,
      body: output.body,
    })),
    failure: receipt.failure ?? null,
  }));
  expect(captures.modules).toContain(module);
  expect(captures.consumers.length).toBeGreaterThan(0);
  if (!report) throw new Error("missing current compiler report");
  const receipt = captures.consumers.find(
    (entry) => entry.batch === report.frozenBodyBatch && entry.moduleSession === module,
  );
  if (!receipt) throw new Error("no exact batch/module consumer identity");
  assertFrozenIrBodyBatch(receipt.batch);
  expect(receipt.completed).toBe(true);
  expect(receipt.backend).toBe("linear");
  expect(report.irModule).toBe(receipt.batch.module);
  const logical = report.irModule.functions.find((fn) => fn.name === name);
  if (!logical) throw new Error("current source owner was not IR-admitted");
  const output = receipt.outputs.find((entry) => entry.ownerUnitId === logical.unitId);
  if (!output) throw new Error("current owner was not actually consumed");
  expect(output.func).toBe(logical);
  expect(report.ownerEvidence).toContainEqual({ outcome: "compiled", ownerUnitId: logical.unitId, legacyName: name });
  const physical = report.funcs.get(logical.unitId);
  if (!physical) throw new Error("missing actual owned physical body");
  expect(module.functions).toContain(physical);
  expect(physical.body).toBe(output.body);
  const resolver = defined(module, "__arr_resolve");
  const layout = resolveLayout(module);
  const resolverCalls = calls(physical.body).filter(
    (entry) => module.functions[layout.func(entry.funcIdx) - resolver.imports] === resolver.fn,
  );
  expect(resolverCalls.length).toBeGreaterThan(0);
  evidence.caller = {
    unitId: logical.unitId,
    nativeFunctionName: name,
    logical,
    physical,
    resolverCalls,
    helper: helperWitness(module),
    authenticFrozenBatch: true,
    exactConsumerModuleAndOwner: true,
  };
}
async function sourceCase(entry: (typeof SOURCES)[number], evidence: Evidence) {
  const hadFlag = Object.hasOwn(process.env, "JS2WASM_LINEAR_IR");
  const previous = process.env.JS2WASM_LINEAR_IR;
  const generate = vi.spyOn(linearCodegen, "generateLinearModule");
  try {
    if (entry.id === "source-alias31") vi.stubEnv("JS2WASM_LINEAR_IR", "1");
    Object.assign(evidence, {
      phase: "source compiler",
      source: entry.source,
      options: entry.options,
      flag: process.env.JS2WASM_LINEAR_IR ?? null,
      native: entry.native(),
      expected: entry.expected,
    });
    expect(entry.native()).toBe(entry.expected);
    const result = await compile(entry.source, entry.options);
    const artifact = binaryArtifact(result.binary);
    Object.assign(evidence, {
      compile: { success: result.success, errors: result.errors },
      artifact: artifact.witness,
    });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(generate).toHaveBeenCalledOnce();
    const generated = generate.mock.results[0];
    if (generated?.type !== "return") throw new Error("no real generated module");
    assertCaller(generated.value, entry.name, evidence);
    expect(artifact.witness.valid).toBe(true);
    const { instance } = await WebAssembly.instantiate(
      artifact.bytes,
      entry.id === "source-alias31" ? {} : { env: {} },
    );
    evidence.actual = call(instance.exports, entry.name);
    expect(evidence.actual).toBe(entry.expected);
  } finally {
    evidence.generatorCalls = generate.mock.calls.length;
    generate.mockRestore();
    vi.unstubAllEnvs();
    evidence.environmentRestored = {
      hadFlag,
      hasFlag: Object.hasOwn(process.env, "JS2WASM_LINEAR_IR"),
      previous: previous ?? null,
      restored: process.env.JS2WASM_LINEAR_IR ?? null,
    };
    expect(Object.hasOwn(process.env, "JS2WASM_LINEAR_IR")).toBe(hadFlag);
    expect(process.env.JS2WASM_LINEAR_IR).toBe(previous);
  }
}

function runtimeModule(u8 = false, imports = false) {
  const module = createEmptyModule();
  if (imports) {
    module.types.push(
      { kind: "func", params: [], results: [] },
      { kind: "func", params: [{ kind: "i32" }], results: [{ kind: "i32" }] },
    );
    module.imports.push(
      { module: "probe", name: "unused", desc: { kind: "func", typeIdx: 0 } },
      { module: "probe", name: "table", desc: { kind: "table", elementType: "funcref", min: 1 } },
      { module: "probe", name: "__arr_resolve", desc: { kind: "func", typeIdx: 1 } },
    );
  }
  runtime.addRuntime(module, { exposeArenaReset: true });
  runtime.addArrayRuntime(module);
  if (u8) runtime.addUint8ArrayRuntime(module);
  for (const name of [
    "__arr_new",
    "__arr_grow",
    "__arr_set",
    "__arr_get",
    "__arr_len",
    "__arr_resolve",
    "__malloc",
    ...(u8 ? ["__u8arr_from_arr", "__u8arr_len"] : []),
  ])
    module.exports.push({ name, desc: { kind: "func", index: defined(module, name).index } });
  const heap = module.globals.findIndex((entry) => entry.name === "__heap_ptr");
  if (heap < 0) throw new Error("missing actual heap global");
  module.exports.push({ name: "heap", desc: { kind: "global", index: heap } });
  return module;
}
async function runtimeInstance(evidence: Evidence, u8 = false, imports = false) {
  const module = runtimeModule(u8, imports);
  const artifact = binaryArtifact(emitBinary(module));
  Object.assign(evidence, {
    phase: "runtime instantiation",
    artifact: artifact.witness,
    helper: helperWitness(module),
    moduleImports: module.imports,
    tables: module.tables,
  });
  expect(artifact.witness.valid).toBe(true);
  let namesakeCalls = 0;
  let decoyCalls = 0;
  const { instance } = await WebAssembly.instantiate(
    artifact.bytes,
    imports
      ? {
          probe: {
            table: new WebAssembly.Table({ element: "anyfunc", initial: 1 }),
            unused: () => {
              decoyCalls++;
            },
            __arr_resolve: () => {
              namesakeCalls++;
              throw new Error("wrong imported resolver invoked");
            },
          },
        }
      : {},
  );
  const memory = instance.exports.memory;
  const heap = instance.exports.heap;
  if (!(memory instanceof WebAssembly.Memory) || !(heap instanceof WebAssembly.Global))
    throw new Error("missing actual runtime memory/heap");
  const snapshot = () => {
    const bytes = new Uint8Array(memory.buffer).slice();
    return {
      bytes,
      witness: {
        memoryBase64: Buffer.from(bytes).toString("base64"),
        memorySha256: sha256(bytes),
        memoryBytes: bytes.length,
        heap: Number(heap.value),
        used: call(instance.exports, "__arena_used"),
      },
    };
  };
  return { module, exports: instance.exports, memory, snapshot, importedCalls: () => ({ namesakeCalls, decoyCalls }) };
}
type RuntimeInstance = Awaited<ReturnType<typeof runtimeInstance>>;
function bounds(memory: WebAssembly.Memory, pointer: number, bytes: number) {
  expect(Number.isInteger(pointer)).toBe(true);
  expect(pointer).toBeGreaterThanOrEqual(0);
  expect(pointer % 8).toBe(0);
  expect(pointer + bytes).toBeLessThanOrEqual(memory.buffer.byteLength);
}
function header(probe: RuntimeInstance, pointer: number) {
  bounds(probe.memory, pointer, LINEAR_VECTOR_ELEMENTS_OFFSET);
  const view = new DataView(probe.memory.buffer);
  const length = view.getUint32(pointer + LINEAR_VECTOR_LENGTH_OFFSET, true);
  expect(length).toBeLessThanOrEqual(128);
  bounds(probe.memory, pointer, LINEAR_VECTOR_ELEMENTS_OFFSET + length * 8);
  return {
    pointer,
    tag: view.getUint8(pointer + LINEAR_ARRAY_FORWARDING.tagOffset),
    link: view.getUint32(pointer + LINEAR_ARRAY_FORWARDING.pointerOffset, true),
    length,
    capacity: view.getUint32(pointer + LINEAR_VECTOR_CAPACITY_OFFSET, true),
    header: Array.from(new Uint8Array(probe.memory.buffer, pointer, LINEAR_VECTOR_ELEMENTS_OFFSET)),
    elements: Array.from(new Float64Array(probe.memory.buffer, pointer + LINEAR_VECTOR_ELEMENTS_OFFSET, length)),
  };
}
function chain(probe: RuntimeInstance, hops: number, evidence: Evidence, values = [1.5, -2.25]) {
  let current = call(probe.exports, "__arr_new", 4);
  bounds(probe.memory, current, LINEAR_VECTOR_ELEMENTS_OFFSET + 32);
  values.forEach((value, index) => invoke(probe.exports, "__arr_set", current, index, value));
  const pointers = [current];
  const growth: object[] = [];
  Object.assign(evidence, { pointers, growth, initialized: values });
  for (let step = 0; step < hops; step++) {
    const before = header(probe, current);
    const previous = current;
    current = call(probe.exports, "__arr_grow", previous, before.capacity + 1);
    bounds(probe.memory, current, LINEAR_VECTOR_ELEMENTS_OFFSET + values.length * 8);
    const old = header(probe, previous);
    const fresh = header(probe, current);
    growth.push({ previous, current, request: before.capacity + 1, before, old, fresh });
    pointers.push(current);
    expect(current).not.toBe(previous);
    expect(old.tag).toBe(LINEAR_ARRAY_FORWARDING.tag);
    expect(old.link).toBe(current);
    expect(fresh.tag).toBe(1);
    expect(fresh.length).toBe(values.length);
    expect(fresh.elements).toEqual(values);
  }
  const sentinel = call(probe.exports, "__malloc", 32);
  bounds(probe.memory, sentinel, 32);
  new Uint8Array(probe.memory.buffer, sentinel, 32).fill(0x93);
  evidence.sentinel = { pointer: sentinel, bytes: Array.from(new Uint8Array(probe.memory.buffer, sentinel, 32)) };
  evidence.headers = pointers.map((pointer) => header(probe, pointer));
  expect(pointers).toHaveLength(hops + 1);
  return { pointers, current, values };
}
async function readChain(hops: number, evidence: Evidence, imports = false) {
  const probe = await runtimeInstance(evidence, false, imports);
  const built = chain(probe, hops, evidence);
  const before = probe.snapshot();
  const reads: object[] = [];
  Object.assign(evidence, {
    phase: "read-only forwarding",
    before: before.witness,
    reads,
    expectedReads: built.pointers.length * 3,
  });
  try {
    for (let round = 0; round < 3; round++)
      for (const pointer of built.pointers) {
        const resolved = call(probe.exports, "__arr_resolve", pointer);
        const length = call(probe.exports, "__arr_len", pointer);
        const values = built.values.map((_value, index) => call(probe.exports, "__arr_get", pointer, index));
        reads.push({ pointer, round, resolved, length, values });
        expect(resolved).toBe(built.current);
        expect(length).toBe(2);
        expect(values).toEqual(built.values);
      }
  } finally {
    evidence.after = probe.snapshot().witness;
    evidence.importedCalls = probe.importedCalls();
  }
  const after = probe.snapshot();
  expect(after.bytes).toEqual(before.bytes);
  expect(after.witness).toEqual(before.witness);
  expect(reads).toHaveLength(built.pointers.length * 3);
  expect(probe.importedCalls()).toEqual({ namesakeCalls: 0, decoyCalls: 0 });
  for (const [position, pointer] of built.pointers.entries()) {
    const current = header(probe, pointer);
    expect(current.tag).toBe(position === hops ? 1 : LINEAR_ARRAY_FORWARDING.tag);
    if (position < hops) expect(current.link).toBe(built.pointers[position + 1]);
  }
  if (imports) {
    const resolver = defined(probe.module, "__arr_resolve");
    expect(resolver.imports).toBe(2);
    expect(probe.module.imports.filter((entry) => entry.desc.kind === "table")).toHaveLength(1);
    expect(resolver.index).toBeGreaterThan(1);
    const exported = probe.module.exports.find((entry) => entry.name === "__arr_resolve");
    if (!exported) throw new Error("missing actual resolver export");
    expect(probe.module.functions[resolveLayout(probe.module).func(exported.desc.index) - resolver.imports]).toBe(
      resolver.fn,
    );
    expect(resolver.fn.body).toEqual(EXPECTED_BODY);
  }
}
function mutableInventory(value: unknown, objects = new Set<object>(), aliases = { count: 0 }) {
  if (value !== null && typeof value === "object") {
    if (objects.has(value)) {
      aliases.count++;
      return { objects, aliases: aliases.count };
    }
    objects.add(value);
    for (const child of Object.values(value)) mutableInventory(child, objects, aliases);
  }
  return { objects, aliases: aliases.count };
}
async function registration(order: "array" | "u8", evidence: Evidence) {
  const module = createEmptyModule();
  runtime.addRuntime(module);
  const first = order === "array" ? runtime.addArrayRuntime : runtime.addUint8ArrayRuntime;
  const second = order === "array" ? runtime.addUint8ArrayRuntime : runtime.addArrayRuntime;
  first(module);
  const original = defined(module, "__arr_resolve");
  const type = module.types[original.fn.typeIdx];
  const beforeBody = structuredClone(original.fn.body);
  const stages: object[] = [];
  evidence.stages = stages;
  for (const build of [second, first, second]) {
    build(module);
    const current = defined(module, "__arr_resolve");
    stages.push({
      helper: helperWitness(module),
      functions: module.functions.map((fn) => ({ name: fn.name, typeIdx: fn.typeIdx })),
      typeNames: module.types.map((entry) => (entry.kind === "rec" ? null : (entry.name ?? null))),
    });
    expect(current.fn).toBe(original.fn);
    expect(current.index).toBe(original.index);
    expect(module.types[current.fn.typeIdx]).toBe(type);
    expect(current.fn.body).toEqual(beforeBody);
    expect(module.functions.filter((fn) => fn.name === "__arr_resolve")).toHaveLength(1);
    expect(module.types.filter((entry) => entry.kind !== "rec" && entry.name === "$type___arr_resolve")).toHaveLength(
      1,
    );
  }
  const artifact = binaryArtifact(emitBinary(module));
  Object.assign(evidence, {
    phase: "resolver-only idempotence",
    order,
    artifact: artifact.witness,
    helper: helperWitness(module),
    wholeBuilderIdempotenceClaimed: false,
  });
  expect(artifact.witness.valid).toBe(true);
}

describe("issue 6914 actual forwarding provider exact preservation", () => {
  for (const entry of SOURCES)
    it(entry.id, async () =>
      observation(entry.id, "compiler-IR", async (evidence) => {
        await sourceCase(entry, evidence);
      }),
    );
  it("source-import-custody", async () =>
    observation("source-import-custody", "compiler-IR-imports", async (evidence) => {
      const native = () => {
        const a = [1.5];
        a[31] = 3.75;
        return a[31];
      };
      Object.assign(evidence, {
        phase: "typed compiler generation",
        source: IMPORT_SOURCE,
        options: IMPORT_OPTIONS,
        native: native(),
        expected: 3.75,
        flag: process.env.JS2WASM_LINEAR_IR ?? null,
      });
      expect(native()).toBe(3.75);
      const module = linearCodegen.generateLinearModule(analyzeSource(IMPORT_SOURCE), IMPORT_OPTIONS);
      assertCaller(module, "test", evidence);
      const artifact = binaryArtifact(emitBinary(module));
      Object.assign(evidence, { artifact: artifact.witness, imports: module.imports });
      expect(artifact.witness.valid).toBe(true);
      let namesakeCalls = 0;
      let unusedCalls = 0;
      const { instance } = await WebAssembly.instantiate(artifact.bytes, {
        probe: {
          unused: () => {
            unusedCalls++;
          },
          __arr_resolve: (pointer: number) => {
            namesakeCalls++;
            return pointer;
          },
        },
      });
      evidence.actual = call(instance.exports, "test");
      evidence.importedCalls = { namesakeCalls, unusedCalls };
      expect(evidence.actual).toBe(3.75);
      expect(namesakeCalls).toBe(0);
      expect(unusedCalls).toBe(0);
    }));
  for (const [id, hops] of [
    ["resolve-zero-hop", 0],
    ["resolve-one-hop", 1],
    ["resolve-three-hop", 3],
  ] as const)
    it(id, async () =>
      observation(id, "runtime-read-only", async (evidence) => {
        await readChain(hops, evidence);
      }),
    );
  it("legacy-u8-forwarded", async () =>
    observation("legacy-u8-forwarded", "runtime-allocating-conversion", async (evidence) => {
      const probe = await runtimeInstance(evidence, true);
      const built = chain(probe, 1, evidence, [1, 2, 255]);
      const headers = built.pointers.map((pointer) => header(probe, pointer));
      const before = probe.snapshot();
      Object.assign(evidence, {
        phase: "allocating byte conversion",
        before: before.witness,
        allocationExpected: true,
        native: Array.from(new Uint8Array([1, 2, 255])),
      });
      const destination = call(probe.exports, "__u8arr_from_arr", built.pointers[0]);
      bounds(probe.memory, destination, 15);
      const length = call(probe.exports, "__u8arr_len", destination);
      const values = Array.from(new Uint8Array(probe.memory.buffer, destination + 12, 3));
      const after = probe.snapshot();
      Object.assign(evidence, {
        destination,
        length,
        values,
        after: after.witness,
        sourceHeadersAfter: built.pointers.map((pointer) => header(probe, pointer)),
      });
      expect(destination).not.toBe(built.current);
      expect(length).toBe(3);
      expect(values).toEqual([1, 2, 255]);
      expect(after.witness.used).toBeGreaterThan(before.witness.used);
      expect(after.witness.heap).toBeGreaterThan(before.witness.heap);
      expect(after.bytes).not.toEqual(before.bytes);
      expect(built.pointers.map((pointer) => header(probe, pointer))).toEqual(headers);
      for (const pointer of built.pointers)
        expect(Array.from(after.bytes.slice(pointer, pointer + LINEAR_VECTOR_ELEMENTS_OFFSET + 24))).toEqual(
          Array.from(before.bytes.slice(pointer, pointer + LINEAR_VECTOR_ELEMENTS_OFFSET + 24)),
        );
    }));
  for (const order of ["array", "u8"] as const)
    it(`registration-${order}-first`, async () =>
      observation(`registration-${order}-first`, "runtime-registration", async (evidence) => {
        await registration(order, evidence);
      }));
  it("installed-exact-body-abi", async () =>
    observation("installed-exact-body-abi", "runtime-structure", async (evidence) => {
      const module = runtimeModule();
      const witness = helperWitness(module);
      const artifact = binaryArtifact(emitBinary(module));
      let count = 0;
      walkInstructions(witness.body, () => {
        count++;
      });
      Object.assign(evidence, {
        phase: "full installed tree",
        helper: witness,
        artifact: artifact.witness,
        instructionCount: count,
      });
      expect(artifact.witness.valid).toBe(true);
      expect(witness.body).toEqual(EXPECTED_BODY);
      expect(count).toBe(12);
      expect(witness.name).toBe("__arr_resolve");
      expect(witness.type).toEqual({
        kind: "func",
        name: "$type___arr_resolve",
        params: [{ kind: "i32" }],
        results: [{ kind: "i32" }],
      });
      expect(witness.locals).toEqual([]);
      expect(witness.exported).toBe(false);
    }));
  it("import-offset-artifact", async () =>
    observation("import-offset-artifact", "runtime-imports", async (evidence) => {
      await readChain(3, evidence, true);
    }));
  it("fresh-object-custody", async () =>
    observation("fresh-object-custody", "runtime-deep-custody", async (evidence) => {
      const first = runtimeModule();
      const second = runtimeModule();
      const firstBody = defined(first, "__arr_resolve").fn.body;
      const secondBody = defined(second, "__arr_resolve").fn.body;
      const original = structuredClone(secondBody);
      const firstInventory = mutableInventory(firstBody);
      const secondInventory = mutableInventory(secondBody);
      const shared = [...firstInventory.objects].filter((node) => secondInventory.objects.has(node)).length;
      const firstArtifact = binaryArtifact(emitBinary(first));
      const secondArtifact = binaryArtifact(emitBinary(second));
      Object.assign(evidence, {
        phase: "deep mutable custody",
        first: {
          helper: structuredClone(helperWitness(first)),
          artifact: firstArtifact.witness,
          objects: firstInventory.objects.size,
          internalAliases: firstInventory.aliases,
        },
        second: {
          helper: helperWitness(second),
          artifact: secondArtifact.witness,
          objects: secondInventory.objects.size,
          internalAliases: secondInventory.aliases,
        },
        sharedObjects: shared,
      });
      expect(firstArtifact.witness.valid).toBe(true);
      expect(secondArtifact.witness.valid).toBe(true);
      expect(firstArtifact.witness).toEqual(secondArtifact.witness);
      expect(firstBody).toEqual(secondBody);
      expect(firstInventory.objects.size).toBe(17);
      expect(secondInventory.objects.size).toBe(17);
      expect(firstInventory.aliases).toBe(0);
      expect(secondInventory.aliases).toBe(0);
      expect(shared).toBe(0);
      const block = firstBody[0];
      if (block.op !== "block") throw new Error("missing genuine nested block");
      const loop = block.body[0];
      if (loop.op !== "loop") throw new Error("missing genuine nested loop");
      const load = loop.body.find((entry) => entry.op === "i32.load");
      if (!load || load.op !== "i32.load") throw new Error("missing nested pointer load");
      load.offset = 123;
      Object.assign(loop.blockType, { kind: "val", type: { kind: "i32" } });
      loop.body.push({ op: "nop" });
      const secondAfter = binaryArtifact(emitBinary(second));
      const third = runtimeModule();
      const thirdBody = defined(third, "__arr_resolve").fn.body;
      const thirdArtifact = binaryArtifact(emitBinary(third));
      const thirdInventory = mutableInventory(thirdBody);
      const thirdShared = [...thirdInventory.objects].filter(
        (node) => firstInventory.objects.has(node) || secondInventory.objects.has(node),
      ).length;
      Object.assign(evidence, {
        mutation: firstBody,
        unchangedSecond: secondBody,
        secondAfter: secondAfter.witness,
        third: {
          helper: helperWitness(third),
          artifact: thirdArtifact.witness,
          objects: thirdInventory.objects.size,
          internalAliases: thirdInventory.aliases,
          sharedObjects: thirdShared,
        },
      });
      expect(firstBody).not.toEqual(original);
      expect(secondBody).toEqual(original);
      expect(thirdBody).toEqual(original);
      expect(secondAfter.witness).toEqual(secondArtifact.witness);
      expect(thirdArtifact.witness).toEqual(secondArtifact.witness);
      expect(thirdArtifact.witness.valid).toBe(true);
      expect(thirdInventory.aliases).toBe(0);
      expect(thirdShared).toBe(0);
      expect(thirdInventory.objects.size).toBe(17);
    }));
});
