// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as linearCodegen from "../src/codegen-linear/index.js";
import * as runtime from "../src/codegen-linear/runtime.js";
import { walkInstructions } from "../src/codegen/walk-instructions.js";
import { emitBinary } from "../src/emit/binary.js";
import { resolveLayout } from "../src/emit/resolve-layout.js";
import { compile } from "../src/index.js";
import * as overlay from "../src/ir/backend/linear-integration.js";
import { LINEAR_STRING_ELEMENTS_OFFSET, LINEAR_STRING_LENGTH_OFFSET } from "../src/ir/analysis/linear-memory-plan.js";
import { createEmptyModule, type Instr, type WasmModule } from "../src/ir/types.js";
import { buildCompiledAdapterImports, instantiateWasm } from "../src/runtime.js";

const SOURCE = `export function at(i:number):number {
  const s="Ab9~"; return s.charCodeAt(i); }`;
const OPTIONS = {
  moduleName: "issue-6911.ts",
  target: "linear",
  optimize: false,
  sourceMap: false,
  experimentalIR: false,
  disableIrFirst: true,
} as const;
const TEST_PATH = "tests/issue-6911-linear-ir-char-code-at-provider-body.test.ts";
const HELPER = runtime.LINEAR_IR_STRING_CHAR_CODE_AT_FN;
const SCRATCH = 512;
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const tag = (value: number) =>
  Number.isNaN(value) ? { kind: "nan" } : { kind: "number", value: Object.is(value, -0) ? "-0" : value };
const MATRIX = [
  { id: "ascii", text: "Ab9~", indices: [-1, -0, 0, 1, 2, 3, 4, 5], units: [65, 98, 57, 126] },
  { id: "bmp", text: "aéb€c", indices: [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9], units: [97, 233, 98, 8364, 99] },
  { id: "ascii-tail", text: "abcé", indices: [-1, 0, 1, 2, 3, 4, 5, 6], units: [97, 98, 99, 233] },
  { id: "astral", text: "a😀b", indices: [-1, 0, 1, 2, 3, 4, 5, 6, 7], units: [97, 0xd83d, 0xde00, 98] },
  { id: "empty", text: "", indices: [-1, 0, 1], units: [] },
  { id: "extremes", text: "Ab9~", indices: [-2147483648, 2147483647], units: [65, 98, 57, 126] },
];
type Evidence = { phase: string; [key: string]: unknown };
const observed = new Set<string>();
function record(kind: string, data: object) {
  const line = JSON.stringify({ issue: 6911, schemaVersion: 1, kind, ...data }, (_key, value) => {
    if (typeof value === "number" && (Number.isNaN(value) || Object.is(value, -0))) return tag(value);
    if (value instanceof Error) return { name: value.name, message: value.message };
    return value;
  });
  console.log(line);
  const path = process.env.JS2WASM_CHAR_CODE_AT_OBSERVATIONS;
  if (path) appendFileSync(path, `${line}\n`);
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
    if (Array.isArray(evidence.cases)) evidence.caseCount = evidence.cases.length;
    const duplicate = observed.has(id);
    observed.add(id);
    record("observation", {
      id,
      lane,
      status: passed ? "passed" : "failed",
      duplicate,
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
    baseline: "6c88d157444ea4ae377a7ef1b82b15ef2f4f6603",
    runtimeSha256: sha256(readFileSync("src/codegen-linear/runtime.ts")),
    testSha256: sha256(readFileSync(TEST_PATH)),
    source: SOURCE,
    sourceSha256: sha256(SOURCE),
    options: OPTIONS,
    node: process.version,
    v8: process.versions.v8,
    execArgv: process.execArgv,
    nodeOptions: process.env.NODE_OPTIONS ?? "",
    expectedRows: 10,
    nativeCases: 41,
  }),
);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(() => {
  record("population", { count: observed.size, expected: 10, ids: [...observed] });
  expect(observed.size).toBe(10);
});

function defined(module: WasmModule, name: string) {
  const position = module.functions.findIndex((fn) => fn.name === name);
  if (position < 0) throw new Error(`missing actual defined ${name}`);
  const imports = module.imports.filter((entry) => entry.desc.kind === "func").length;
  return { fn: module.functions[position], index: imports + position, imports };
}
function calls(body: Instr[]) {
  const entries: Extract<Instr, { op: "call" }>[] = [];
  walkInstructions(body, (instruction) => {
    if (instruction.op === "call") entries.push(instruction);
  });
  return entries;
}
function artifact(binary: Uint8Array) {
  const bytes = new Uint8Array(binary);
  const valid = WebAssembly.validate(bytes);
  const witness = {
    binaryBase64: Buffer.from(binary).toString("base64"),
    sha256: sha256(binary),
    byteLength: binary.byteLength,
    valid,
  };
  return { bytes, witness };
}
function fixture(prefix = false) {
  const module = createEmptyModule();
  if (prefix) {
    module.types.push(
      { kind: "func", params: [], results: [] },
      { kind: "func", params: [{ kind: "i32" }], results: [{ kind: "i32" }] },
    );
    module.imports.push(
      { module: "issue6911", name: "harmless", desc: { kind: "func", typeIdx: 0 } },
      { module: "issue6911", name: "__str_is_ascii", desc: { kind: "func", typeIdx: 1 } },
    );
  }
  runtime.addRuntime(module, { exposeArenaReset: true });
  runtime.addUint8ArrayRuntime(module);
  runtime.addArrayRuntime(module);
  runtime.addStringRuntime(module);
  runtime.addLinearIrStringRuntime(module);
  for (const name of [HELPER, "__str_from_data", "__malloc"])
    module.exports.push({ name, desc: { kind: "func", index: defined(module, name).index } });
  const heap = module.globals.findIndex((entry) => entry.name === "__heap_ptr");
  if (heap < 0) throw new Error("missing actual heap global");
  module.exports.push({ name: "heap", desc: { kind: "global", index: heap } });
  return { module, helper: defined(module, HELPER).fn };
}
function numberCall(exports: WebAssembly.Exports, name: string, ...args: number[]): number {
  const fn = exports[name];
  if (typeof fn !== "function") throw new Error(`missing exported function ${name}`);
  const value: unknown = fn(...args);
  if (typeof value !== "number") throw new Error(`${name} returned non-number`);
  return value;
}
async function runtimeProbe(text: string, evidence: Evidence, prefix = false) {
  const current = fixture(prefix);
  const utf8 = new TextEncoder().encode(text);
  expect(utf8.length).toBeLessThan(128);
  current.module.dataSegments.push({ offset: SCRATCH, bytes: utf8 });
  const output = artifact(emitBinary(current.module));
  evidence.artifact = output.witness;
  expect(output.witness.valid).toBe(true);
  const compiled = new WebAssembly.Module(output.bytes);
  evidence.imports = WebAssembly.Module.imports(compiled);
  let namesakeCalls = 0;
  let harmlessCalls = 0;
  const instance = await WebAssembly.instantiate(
    compiled,
    prefix
      ? {
          issue6911: {
            harmless: () => {
              harmlessCalls++;
            },
            __str_is_ascii: () => {
              namesakeCalls++;
              throw new Error("imported ASCII namesake must not be called");
            },
          },
        }
      : {},
  );
  const memory = instance.exports.memory;
  const heap = instance.exports.heap;
  if (!(memory instanceof WebAssembly.Memory) || !(heap instanceof WebAssembly.Global))
    throw new Error("missing real runtime memory/heap");
  const pointer = numberCall(instance.exports, "__str_from_data", SCRATCH, utf8.length);
  const neighbor = numberCall(instance.exports, "__malloc", 32);
  evidence.allocation = { pointer, neighbor, memoryBytes: memory.buffer.byteLength, byteLength: utf8.length };
  for (const [offset, length] of [
    [pointer, LINEAR_STRING_ELEMENTS_OFFSET + utf8.length],
    [neighbor, 32],
  ]) {
    expect(Number.isInteger(offset)).toBe(true);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset % 8).toBe(0);
    expect(offset + length).toBeLessThanOrEqual(memory.buffer.byteLength);
  }
  new Uint8Array(memory.buffer, neighbor, 32).fill(0x93);
  const view = new DataView(memory.buffer);
  expect(view.getUint32(pointer + LINEAR_STRING_LENGTH_OFFSET, true)).toBe(utf8.length);
  expect(Array.from(new Uint8Array(memory.buffer, pointer + LINEAR_STRING_ELEMENTS_OFFSET, utf8.length))).toEqual(
    Array.from(utf8),
  );
  const snapshot = () => {
    const bytes = new Uint8Array(memory.buffer).slice();
    return {
      bytes,
      state: {
        heap: Number(heap.value),
        used: numberCall(instance.exports, "__arena_used"),
        memoryBytes: bytes.length,
        sha256: sha256(bytes),
        cache: bytes[pointer + 1],
        header: Array.from(bytes.slice(pointer, pointer + LINEAR_STRING_ELEMENTS_OFFSET)),
        payload: Array.from(
          bytes.slice(pointer + LINEAR_STRING_ELEMENTS_OFFSET, pointer + LINEAR_STRING_ELEMENTS_OFFSET + utf8.length),
        ),
        neighbor: Array.from(bytes.slice(neighbor, neighbor + 32)),
      },
    };
  };
  evidence.construction = {
    text,
    utf8: Array.from(utf8),
    byteLength: utf8.length,
    utf16Length: text.length,
    pointer,
    neighbor,
    state: snapshot().state,
  };
  return {
    ...current,
    pointer,
    snapshot,
    at: (index: number) => numberCall(instance.exports, HELPER, pointer, index),
    importedCalls: () => ({ namesakeCalls, harmlessCalls }),
  };
}
type CaseObservation = {
  text: string;
  index: ReturnType<typeof tag>;
  expected: ReturnType<typeof tag>;
  actual: ReturnType<typeof tag>;
  round: number;
  cacheBefore?: number;
  cacheAfter?: number;
};
async function checkRuntime(entries: typeof MATRIX, expectedCount: number, evidence: Evidence, rounds = 1) {
  const cases: CaseObservation[] = [];
  const allocations: object[] = [];
  Object.assign(evidence, {
    cases,
    allocations,
    expectedCaseCount: expectedCount,
    scope: "runtime-unit-only-not-Unicode-source-admission",
  });
  for (const entry of entries) {
    const arm: Evidence = { phase: "runtime construction" };
    allocations.push(arm);
    const probe = await runtimeProbe(entry.text, arm);
    const before = probe.snapshot();
    arm.before = before.state;
    expect(before.state.cache).toBe(0);
    try {
      for (let round = 0; round < rounds; round++)
        for (const index of entry.indices) {
          const expected = entry.text.charCodeAt(index);
          const cacheBefore = probe.snapshot().state.cache;
          const actual = probe.at(index);
          const cacheAfter = probe.snapshot().state.cache;
          cases.push({
            text: entry.text,
            index: tag(index),
            expected: tag(expected),
            actual: tag(actual),
            round,
            cacheBefore,
            cacheAfter,
          });
          expect(tag(actual)).toEqual(tag(expected));
        }
    } finally {
      arm.after = probe.snapshot().state;
    }
    const after = probe.snapshot();
    arm.after = after.state;
    expect(after.state.used).toBe(before.state.used);
    expect(after.state.heap).toBe(before.state.heap);
    expect(after.state.memoryBytes).toBe(before.state.memoryBytes);
    const expectedBytes = before.bytes.slice();
    expectedBytes[probe.pointer + 1] = after.state.cache;
    expect(after.bytes).toEqual(expectedBytes);
    if (entry.indices.some((index) => index >= 0 && index < entry.text.length))
      expect(after.state.cache).toBe(entry.id === "ascii" ? 1 : 2);
  }
  evidence.caseCount = cases.length;
  expect(cases).toHaveLength(expectedCount);
}
function mutableObjects(value: unknown, objects = new Set<object>()): Set<object> {
  if (value !== null && typeof value === "object" && !objects.has(value)) {
    objects.add(value);
    for (const child of Object.values(value)) mutableObjects(child, objects);
  }
  return objects;
}

describe("issue 6911 exact charCodeAt provider preservation", () => {
  it("independently observes every finite native JavaScript case", async () =>
    observation("native", "native-JS", async (evidence) => {
      const cases = MATRIX.flatMap((entry) =>
        entry.indices.map((index) => ({
          text: entry.text,
          index: tag(index),
          expected: tag(index < 0 || index >= entry.units.length ? NaN : entry.units[index]),
          actual: tag(entry.text.charCodeAt(index)),
        })),
      );
      Object.assign(evidence, { phase: "native oracle", cases, caseCount: cases.length, expectedCaseCount: 41 });
      expect(cases).toHaveLength(41);
      for (const entry of cases) expect(entry.actual).toEqual(entry.expected);
      expect(tag(-0)).toEqual({ kind: "number", value: "-0" });
    }));

  it("proves the actual ASCII source owner calls this compilation's provider", async () =>
    observation("source-ascii", "production-source-overlay", async (evidence) => {
      const hadFlag = Object.hasOwn(process.env, "JS2WASM_LINEAR_IR");
      const previous = process.env.JS2WASM_LINEAR_IR;
      const generate = vi.spyOn(linearCodegen, "generateLinearModule");
      const prepare = vi.spyOn(overlay, "prepareLinearIrOverlay");
      const emit = vi.spyOn(overlay, "compileLinearIr");
      const register = vi.spyOn(runtime, "addLinearIrStringRuntime");
      try {
        vi.stubEnv("JS2WASM_LINEAR_IR", "1");
        Object.assign(evidence, {
          phase: "source compilation",
          source: SOURCE,
          sourceSha256: sha256(SOURCE),
          options: OPTIONS,
          expectedCaseCount: 5,
          flag: process.env.JS2WASM_LINEAR_IR,
        });
        const result = await compile(SOURCE, OPTIONS);
        evidence.compile = { success: result.success, errors: result.errors };
        const output = artifact(result.binary);
        evidence.artifact = output.witness;
        const emitted = emit.mock.results[0];
        if (emitted?.type === "return")
          evidence.admission = {
            compiled: emitted.value.compiled,
            rejected: emitted.value.rejected,
            ownerEvidence: emitted.value.ownerEvidence,
          };
        expect(result.success, JSON.stringify(result.errors)).toBe(true);
        for (const spy of [generate, prepare, emit, register]) expect(spy).toHaveBeenCalledOnce();
        const generated = generate.mock.results[0];
        const prepared = prepare.mock.results[0];
        if (generated?.type !== "return" || prepared?.type !== "return" || emitted?.type !== "return")
          throw new Error("missing real compilation receipts");
        const module = generated.value;
        const context = prepare.mock.calls[0][0];
        expect(context.mod).toBe(module);
        expect(register.mock.calls[0][0]).toBe(module);
        expect(prepared.value.context).toBe(context);
        expect(prepared.value.sourceFile).toBe(prepare.mock.calls[0][1]);
        expect(prepared.value.sourceFile.text).toBe(SOURCE);
        expect(emit.mock.calls[0][0]).toBe(context);
        expect(emit.mock.calls[0][3]).toBe(prepared.value);
        expect(emitted.value.compiled).toEqual(["at"]);
        expect(emitted.value.rejected).toEqual([]);
        const owners = emitted.value.ownerEvidence.filter((owner) => owner.outcome === "compiled");
        expect(owners).toHaveLength(1);
        const owner = owners[0];
        const body = emitted.value.funcs.get(owner.ownerUnitId);
        if (!body) throw new Error("no actual admitted ASCII body");
        expect(module.functions).toContain(body);
        expect(body.name).toBe("at");
        const slot = emitted.value.legacySlots.find((entry) => entry.ownerUnitId === owner.ownerUnitId);
        if (!slot) throw new Error("no exact admitted slot");
        const declaration = emit.mock.calls[0][2].find((entry) => entry.funcIdx === slot.funcIdx)?.declaration;
        expect(declaration).toBeDefined();
        expect(declaration).toBe(
          prepared.value.ownerIndex.owners.find((entry) => entry.ownerUnitId === owner.ownerUnitId)?.declaration,
        );
        const provider = defined(module, HELPER);
        const layout = resolveLayout(module);
        const providerCalls = calls(body.body).filter(
          (entry) => module.functions[layout.func(entry.funcIdx) - provider.imports] === provider.fn,
        );
        expect(providerCalls).toHaveLength(1);
        const exported = module.exports.find((entry) => entry.name === "at");
        if (!exported || exported.desc.kind !== "func") throw new Error("missing actual at export");
        expect(module.functions[layout.func(exported.desc.index) - provider.imports]).toBe(body);
        evidence.binding = {
          ownerUnitId: owner.ownerUnitId,
          slot,
          providerIndex: provider.index,
          providerName: provider.fn.name,
          providerCalls,
          body: body.body,
          signature: module.types[provider.fn.typeIdx],
          locals: provider.fn.locals,
          exactContextModule: true,
          exactPreparedIdentity: true,
          exactAdmittedBody: true,
        };
        expect(output.witness.valid).toBe(true);
        if (!result.adapterManifest) throw new Error("missing compiler adapter manifest");
        const imports = buildCompiledAdapterImports(result.adapterManifest);
        const { instance } = await instantiateWasm(
          output.bytes,
          imports.env,
          imports.string_constants,
          imports.string_constants16,
        );
        imports.setInstance?.(instance);
        const cases: CaseObservation[] = [];
        evidence.cases = cases;
        for (const index of [-1, 0, 1, 3, 4]) {
          const actual = numberCall(instance.exports, "at", index);
          const expected = "Ab9~".charCodeAt(index);
          cases.push({ text: "Ab9~", index: tag(index), expected: tag(expected), actual: tag(actual), round: 0 });
          expect(tag(actual)).toEqual(tag(expected));
        }
        evidence.caseCount = cases.length;
        expect(cases).toHaveLength(5);
      } finally {
        evidence.receipts = {
          generate: generate.mock.calls.length,
          prepare: prepare.mock.calls.length,
          emit: emit.mock.calls.length,
          register: register.mock.calls.length,
        };
        for (const spy of [generate, prepare, emit, register]) spy.mockRestore();
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
    }));

  it("executes cold and cached ASCII reads on the same real allocation", async () =>
    observation("runtime-ascii", "runtime-unit", async (evidence) => {
      await checkRuntime([MATRIX[0]], 24, evidence, 3);
    }));
  it("decodes BMP widths and detects a non-ASCII tail", async () =>
    observation("runtime-bmp", "runtime-unit", async (evidence) => {
      await checkRuntime([MATRIX[1], MATRIX[2]], 19, evidence);
    }));
  it("returns both astral surrogate halves and exact bounds", async () =>
    observation("runtime-astral", "runtime-unit", async (evidence) => {
      await checkRuntime([MATRIX[3]], 9, evidence);
    }));
  it("returns typed NaN for empty and signed-i32 extreme indices", async () =>
    observation("runtime-extremes", "runtime-unit", async (evidence) => {
      await checkRuntime([MATRIX[4], MATRIX[5]], 5, evidence);
    }));

  it("preserves the symbol ABI five locals siblings and idempotent resources", async () =>
    observation("registration", "runtime-registration-unit", async (evidence) => {
      const current = fixture();
      const before = structuredClone(current.module);
      const original = artifact(emitBinary(current.module));
      runtime.addLinearIrStringRuntime(current.module);
      const after = artifact(emitBinary(current.module));
      Object.assign(evidence, {
        phase: "registered ABI",
        beforeArtifact: original.witness,
        afterArtifact: after.witness,
        signature: current.module.types[current.helper.typeIdx],
        locals: current.helper.locals,
        body: current.helper.body,
        counts: {
          functions: current.module.functions.length,
          types: current.module.types.length,
          imports: current.module.imports.length,
          globals: current.module.globals.length,
          memories: current.module.memories.length,
          dataSegments: current.module.dataSegments.length,
        },
      });
      expect(original.witness.valid).toBe(true);
      expect(after.witness.valid).toBe(true);
      expect(current.module).toEqual(before);
      expect(after.witness).toEqual(original.witness);
      expect(current.module.functions.filter((fn) => fn.name === HELPER)).toEqual([current.helper]);
      expect(current.module.types[current.helper.typeIdx]).toMatchObject({
        kind: "func",
        params: [{ kind: "i32" }, { kind: "i32" }],
        results: [{ kind: "f64" }],
      });
      expect(current.helper.locals).toEqual(
        Array.from({ length: 5 }, (_, index) => ({ name: `$l${index}`, type: { kind: "i32" } })),
      );
      for (const name of [runtime.LINEAR_IR_STRING_APPEND_ASCII_FN, runtime.LINEAR_IR_STRING_CHAR_AT_FN]) {
        const sibling = defined(current.module, name).fn;
        expect(sibling.body).toEqual(before.functions.find((fn) => fn.name === name)?.body);
      }
    }));

  it("keeps every nested mutable instruction object fresh across modules", async () =>
    observation("deep-custody", "runtime-custody-unit", async (evidence) => {
      const first = fixture();
      const second = fixture();
      const original = structuredClone(second.helper.body);
      const firstObjects = mutableObjects(first.helper.body);
      const secondObjects = mutableObjects(second.helper.body);
      const shared = [...firstObjects].filter((object) => secondObjects.has(object)).length;
      Object.assign(evidence, {
        phase: "deep custody",
        artifacts: [artifact(emitBinary(first.module)).witness, artifact(emitBinary(second.module)).witness],
        firstObjects: firstObjects.size,
        secondObjects: secondObjects.size,
        sharedObjects: shared,
      });
      for (const module of [first.module, second.module]) expect(artifact(emitBinary(module)).witness.valid).toBe(true);
      expect(first.helper.body).toEqual(second.helper.body);
      expect(firstObjects.size).toBeGreaterThan(100);
      expect(firstObjects.size).toBe(secondObjects.size);
      expect(shared).toBe(0);
      const nested = first.helper.body.find((entry) => entry.op === "if");
      if (!nested || nested.op !== "if") throw new Error("missing nested decoder block");
      const nan = nested.then.find((entry) => entry.op === "f64.const");
      if (!nan || nan.op !== "f64.const") throw new Error("missing test-owned nested NaN instruction");
      nan.value = 123;
      Object.assign(nested.blockType, { kind: "val", type: { kind: "i32" } });
      nested.then.push({ op: "nop" });
      const third = fixture();
      expect(artifact(emitBinary(third.module)).witness.valid).toBe(true);
      const thirdObjects = mutableObjects(third.helper.body);
      const thirdShared = [...thirdObjects].filter(
        (object) => firstObjects.has(object) || secondObjects.has(object),
      ).length;
      Object.assign(evidence, {
        mutatedFirst: first.helper.body,
        unaffectedSecond: second.helper.body,
        subsequentThird: third.helper.body,
        thirdArtifact: artifact(emitBinary(third.module)).witness,
        thirdObjects: thirdObjects.size,
        thirdSharedObjects: thirdShared,
      });
      expect(first.helper.body).not.toEqual(original);
      expect(second.helper.body).toEqual(original);
      expect(third.helper.body).toEqual(original);
      expect(thirdShared).toBe(0);
      expect(thirdObjects.size).toBe(secondObjects.size);
    }));

  it("binds the defined ASCII helper after real imports instead of a throwing namesake", async () =>
    observation("import-binding", "runtime-import-unit", async (evidence) => {
      const probe = await runtimeProbe("Ab9~", evidence, true);
      const ascii = defined(probe.module, "__str_is_ascii");
      const layout = resolveLayout(probe.module);
      const actualCalls = calls(probe.helper.body).map((entry) => layout.func(entry.funcIdx));
      Object.assign(evidence, {
        phase: "import binding",
        importedFunctions: ascii.imports,
        asciiIndex: ascii.index,
        helperIndex: defined(probe.module, HELPER).index,
        actualCalls,
        expectedCaseCount: 2,
      });
      expect(ascii.imports).toBe(2);
      expect(ascii.index).toBeGreaterThanOrEqual(2);
      expect(actualCalls).toEqual([ascii.index]);
      expect(probe.module.functions[actualCalls[0] - ascii.imports]).toBe(ascii.fn);
      const cases = [0, 3].map((index) => ({
        text: "Ab9~",
        index: tag(index),
        expected: tag("Ab9~".charCodeAt(index)),
        actual: tag(probe.at(index)),
      }));
      Object.assign(evidence, { cases, caseCount: cases.length, importedCalls: probe.importedCalls() });
      expect(cases).toHaveLength(2);
      for (const entry of cases) expect(entry.actual).toEqual(entry.expected);
      expect(probe.importedCalls()).toEqual({ namesakeCalls: 0, harmlessCalls: 0 });
    }));

  it("keeps early exits cold and repeated valid calls limited to cache byte one", async () =>
    observation("cache-effects", "runtime-memory-unit", async (evidence) => {
      const probe = await runtimeProbe("Ab9~", evidence);
      const before = probe.snapshot();
      expect(before.state.cache).toBe(0);
      const phases: object[] = [];
      Object.assign(evidence, { phase: "cache and early exits", before: before.state, phases, expectedCaseCount: 8 });
      const cases: CaseObservation[] = [];
      evidence.cases = cases;
      for (const index of [-1, -2147483648, 4, 2147483647, 0, 1, 3, 0]) {
        const actual = probe.at(index);
        const expected = "Ab9~".charCodeAt(index);
        const after = probe.snapshot();
        cases.push({ text: "Ab9~", index: tag(index), expected: tag(expected), actual: tag(actual), round: 0 });
        const changes = [...after.bytes.keys()].filter((offset) => before.bytes[offset] !== after.bytes[offset]);
        phases.push({ index: tag(index), state: after.state, changedOffsets: changes });
        expect(tag(actual)).toEqual(tag(expected));
        expect(after.state.heap).toBe(before.state.heap);
        expect(after.state.used).toBe(before.state.used);
        expect(after.state.memoryBytes).toBe(before.state.memoryBytes);
        if (cases.length <= 4) {
          expect(after.bytes).toEqual(before.bytes);
          expect(after.state.cache).toBe(0);
        } else {
          expect(after.state.cache).toBe(1);
          expect(changes).toEqual([probe.pointer + 1]);
          const expectedBytes = before.bytes.slice();
          expectedBytes[probe.pointer + 1] = 1;
          expect(after.bytes).toEqual(expectedBytes);
        }
      }
      // The unmodified real body has one ASCII call, after both guarded returns.
      expect(calls(probe.helper.body)).toHaveLength(1);
      const asciiCall = probe.helper.body.findIndex((entry) => entry.op === "call");
      const exits = probe.helper.body.slice(0, asciiCall).filter((entry) => entry.op === "if");
      expect(exits).toHaveLength(2);
      for (const exit of exits)
        if (exit.op === "if") {
          expect(calls(exit.then)).toEqual([]);
          expect(exit.then.some((entry) => entry.op === "return")).toBe(true);
        }
      evidence.caseCount = cases.length;
      expect(cases).toHaveLength(8);
    }));
});
