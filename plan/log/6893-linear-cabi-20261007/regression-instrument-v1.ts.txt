// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  emitCabiWrappers,
  mapResultToCabi,
  type CabiExportInfo,
  type TsSemanticType,
} from "../src/codegen-linear/c-abi.js";
import { addArrayRuntime, addRuntime, addStringRuntime } from "../src/codegen-linear/runtime.js";
import { emitBinary } from "../src/emit/binary.js";
import { extractCHeaderExports, generateCHeader } from "../src/emit/c-header.js";
import { resolveLayout, STABLE_FUNC_BASE } from "../src/emit/resolve-layout.js";
import { compile } from "../src/index.js";
import {
  LINEAR_ARRAY_FORWARDING,
  LINEAR_VECTOR_CAPACITY_OFFSET,
  LINEAR_VECTOR_ELEMENTS_OFFSET,
  LINEAR_VECTOR_LENGTH_OFFSET,
} from "../src/ir/analysis/linear-memory-plan.js";
import { getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";
import { createEmptyModule, type ValType, type WasmModule } from "../src/ir/types.js";

const TEST_PATH = "tests/issue-6893-linear-cabi-array-forwarding.test.ts";
const SOURCE_PATH = "src/codegen-linear/c-abi.ts";
const PUBLIC_OPTIONS = { target: "linear", abi: "c", optimize: false } as const;
const PROBE_RECORD = "plan/log/6893-linear-cabi-20261007/baseline-probes.json";
// Exact parent-preserved strings, not reconstructed substitutes for the probes.
const alias31 =
  "export function run(): number[] { const values=[1.5,-2.25]; const alias=values; alias[31]=3.75; return values; }";
const owned31 = "export function run(): number[] { const values=[1.5,-2.25]; values[31]=3.75; return values; }";
const scalarAlias31 =
  "export function run(): number { const values=[1.5,-2.25]; const alias=values; alias[31]=3.75; return values[31]; }";
const dense32 =
  "export function run(): number[] { const values=[1.5,-2.25]; const alias=values; for(let i=2;i<32;i++) alias[i]=i+0.25; return values; }";
const denseValues = (length: number) =>
  Array.from({ length }, (_, index) => (index === 0 ? 1.5 : index === 1 ? -2.25 : index + 0.25));

function record(kind: string, data: object) {
  console.log(JSON.stringify({ issue: 6893, kind, ...data }));
}

beforeAll(() => {
  const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  record("provenance", {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceSha256: digest(SOURCE_PATH),
    testSha256: digest(TEST_PATH),
    node: process.version,
    v8: process.versions.v8,
    execArgv: process.execArgv,
    nodeOptions: process.env.NODE_OPTIONS ?? "",
    lane: "linear",
    abi: "c",
    harness: TEST_PATH,
    publicOptions: PUBLIC_OPTIONS,
    flags: { JS2WASM_LINEAR_IR: "1" },
    originalProbeRecord: PROBE_RECORD,
  });
});
afterEach(() => vi.unstubAllEnvs());

/** Validate bounds before constructing any host payload view. Never trust an ABI length. */
function readArrayPair(memory: WebAssembly.Memory, pair: unknown) {
  expect(Array.isArray(pair)).toBe(true);
  if (!Array.isArray(pair) || pair.length !== 2) throw new Error("array export did not return a two-value C ABI pair");
  const [pointer, length] = pair as number[];
  expect(Number.isInteger(pointer)).toBe(true);
  expect(Number.isInteger(length)).toBe(true);
  expect(pointer).toBeGreaterThanOrEqual(0);
  expect(length).toBeGreaterThanOrEqual(0);
  expect(length).toBeLessThanOrEqual(128);
  expect(pointer % 8).toBe(0);
  expect(pointer + length * 8).toBeLessThanOrEqual(memory.buffer.byteLength);
  const elements = Array.from(new Float64Array(memory.buffer, pointer, length));
  return { pair: [pointer, length], elements };
}

async function publicFixture(caseId: string, source: string) {
  vi.stubEnv("JS2WASM_LINEAR_IR", "1");
  const result = await compile(source, PUBLIC_OPTIONS);
  const report = getLastLinearIrReport();
  const route = report
    ? {
        compiled: [...report.compiled],
        rejected: report.rejected,
        ownerEvidence: report.ownerEvidence,
        legacySlots: report.legacySlots,
        irAdmissionObserved: report.ownerEvidence.some(
          (owner) => owner.legacyName === "run" && owner.outcome === "compiled",
        ),
      }
    : null;
  record("public-compile", {
    caseId,
    source,
    options: PUBLIC_OPTIONS,
    success: result.success,
    errors: result.errors,
    route,
    cHeader: result.cHeader ?? null,
    valid: WebAssembly.validate(result.binary),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(report).toBeDefined();
  // Actual routing is evidence, not a requirement to preserve today's direct fallback.
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module);
  return { result, report, instance, route };
}

describe("issue 6893: public C ABI reproductions and controls", () => {
  it.each([
    ["alias31", alias31],
    ["owned31", owned31],
  ])("returns the grown sparse %s result without claiming hole parity", async (caseId, source) => {
    const fixture = await publicFixture(caseId, source);
    const actual = readArrayPair(
      fixture.instance.exports.memory as WebAssembly.Memory,
      (fixture.instance.exports.run as () => unknown)(),
    );
    record("public-array", {
      caseId,
      ...actual,
      route: fixture.route,
      sparse: true,
      expected: { length: 32, first: 1.5, second: -2.25, last: 3.75 },
      holeContentsAreNotParityEvidence: true,
    });
    expect.soft(actual.pair[1]).toBe(32);
    expect.soft(actual.elements[0]).toBe(1.5);
    expect.soft(actual.elements[1]).toBe(-2.25);
    expect.soft(actual.elements[31]).toBe(3.75);
    expect(fixture.result.cHeader).toContain("int32_t run(int32_t* out_0);");
  });

  it.each([32, 96])("returns every fractional slot from the dense %i-element growth fixture", async (length) => {
    const source = length === 32 ? dense32 : dense32.replace("i<32", "i<96");
    const fixture = await publicFixture(`dense${length}`, source);
    const actual = readArrayPair(
      fixture.instance.exports.memory as WebAssembly.Memory,
      (fixture.instance.exports.run as () => unknown)(),
    );
    const expected = denseValues(length);
    record("public-array", { caseId: `dense${length}`, ...actual, expected, route: fixture.route, sparse: false });
    expect.soft(actual.pair[1]).toBe(length);
    expect.soft(actual.elements).toEqual(expected);
    expect(fixture.result.cHeader).toContain("int32_t run(int32_t* out_0);");
  });

  it("keeps index 7 as an in-capacity control, not a growth reproduction", async () => {
    const source = alias31.replace("alias[31]", "alias[7]");
    const fixture = await publicFixture("alias7-derived-control", source);
    const actual = readArrayPair(
      fixture.instance.exports.memory as WebAssembly.Memory,
      (fixture.instance.exports.run as () => unknown)(),
    );
    record("public-array", {
      caseId: "alias7-derived-control",
      ...actual,
      route: fixture.route,
      growthReproduction: false,
    });
    expect(actual.pair[1]).toBe(8);
    expect(actual.elements[0]).toBe(1.5);
    expect(actual.elements[1]).toBe(-2.25);
    expect(actual.elements[7]).toBe(3.75);
  });

  it("retains the separately owned scalar IR read's correct 3.75 requirement", async () => {
    const fixture = await publicFixture("aliasScalar31-out-of-scope-A", scalarAlias31);
    const actual = (fixture.instance.exports.run as () => number)();
    record("public-scalar", {
      caseId: "aliasScalar31-out-of-scope-A",
      actual,
      expected: 3.75,
      route: fixture.route,
      fixOwner: "Session A shared IR reads; not this C ABI wrapper slice",
    });
    expect(fixture.report?.compiled).toContain("run");
    expect(actual).toBe(3.75); // Do not green-pin the observed baseline zero.
  });

  it("preserves the public UTF-8 string pair and C header", async () => {
    const fixture = await publicFixture("utf8-string", 'export function run(): string { return "é😀"; }');
    const [pointer, length] = (fixture.instance.exports.run as () => [number, number])();
    const memory = fixture.instance.exports.memory as WebAssembly.Memory;
    expect(pointer).toBeGreaterThanOrEqual(0);
    expect(length).toBe(6);
    expect(pointer + length).toBeLessThanOrEqual(memory.buffer.byteLength);
    const bytes = Array.from(new Uint8Array(memory.buffer, pointer, length));
    record("public-string", {
      pair: [pointer, length],
      bytes,
      text: new TextDecoder().decode(new Uint8Array(bytes)),
      cHeader: fixture.result.cHeader,
      route: fixture.route,
    });
    expect(bytes).toEqual(Array.from(new TextEncoder().encode("é😀")));
    expect(fixture.result.cHeader).toContain("int32_t run(int32_t* out_0);");
  });

  it("preserves public scalar signatures and direct fractional output", async () => {
    const fixture = await publicFixture(
      "scalar-control",
      "export function run(a: number, b: number): number { return a + b; }",
    );
    const actual = (fixture.instance.exports.run as (a: number, b: number) => number)(1.5, -2.25);
    record("public-scalar", {
      caseId: "scalar-control",
      actual,
      cHeader: fixture.result.cHeader,
      route: fixture.route,
    });
    expect(actual).toBe(-0.75);
    expect(fixture.result.cHeader).toContain("double run(double p0, double p1);");
  });
});

function functionIndex(module: WasmModule, name: string) {
  const localIndex = module.functions.findIndex((func) => func.name === name);
  if (localIndex < 0) throw new Error(`fixture runtime function missing: ${name}`);
  return module.imports.filter((entry) => entry.desc.kind === "func").length + localIndex;
}

function exportFunction(module: WasmModule, name: string, runtimeName = name) {
  module.exports.push({ name, desc: { kind: "func", index: functionIndex(module, runtimeName) } });
}

/** Raw header identity with a direct scalar argument: no array-param rehydration. */
function addIdentityExport(module: WasmModule, semantic: TsSemanticType, stable = false): CabiExportInfo {
  const wasmType: ValType = { kind: semantic === "number_f64" ? "f64" : "i32" };
  const typeIdx = module.types.length;
  module.types.push({ kind: "func", params: [wasmType], results: [wasmType] });
  const position = module.functions.length;
  module.functions.push({
    name: "raw_header_identity",
    typeIdx,
    locals: [],
    body: [{ op: "local.get", index: 0 }],
    exported: false,
  });
  // Reuse the recorded ordinal->position fixture from issue-1916, not a new handle regime.
  if (stable) module.funcOrdinalToPosition.push(position);
  module.exports.push({
    name: "raw",
    desc: { kind: "func", index: stable ? STABLE_FUNC_BASE : functionIndex(module, "raw_header_identity") },
  });
  return {
    tsName: "raw",
    cabiName: "wrapped",
    params: [{ name: "header", wasmType, sourceParamIdx: 0, role: "direct" }],
    result: mapResultToCabi(wasmType, semantic),
  };
}

type ArrayRuntimeExports = {
  memory: WebAssembly.Memory;
  wrapped: (raw: number) => [number, number];
  newArray: (capacity: number) => number;
  set: (raw: number, index: number, value: number) => void;
  resolve: (raw: number) => number;
  malloc: (size: number) => number;
  used: () => number;
};

async function runtimeFixture(imports = false, stable = false) {
  const module = createEmptyModule();
  const hostCalls: string[] = [];
  let hostImports: WebAssembly.Imports = {};
  if (imports) {
    const typeIdx = module.types.length;
    module.types.push({ kind: "func", params: [{ kind: "i32" }], results: [{ kind: "i32" }] });
    module.imports.push({ module: "host", name: "decoy", desc: { kind: "func", typeIdx } });
    module.imports.push({ module: "host", name: "table", desc: { kind: "table", elementType: "funcref", min: 1 } });
    module.imports.push({ module: "host", name: "ping", desc: { kind: "func", typeIdx } });
    hostImports = {
      host: {
        decoy: () => {
          hostCalls.push("decoy");
          throw new Error("wrong resolver index called host decoy");
        },
        ping: (value: number) => {
          hostCalls.push("ping");
          return value + 17;
        },
        table: new WebAssembly.Table({ element: "anyfunc", initial: 1 }),
      },
    };
    module.exports.push({ name: "decoyProbe", desc: { kind: "func", index: 0 } });
    module.exports.push({ name: "pingProbe", desc: { kind: "func", index: 1 } });
  }
  addRuntime(module, { exposeArenaReset: true });
  addArrayRuntime(module);
  const info = addIdentityExport(module, "array", stable);
  for (const [name, runtimeName] of [
    ["newArray", "__arr_new"],
    ["set", "__arr_set"],
    ["resolve", "__arr_resolve"],
    ["malloc", "__malloc"],
    ["used", "__arena_used"],
  ])
    exportFunction(module, name, runtimeName);
  emitCabiWrappers(module, [info]);
  const binary = emitBinary(module);
  expect(WebAssembly.validate(binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(binary, hostImports);
  return {
    module,
    exports: instance.exports as unknown as ArrayRuntimeExports,
    allExports: instance.exports,
    hostCalls,
    info,
  };
}

function snapshot(memory: WebAssembly.Memory) {
  return Array.from(new Uint8Array(memory.buffer));
}

async function exerciseGrowth(imports: boolean, stable: boolean) {
  const fixture = await runtimeFixture(imports, stable);
  const runtime = fixture.exports;
  if (imports) {
    expect((fixture.allExports.pingProbe as (value: number) => number)(25)).toBe(42);
    expect(() => (fixture.allExports.decoyProbe as (value: number) => number)(0)).toThrow(/wrong resolver index/);
    fixture.hostCalls.length = 0;
  }
  const original = runtime.newArray(1);
  const headers = [original];
  let current = original;
  const expected = denseValues(96);
  for (let index = 0; index < expected.length; index++) {
    runtime.set(original, index, expected[index]);
    // Observe transition only from the previously current header and shared
    // tag/pointer fields. Do not pre-resolve the original wrapper argument.
    const view = new DataView(runtime.memory.buffer);
    if (view.getUint8(current + LINEAR_ARRAY_FORWARDING.tagOffset) === LINEAR_ARRAY_FORWARDING.tag) {
      current = view.getUint32(current + LINEAR_ARRAY_FORWARDING.pointerOffset, true);
      headers.push(current);
    }
  }
  expect(headers.length).toBeGreaterThanOrEqual(3);
  expect(new Set(headers).size).toBe(headers.length);
  const finalView = new DataView(runtime.memory.buffer);
  const links = headers.slice(0, -1).map((header, index) => {
    const tag = finalView.getUint8(header + LINEAR_ARRAY_FORWARDING.tagOffset);
    const next = finalView.getUint32(header + LINEAR_ARRAY_FORWARDING.pointerOffset, true);
    expect(tag).toBe(LINEAR_ARRAY_FORWARDING.tag);
    expect(next).toBe(headers[index + 1]);
    return { header, tag, next };
  });
  const capacity = finalView.getUint32(current + LINEAR_VECTOR_CAPACITY_OFFSET, true);
  expect(finalView.getUint32(current + LINEAR_VECTOR_LENGTH_OFFSET, true)).toBe(96);
  expect(capacity).toBeGreaterThanOrEqual(96);
  const sentinel = runtime.malloc(32);
  new Uint8Array(runtime.memory.buffer, sentinel, 32).fill(0x9b);
  const before = snapshot(runtime.memory);
  const usedBefore = runtime.used();
  // This is the first invocation of the wrapper. Its argument is the raw oldest header.
  const actual = readArrayPair(runtime.memory, runtime.wrapped(original));
  const afterOldest = snapshot(runtime.memory);
  const usedAfterOldest = runtime.used();
  const alreadyCurrent = readArrayPair(runtime.memory, runtime.wrapped(current));
  const afterCurrent = snapshot(runtime.memory);
  record("runtime-growth", {
    imports,
    stable,
    contract: LINEAR_ARRAY_FORWARDING,
    original,
    current,
    headers,
    links,
    capacity,
    actual,
    alreadyCurrent,
    expected,
    sentinel,
    before,
    afterOldest,
    afterCurrent,
    usedBefore,
    usedAfterOldest,
    usedAfterCurrent: runtime.used(),
    hostCalls: fixture.hostCalls,
    sourceIrAdmissionProof: false,
  });
  expect.soft(actual.pair).toEqual([current + LINEAR_VECTOR_ELEMENTS_OFFSET, 96]);
  expect.soft(actual.elements).toEqual(expected);
  expect.soft(actual.pair[1]).toBeLessThanOrEqual(capacity);
  expect(alreadyCurrent.pair).toEqual([current + LINEAR_VECTOR_ELEMENTS_OFFSET, 96]);
  expect(alreadyCurrent.elements).toEqual(expected);
  expect(afterOldest).toEqual(before);
  expect(afterCurrent).toEqual(before);
  expect(usedAfterOldest).toBe(usedBefore);
  expect(runtime.used()).toBe(usedBefore);
  expect(runtime.resolve(original)).toBe(current); // Only after raw wrapper evidence.
  expect(fixture.hostCalls).toEqual([]);

  const wrapper = fixture.module.functions.find((func) => func.name === "__cabi_wrapped")!;
  const layout = resolveLayout(fixture.module);
  const importCount = fixture.module.imports.filter((entry) => entry.desc.kind === "func").length;
  const calls = wrapper.body.filter((instruction) => instruction.op === "call");
  const targets = calls.map((instruction) => {
    const index = layout.func(instruction.funcIdx);
    return { index, name: index < importCount ? "IMPORT" : fixture.module.functions[index - importCount]?.name };
  });
  const signature = fixture.module.types[wrapper.typeIdx];
  const exports = extractCHeaderExports(fixture.module).filter((entry) => entry.name === "wrapped");
  record("wrapper-contract", {
    imports,
    stable,
    targets,
    body: wrapper.body,
    locals: wrapper.locals,
    signature,
    cHeader: generateCHeader("issue6893", exports),
  });
  expect(targets.map((target) => target.name)).toEqual(["raw_header_identity", "__arr_resolve"]);
  expect(wrapper.body).toEqual([
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: functionIndex(fixture.module, "raw_header_identity") },
    { op: "call", funcIdx: functionIndex(fixture.module, "__arr_resolve") },
    { op: "local.tee", index: 1 },
    { op: "i32.const", value: 16 },
    { op: "i32.add" },
    { op: "local.get", index: 1 },
    { op: "i32.load", align: 2, offset: 8 },
  ]);
  expect(wrapper.locals).toEqual([{ name: "__ret_ptr", type: { kind: "i32" } }]);
  expect(signature).toMatchObject({
    kind: "func",
    params: [{ kind: "i32" }],
    results: [{ kind: "i32" }, { kind: "i32" }],
  });
  expect(generateCHeader("issue6893", exports)).toContain("int32_t wrapped(int32_t p0, int32_t* out_0);");
}

describe("issue 6893: actual runtime forwarding and wrapper custody", () => {
  it.each([
    [false, false],
    [true, false],
    [true, true],
  ])("resolves real multi-hop growth (imports=%s, stable=%s)", async (imports, stable) => {
    await exerciseGrowth(imports, stable);
  });

  it.each([{ values: [] }, { values: [1.5, -2.25, 3.75] }])(
    "retains the current empty/no-growth fractional array $values",
    async ({ values }) => {
      const fixture = await runtimeFixture();
      const raw = fixture.exports.newArray(16);
      values.forEach((value, index) => fixture.exports.set(raw, index, value));
      const before = snapshot(fixture.exports.memory);
      const usedBefore = fixture.exports.used();
      const actual = readArrayPair(fixture.exports.memory, fixture.exports.wrapped(raw));
      const after = snapshot(fixture.exports.memory);
      record("runtime-no-growth", {
        values,
        raw,
        actual,
        usedBefore,
        usedAfter: fixture.exports.used(),
        before,
        after,
      });
      expect(actual.pair).toEqual([raw + LINEAR_VECTOR_ELEMENTS_OFFSET, values.length]);
      expect(actual.elements).toEqual(values);
      expect(after).toEqual(before);
      expect(fixture.exports.used()).toBe(usedBefore);
    },
  );

  it("fails closed with a named missing-resolver error for an array return only", () => {
    const module = createEmptyModule();
    addRuntime(module);
    const info = addIdentityExport(module, "array");
    let failure: unknown;
    try {
      emitCabiWrappers(module, [info]);
    } catch (error) {
      failure = error;
    }
    record("missing-resolver", {
      failure: failure instanceof Error ? { name: failure.name, message: failure.message } : null,
    });
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(/C.?ABI.*array.*return/i);
    expect(message).toContain("__arr_resolve");
    expect(message).toMatch(/raw|wrapped/);
  });

  it.each(["string", "number_f64"] as const)("emits and executes %s without any resolver", async (semantic) => {
    const module = createEmptyModule();
    addRuntime(module, { exposeArenaReset: true });
    if (semantic === "string") addStringRuntime(module);
    expect(module.functions.some((func) => func.name === "__arr_resolve")).toBe(false);
    const info = addIdentityExport(module, semantic);
    if (semantic === "string") exportFunction(module, "fromData", "__str_from_data");
    emitCabiWrappers(module, [info]);
    const signatures = extractCHeaderExports(module).filter((entry) => entry.name === "wrapped");
    const cHeader = generateCHeader("issue6893", signatures);
    const binary = emitBinary(module);
    expect(WebAssembly.validate(binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(binary);
    if (semantic === "string") {
      const memory = instance.exports.memory as WebAssembly.Memory;
      const bytes = new TextEncoder().encode("é😀");
      new Uint8Array(memory.buffer).set(bytes, 64);
      const raw = (instance.exports.fromData as (pointer: number, length: number) => number)(64, bytes.length);
      const before = snapshot(memory);
      const actual = (instance.exports.wrapped as (pointer: number) => [number, number])(raw);
      expect(actual).toEqual([raw + 12, bytes.length]);
      const outputBytes = Array.from(new Uint8Array(memory.buffer, actual[0], actual[1]));
      const after = snapshot(memory);
      record("no-resolver-string", { raw, actual, outputBytes, before, after, signatures, cHeader });
      expect(outputBytes).toEqual(Array.from(bytes));
      expect(after).toEqual(before);
      expect(cHeader).toContain("int32_t wrapped(int32_t p0, int32_t* out_0);");
    } else {
      const actual = (instance.exports.wrapped as (value: number) => number)(3.75);
      record("no-resolver-scalar", { actual, signatures, cHeader });
      expect(actual).toBe(3.75);
      expect(cHeader).toContain("double wrapped(double p0);");
    }
  });
});
