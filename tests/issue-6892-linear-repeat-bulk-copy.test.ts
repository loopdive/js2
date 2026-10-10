// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { addRuntime } from "../src/codegen-linear/runtime.js";
import {
  authenticateLinearStringRepeatProvider,
  authenticateLinearStringRepeatReservationReceipt,
  issueLinearStringRepeatReservationReceipt,
  LINEAR_STRING_REPEAT_FN,
  reserveLinearStringRepeatProvider,
} from "../src/codegen-linear/string-repeat.js";
import { emitBinary } from "../src/emit/binary.js";
import { compile } from "../src/index.js";
import { getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";
import { parseIrCountedStringAppendSiteId } from "../src/ir/counted-string-append-provenance.js";
import { forEachInstrDeep, type IrInstr } from "../src/ir/nodes.js";
import { IR_STRING_REPEAT_FN } from "../src/ir/string-runtime.js";
import { createEmptyModule, type Instr, type WasmModule, type WasmFunction } from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";
import { walkInstructions } from "../src/wasm/model/instruction-walk.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const align8 = (value: number) => Math.ceil(value / 8) * 8;
const TEST_PATH = "tests/issue-6892-linear-repeat-bulk-copy.test.ts";
const KERNEL_PATH = "src/codegen-linear/string-repeat.ts";
const timedCases: [string, number][] = ["xy", "abc"].flatMap((fragment) =>
  [3, 9, 1024, 65537].map((count): [string, number] => [fragment, count]),
);
let observations = 0;

function record(kind: string, data: object) {
  console.log(JSON.stringify({ issue: 6892, kind, ...data }));
}

beforeAll(() => {
  const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  record("provenance", {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    kernelSha256: digest(KERNEL_PATH),
    testSha256: digest(TEST_PATH),
    node: process.version,
    v8: process.versions.v8,
    execArgv: process.execArgv,
    nodeOptions: process.env.NODE_OPTIONS ?? "",
    lane: "linear",
    harness: TEST_PATH,
    allocator: "ordinary bump; source instrument exposes arena usage but never resets",
    flags: { JS2WASM_LINEAR_IR: "1", JS2WASM_IR_STRING_BUILDER: "1", optimize: false },
    benchmarkEnabled: process.env.JS2WASM_BENCH_LINEAR_REPEAT === "1",
    caseCounts: {
      semantic: semanticCases.length,
      semanticControls: 2,
      provider: validProviderCases.length,
      providerTraps: 8,
      providerCustody: 1,
      mechanism: 1,
      optionalInstrument: 1,
    },
  });
});

afterEach(() => vi.unstubAllEnvs());

function readRecord(memory: WebAssembly.Memory, pointer: number) {
  const view = new DataView(memory.buffer);
  const capacity = view.getUint32(pointer + 4, true);
  const length = view.getUint32(pointer + 8, true);
  const bytes = Array.from(new Uint8Array(memory.buffer, pointer + 12, length));
  return { pointer, capacity, length, bytes, text: decoder.decode(new Uint8Array(bytes)) };
}

function sourceText(fragment: string, count: number) {
  return `export function run(): string {
    let value = "seed";
    for (let index = 0; index < ${count}; index++) value = value + ${JSON.stringify(fragment)};
    return value;
  }`;
}

async function compileCounted(
  fragment: string,
  count: number,
  exposeUsage = false,
  captureCheckpoint?: (phase: string) => void,
) {
  vi.stubEnv("JS2WASM_LINEAR_IR", "1");
  vi.stubEnv("JS2WASM_IR_STRING_BUILDER", "1");
  const caseId = `ascii-${encoder.encode(fragment).length}-n-${count}`;
  const source = sourceText(fragment, count);
  const fileName = `issue-6892-${caseId}.ts`;
  const compileOptions = {
    target: "linear",
    fileName,
    optimize: false,
    emitWat: true,
    allocator: exposeUsage ? "arena-reset" : "bump",
  } as const;
  captureCheckpoint?.("before compilation");
  const result = await compile(source, compileOptions);
  captureCheckpoint?.("after compilation");
  const preparationReport = getLastLinearIrReport();
  captureCheckpoint?.("before semantic preparation reporting");
  record("semantic-preparation", {
    caseId,
    fragment,
    count,
    success: result.success,
    errors: result.errors.map((error) => error.message),
    compiled: preparationReport?.compiled ?? null,
    rejected: preparationReport?.rejected ?? null,
    receiptCount: preparationReport?.preparedCountedStringAppendReceipts.length ?? null,
  });
  captureCheckpoint?.("after semantic preparation reporting");
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const report = preparationReport;
  expect(report).toBeDefined();
  if (!report) throw new Error("missing Linear IR report");
  expect(report.compiled).toContain("run");
  expect(report.rejected.filter((rejection) => rejection.func === "run")).toEqual([]);
  const run = report.irModule.functions.find((func) => func.name === "run");
  expect(run).toBeDefined();
  const repeats: Extract<IrInstr, { kind: "string.repeat" }>[] = [];
  for (const instruction of run?.blocks.flatMap((block) => block.instrs) ?? []) {
    forEachInstrDeep(instruction, (nested) => {
      if (nested.kind === "string.repeat") repeats.push(nested);
    });
  }
  expect(report.preparedCountedStringAppendReceipts).toHaveLength(1);
  const receipt = report.preparedCountedStringAppendReceipts[0]!;
  expect(receipt.plan.syntaxPlan.tripCount).toBe(count);
  expect(receipt.siteId).toBe(receipt.plan.siteId);
  const parsed = parseIrCountedStringAppendSiteId(receipt.siteId);
  expect(parsed).toMatchObject({ ownerUnitId: receipt.plan.ownerUnitId, sourceId: receipt.plan.sourceId });
  const ownerEvidence = report.ownerEvidence.filter((owner) => owner.legacyName === "run");
  expect(ownerEvidence).toHaveLength(1);
  expect(ownerEvidence[0]).toMatchObject({ outcome: "compiled", ownerUnitId: receipt.plan.ownerUnitId });
  if (count >= 2) {
    expect(repeats).toHaveLength(1);
    expect(repeats[0]!.encodingEvidence).toBe("ascii");
    expect(repeats[0]!.provider?.binding).toEqual({ kind: "intrinsic", symbol: IR_STRING_REPEAT_FN });
    expect(repeats[0]!.countedStringAppendSite).toBe(receipt.siteId);
  } else {
    expect(repeats).toHaveLength(0);
    expect(result.wat).not.toContain("$__str_repeat");
  }
  captureCheckpoint?.("after ownership assertions / before binary validation");
  expect(WebAssembly.validate(result.binary)).toBe(true);
  captureCheckpoint?.("after binary validation / before module compilation");
  const module = new WebAssembly.Module(result.binary);
  captureCheckpoint?.("after module compilation");
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  captureCheckpoint?.("before disposable validation instance");
  const instance = await WebAssembly.instantiate(module);
  captureCheckpoint?.("after disposable validation instance");
  const memory = instance.exports.memory as WebAssembly.Memory;
  const output = readRecord(memory, (instance.exports.run as () => number)());
  captureCheckpoint?.("after disposable output execution and decoding");
  const expected = "seed" + fragment.repeat(count);
  expect(output.text).toBe(expected);
  expect(output.bytes).toEqual(Array.from(encoder.encode(expected)));
  captureCheckpoint?.("after semantic output assertions");
  observations++;
  const semanticWitness = {
    caseId,
    fragment,
    count,
    compiled: [...report.compiled],
    rejected: report.rejected,
    associations: {
      owner: ownerEvidence[0],
      siteId: receipt.siteId,
      parsed,
      planOwner: receipt.plan.ownerUnitId,
      planSource: receipt.plan.sourceId,
      repeatSite: repeats[0]?.countedStringAppendSite ?? null,
      encoding: repeats[0]?.encodingEvidence ?? null,
      binding: repeats[0]?.provider?.binding ?? null,
    },
    output,
  };
  captureCheckpoint?.("before semantic reporting");
  record("semantic", semanticWitness);
  captureCheckpoint?.("after semantic reporting");
  return {
    module,
    caseId,
    expected,
    outputBytes: encoder.encode(expected).length,
    binary: result.binary,
    source,
    fileName,
    compileOptions,
    semanticWitness,
    receiptWitness: {
      count: report.preparedCountedStringAppendReceipts.length,
      siteId: receipt.siteId,
      planSiteId: receipt.plan.siteId,
      tripCount: receipt.plan.syntaxPlan.tripCount,
      planOwner: receipt.plan.ownerUnitId,
      planSource: receipt.plan.sourceId,
    },
    repeatCount: repeats.length,
  };
}

type CountedArtifact = Awaited<ReturnType<typeof compileCounted>>;
interface RepeatArtifactCapture {
  schemaVersion: 1;
  ordinal: number;
  caseId: string;
  fragment: string;
  count: number;
  source: string;
  sourceSha256: string;
  fileName: string;
  compileOptions: CountedArtifact["compileOptions"];
  binaryBase64: string;
  binaryByteLength: number;
  binarySha256: string;
  imports: WebAssembly.ModuleImportDescriptor[];
  exports: WebAssembly.ModuleExportDescriptor[];
  outputBytes: number;
  estimatedAllocationPerCall: number;
  calls: number;
  semanticWitness: CountedArtifact["semanticWitness"];
  receiptWitness: CountedArtifact["receiptWitness"];
  repeatCount: number;
}

/** Capture authentic source artifacts only; this path performs NO timed batches. */
async function captureRepeatArtifacts(): Promise<void> {
  const started = performance.now();
  const caseIds: string[] = [];
  const binarySha256s: string[] = [];
  let phase = "capture setup";
  const checkpoint = (nextPhase: string): void => {
    phase = nextPhase;
    if (performance.now() - started >= 30_000)
      throw new Error(`incomplete repeat artifact capture: 30-second total cap exceeded at ${phase}`);
  };
  const bounded = <T>(label: string, operation: () => T): T => {
    checkpoint(`before ${label}`);
    const value = operation();
    checkpoint(`after ${label}`);
    return value;
  };
  const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
  const git = (args: string[]): string =>
    bounded(`git ${args.join(" ")}`, () => execFileSync("git", args, { encoding: "utf8" }).trim());
  const digest = (path: string): string => bounded(`hash ${path}`, () => sha256(readFileSync(path)));
  const expectedTrees: Readonly<Record<string, string>> = {
    a5c5689f9c85090d44f940204ae3c65605f01ce5: "a2c05cf247880acb2bee3650f3735303927e0594",
    "6b33a4934e8f95cc2d8c788f059844ffaa5a8f7b": "fb5702851a974b8de9d2744ddc1460420efe5cca",
  };
  try {
    checkpoint("capture gate check");
    if (process.env.JS2WASM_BENCH_LINEAR_REPEAT === "1")
      throw new Error("JS2WASM_CAPTURE_LINEAR_REPEAT and JS2WASM_BENCH_LINEAR_REPEAT are mutually exclusive");
    const sourceEpoch = process.env.JS2WASM_REPEAT_SOURCE_EPOCH;
    if (!sourceEpoch || !Object.hasOwn(expectedTrees, sourceEpoch))
      throw new Error("capture requires a pinned baseline/candidate JS2WASM_REPEAT_SOURCE_EPOCH");
    vi.stubEnv("JS2WASM_LINEAR_IR", "1");
    vi.stubEnv("JS2WASM_IR_STRING_BUILDER", "1");
    const head = git(["rev-parse", "HEAD"]);
    const sourceTree = git(["rev-parse", "HEAD:src"]);
    const epochSourceTree = git(["rev-parse", `${sourceEpoch}:src`]);
    const assertCleanSource = (): void => {
      expect(git(["status", "--porcelain=v1", "--untracked-files=all", "--", "src"])).toBe("");
      // Include ignored untracked files too: no extra source input is credited.
      expect(git(["ls-files", "--others", "--", "src"])).toBe("");
      expect(git(["rev-parse", "HEAD:src"])).toBe(sourceTree);
    };
    expect(sourceTree).toBe(expectedTrees[sourceEpoch]);
    expect(epochSourceTree).toBe(sourceTree);
    assertCleanSource();
    const lockfileName = "pnpm-lock.yaml";
    const lockfileSha256 = digest(lockfileName);
    expect(lockfileSha256).toBe("6a8b59fd4430c6600dc16ac33a749d0f5fed4ef0c100425de8490e43d916f2ac");
    const kernelSha256 = digest(KERNEL_PATH);
    const testSha256 = digest(TEST_PATH);
    const orderedCaseIds = timedCases.map(([fragment, count]) => `ascii-${encoder.encode(fragment).length}-n-${count}`);
    bounded("capture start reporting", () =>
      record("artifact-capture-start", {
        schemaVersion: 1,
        sourceEpoch,
        head,
        sourceTree,
        epochSourceTree,
        sourceClean: true,
        kernelSha256,
        testSha256,
        lockfileName,
        lockfileSha256,
        node: process.version,
        v8: process.versions.v8,
        platform: process.platform,
        arch: process.arch,
        execPath: process.execPath,
        execArgv: process.execArgv,
        nodeOptions: process.env.NODE_OPTIONS ?? "",
        lane: "linear",
        harness: TEST_PATH,
        flags: {
          JS2WASM_LINEAR_IR: process.env.JS2WASM_LINEAR_IR,
          JS2WASM_IR_STRING_BUILDER: process.env.JS2WASM_IR_STRING_BUILDER,
        },
        compileConfiguration: { target: "linear", optimize: false, emitWat: true, allocator: "arena-reset" },
        caseIds: orderedCaseIds,
        count: 8,
      }),
    );
    for (const [ordinal, [fragment, count]] of timedCases.entries()) {
      checkpoint(`before capture case ${ordinal}`);
      const artifact = await compileCounted(fragment, count, true, checkpoint);
      checkpoint(`after capture case ${ordinal} ownership and output validation`);
      const repeatedBytes = encoder.encode(fragment).length * count;
      // Deliberately identical to the legacy instrument's conservative charge;
      // its timing branch and batch lifecycle are not changed by capture.
      const estimatedAllocationPerCall =
        align8(repeatedBytes + 12) +
        align8(artifact.outputBytes + 12) +
        align8(4 + 12) +
        align8(encoder.encode(fragment).length + 12);
      const calls = Math.min(256, Math.floor(1_048_576 / estimatedAllocationPerCall));
      const row = bounded(
        `serialize capture case ${ordinal}`,
        (): RepeatArtifactCapture => ({
          schemaVersion: 1,
          ordinal,
          caseId: artifact.caseId,
          fragment,
          count,
          source: artifact.source,
          sourceSha256: sha256(artifact.source),
          fileName: artifact.fileName,
          compileOptions: artifact.compileOptions,
          binaryBase64: Buffer.from(artifact.binary).toString("base64"),
          binaryByteLength: artifact.binary.byteLength,
          binarySha256: sha256(artifact.binary),
          imports: WebAssembly.Module.imports(artifact.module),
          exports: WebAssembly.Module.exports(artifact.module),
          outputBytes: artifact.outputBytes,
          estimatedAllocationPerCall,
          calls,
          semanticWitness: artifact.semanticWitness,
          receiptWitness: artifact.receiptWitness,
          repeatCount: artifact.repeatCount,
        }),
      );
      bounded(`capture case ${ordinal} final assertions`, () => {
        expect(row.caseId).toBe(orderedCaseIds[ordinal]);
        expect(row.calls).toBe([256, 256, 252, 3, 256, 256, 168, 2][ordinal]);
        expect(row.imports).toEqual([]);
        expect(row.exports).toEqual(
          expect.arrayContaining([
            { name: "run", kind: "function" },
            { name: "memory", kind: "memory" },
            { name: "__arena_used", kind: "function" },
          ]),
        );
        expect(row.semanticWitness.compiled).toEqual(["run"]);
        expect(row.receiptWitness.count).toBe(1);
        expect(row.repeatCount).toBe(1);
        expect(row.semanticWitness.output.length).toBe(row.outputBytes);
        expect(row.semanticWitness.output.capacity).toBe(row.outputBytes + 4);
      });
      bounded(`capture artifact ${ordinal} reporting`, () => record("artifact-capture", row));
      caseIds.push(row.caseId);
      binarySha256s.push(row.binarySha256);
    }
    assertCleanSource();
    expect(digest(KERNEL_PATH)).toBe(kernelSha256);
    expect(digest(TEST_PATH)).toBe(testSha256);
    expect(digest(lockfileName)).toBe(lockfileSha256);
    expect(caseIds).toEqual(orderedCaseIds);
    expect(binarySha256s).toHaveLength(8);
    bounded("capture completion reporting", () =>
      record("artifact-capture-complete", {
        schemaVersion: 1,
        status: "complete",
        count: 8,
        caseIds,
        binarySha256s,
        elapsedMs: performance.now() - started,
      }),
    );
  } catch (error) {
    record("artifact-capture-incomplete", {
      schemaVersion: 1,
      status: "incomplete",
      count: caseIds.length,
      caseIds,
      binarySha256s,
      elapsedMs: performance.now() - started,
      phase,
      error: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) },
    });
    throw error;
  }
}

function providerFixture() {
  const module = createEmptyModule();
  addRuntime(module, { exposeArenaReset: true });
  const reservation = reserveLinearStringRepeatProvider(module);
  const index = authenticateLinearStringRepeatProvider(module, reservation);
  expect(reserveLinearStringRepeatProvider(module)).toBe(reservation);
  expect(module.functions.filter((func) => func.name === LINEAR_STRING_REPEAT_FN)).toEqual([reservation.provider]);
  const sourceFile = ts.createSourceFile("issue-6892-provider.ts", "", ts.ScriptTarget.ES2022, true);
  const preparation = Object.freeze({ sourceFile });
  const receipt = issueLinearStringRepeatReservationReceipt(module, reservation, sourceFile, preparation);
  expect(authenticateLinearStringRepeatReservationReceipt(module, receipt, sourceFile, preparation)).toBe(index);
  module.exports.push({ name: "repeat", desc: { kind: "func", index } });
  const heapIndex = module.globals.findIndex((global) => global.name === "__heap_ptr");
  expect(heapIndex).toBeGreaterThanOrEqual(0);
  module.exports.push({ name: "heap", desc: { kind: "global", index: heapIndex } });
  return { module, reservation, receipt, sourceFile, preparation };
}

async function instantiateProvider() {
  const fixture = providerFixture();
  const binary = emitBinary(fixture.module);
  expect(WebAssembly.validate(binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(binary);
  expect(WebAssembly.Module.imports(new WebAssembly.Module(binary))).toEqual([]);
  const exports = instance.exports as unknown as {
    memory: WebAssembly.Memory;
    heap: WebAssembly.Global;
    repeat: (source: number, count: number) => number;
    __arena_used: () => number;
  };
  return exports;
}

function writeSource(memory: WebAssembly.Memory, text: string) {
  const source = 64;
  const bytes = encoder.encode(text);
  expect(source + 12 + bytes.length).toBeLessThan(768);
  const view = new DataView(memory.buffer);
  view.setUint32(source, 0, true);
  view.setUint32(source + 4, bytes.length + 4, true);
  view.setUint32(source + 8, bytes.length, true);
  new Uint8Array(memory.buffer).set(bytes, source + 12);
  // A separate occupied record catches writes outside the source/result.
  view.setUint32(800 + 4, 12, true);
  view.setUint32(800 + 8, 8, true);
  new Uint8Array(memory.buffer).set(encoder.encode("occupied"), 812);
  return source;
}

const semanticCases: [string, number][] = [
  ["x", 0],
  ["xy", 1],
  ["abc", 2],
  ["abcdefghijklmnopq", 3],
  ["abc", 5],
  ["x", 7],
  ["xy", 8],
  ["abc", 9],
  ["abcdefghijklmnopq", 31],
  ["x", 32],
  ["xy", 33],
  ["abc", 1024],
  ["x", 63],
  ["x", 64],
  ["x", 65],
];
const validProviderCases: [string, number][] = [
  ...[NaN, 0, -0, -0.75, 0.75].map((count): [string, number] => ["long-source-".repeat(32), count]),
  ["abc", 1],
  ["abc", 1.9],
  ["abc", 2.9],
  ["abc", 3.9],
  ...["abc", "a\0b", "é", "A😀", "é中😀!"].flatMap((text) => [3, 5, 9].map((count): [string, number] => [text, count])),
  ["", NaN],
  ["", 0],
  ["", 1],
  ["", Number.MAX_SAFE_INTEGER],
  ["abc", 32769],
  ["abc", 21],
  ["abc", 22],
  ["é", 32],
  ["é", 33],
];
const countLabel = (count: number) => (Object.is(count, -0) ? "-0" : String(count));

/** Structural evidence only: these templates never emit or execute a provider. */
function classifyRepeatBody(module: WasmModule, provider: WasmFunction) {
  const get = (index: number): Instr => ({ op: "local.get", index });
  const set = (index: number): Instr => ({ op: "local.set", index });
  const tee = (index: number): Instr => ({ op: "local.tee", index });
  const i32 = (value: number): Instr => ({ op: "i32.const", value });
  const f64 = (value: number): Instr => ({ op: "f64.const", value });
  const emptyIf = (then: Instr[], otherwise: Instr[] = []): Instr => ({
    op: "if",
    blockType: { kind: "empty" },
    then,
    else: otherwise,
  });
  const loop = (body: Instr[]): Instr => ({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body }],
  });
  const mallocIndex =
    module.imports.filter((entry) => entry.desc.kind === "func").length +
    module.functions.findIndex((func) => func.name === "__malloc");
  // Exact historical guards, one allocation and canonical header writes.
  // Infinity stays a number here; JSON serialization would conflate it with null.
  const prefix: Instr[] = [
    get(1),
    { op: "f64.trunc" },
    set(2),
    get(2),
    f64(0),
    { op: "f64.lt" },
    get(2),
    f64(Infinity),
    { op: "f64.eq" },
    { op: "i32.or" },
    emptyIf([{ op: "unreachable" }]),
    get(2),
    get(2),
    { op: "f64.ne" },
    emptyIf([f64(0), set(2)]),
    get(0),
    { op: "i32.load", align: 2, offset: 8 },
    tee(3),
    { op: "i32.eqz" },
    emptyIf([get(0), { op: "return" }]),
    get(2),
    f64(1),
    { op: "f64.eq" },
    emptyIf([get(0), { op: "return" }]),
    get(3),
    { op: "f64.convert_i32_u" },
    get(2),
    { op: "f64.mul" },
    tee(2),
    f64(256 * 65536 - 12),
    { op: "f64.gt" },
    emptyIf([{ op: "unreachable" }]),
    get(2),
    { op: "i32.trunc_f64_u" },
    set(4),
    get(4),
    i32(12),
    { op: "i32.add" },
    { op: "call", funcIdx: mallocIndex },
    set(5),
    get(5),
    get(4),
    i32(4),
    { op: "i32.add" },
    { op: "i32.store", align: 2, offset: 4 },
    get(5),
    get(4),
    { op: "i32.store", align: 2, offset: 8 },
  ];
  const bytewise: Instr[] = [
    i32(0),
    set(6),
    loop([
      get(6),
      get(4),
      { op: "i32.ge_u" },
      { op: "br_if", depth: 1 },
      get(5),
      get(6),
      { op: "i32.add" },
      get(0),
      get(6),
      get(3),
      { op: "i32.rem_u" },
      { op: "i32.add" },
      { op: "i32.load8_u", align: 0, offset: 12 },
      { op: "i32.store8", align: 0, offset: 12 },
      get(6),
      i32(1),
      { op: "i32.add" },
      set(6),
      { op: "br", depth: 0 },
    ]),
  ];
  const bulk: Instr[] = [
    get(5),
    i32(12),
    { op: "i32.add" },
    get(0),
    i32(12),
    { op: "i32.add" },
    get(3),
    { op: "memory.copy" },
    get(3),
    set(6),
    loop([
      get(6),
      get(4),
      { op: "i32.ge_u" },
      { op: "br_if", depth: 1 },
      get(6),
      get(4),
      get(6),
      { op: "i32.sub" },
      tee(7),
      get(6),
      get(7),
      { op: "i32.lt_u" },
      { op: "select" },
      set(7),
      get(5),
      i32(12),
      { op: "i32.add" },
      get(6),
      { op: "i32.add" },
      get(5),
      i32(12),
      { op: "i32.add" },
      get(7),
      { op: "memory.copy" },
      get(6),
      get(7),
      { op: "i32.add" },
      set(6),
      { op: "br", depth: 0 },
    ]),
  ];
  const hybrid: Instr[] = [get(4), emptyIf([get(4), i32(64), { op: "i32.le_u" }, emptyIf(bytewise, bulk)])];
  const commonLocals = [
    { name: "integerCount", type: { kind: "f64" } },
    { name: "sourceLen", type: { kind: "i32" } },
    { name: "resultLen", type: { kind: "i32" } },
    { name: "result", type: { kind: "i32" } },
  ];
  const unchangedPrefix = isDeepStrictEqual(provider.body.slice(0, prefix.length), prefix);
  const unchangedReturn = isDeepStrictEqual(provider.body.at(-1), get(5));
  const unchangedLocals = isDeepStrictEqual(provider.locals.slice(0, 4), commonLocals);
  const signature = module.types[provider.typeIdx];
  const unchangedAbi =
    signature?.kind === "func" &&
    isDeepStrictEqual(signature.params, [{ kind: "i32" }, { kind: "f64" }]) &&
    isDeepStrictEqual(signature.results, [{ kind: "i32" }]);
  const copyRegion = provider.body.slice(prefix.length, -1);
  const common = unchangedPrefix && unchangedReturn && unchangedLocals && unchangedAbi;
  const scratch6 = isDeepStrictEqual(provider.locals[4]?.type, { kind: "i32" });
  const scratch7 = isDeepStrictEqual(provider.locals[5]?.type, { kind: "i32" });
  const oldShape = common && provider.locals.length === 5 && scratch6 && isDeepStrictEqual(copyRegion, bytewise);
  const bulkShape =
    common &&
    provider.locals.length === 6 &&
    scratch6 &&
    scratch7 &&
    isDeepStrictEqual(copyRegion, [get(4), emptyIf(bulk)]);
  // Exact nested tree equality pins the zero guard, <=64 unsigned condition,
  // branch polarity, copy operands, old byte loop, scratch indices and depths.
  // Counts alone cannot admit extra seed copies or a remainder in the bulk arm.
  const hybridShape =
    common && provider.locals.length === 6 && scratch6 && scratch7 && isDeepStrictEqual(copyRegion, hybrid);
  return {
    mechanism: oldShape
      ? "bytewise-remainder"
      : bulkShape
        ? "bulk-copy"
        : hybridShape
          ? "hybrid-bytewise-through-64"
          : "unknown",
    structure: {
      unchangedPrefix,
      unchangedReturn,
      unchangedLocals,
      unchangedAbi,
      scratch6,
      scratch7,
      oldShape,
      bulkShape,
      hybridShape,
    },
  };
}

describe("issue 6892: source-derived ownership and execution", () => {
  it.each(semanticCases)(
    "executes fragment %j at count %i through its exact prepared owner",
    async (fragment, count) => {
      await compileCounted(fragment, count);
    },
  );

  it.each(["non-ascii", "tampered-reservation"])("retains the %s fail-closed control", async (control) => {
    vi.stubEnv("JS2WASM_LINEAR_IR", "1");
    vi.stubEnv("JS2WASM_IR_STRING_BUILDER", "1");
    if (control === "tampered-reservation") vi.stubEnv("JS2WASM_TEST_TAMPER_LINEAR_COUNTED_REPEAT_RESERVATION", "1");
    const result = await compile(sourceText(control === "non-ascii" ? "é" : "xy", 3), {
      target: "linear",
      fileName: `issue-6892-${control}.ts`,
      optimize: false,
    });
    const report = getLastLinearIrReport();
    const errors = result.errors.map((error) => error.message);
    record("semantic-control", {
      control,
      success: result.success,
      errors,
      compiled: report?.compiled ?? null,
      receipts: report?.preparedCountedStringAppendReceipts ?? null,
    });
    expect(result.success).toBe(false);
    expect(errors.join("\n")).toMatch(
      control === "non-ascii"
        ? /requires authenticated ASCII evidence for string\.repeat/
        : /reservation lost its exact provider ABI/,
    );
    expect(report).toBeDefined();
    expect(report?.compiled).not.toContain("run");
    expect(report?.preparedCountedStringAppendReceipts).toEqual([]);
    observations++;
  });
});

describe("issue 6892: real reserved provider and memory integrity", () => {
  it.each(validProviderCases)("preserves bytes/header/allocation for %j at count %s", async (text, count) => {
    const runtime = await instantiateProvider();
    const { memory } = runtime;
    const source = writeSource(memory, text);
    const sourceLength = encoder.encode(text).length;
    const expected = text.repeat(Number.isNaN(count) ? 0 : Math.trunc(count));
    const expectedBytes = Array.from(encoder.encode(expected));
    const reuse = sourceLength === 0 || Math.trunc(count) === 1;
    const heapBefore = Number(runtime.heap.value) >>> 0;
    const usedBefore = runtime.__arena_used();
    const memoryBefore = memory.buffer.byteLength;
    const delta = reuse ? 0 : align8(expectedBytes.length + 12);
    const resultEnd = heapBefore + 12 + expectedBytes.length;
    // Setup may grow memory to poison the future payload, but usage is unchanged.
    if (resultEnd + 64 > memory.buffer.byteLength)
      memory.grow(Math.ceil((resultEnd + 64 - memory.buffer.byteLength) / 65536));
    const setupMemoryBytes = memory.buffer.byteLength;
    const bytes = new Uint8Array(memory.buffer);
    bytes.fill(0xa5, heapBefore, resultEnd + 64);
    // Header offset 0 belongs to the existing allocator; do not assert a new zeroing contract.
    const sourceBefore = Array.from(bytes.slice(source, source + 12 + sourceLength));
    const occupiedBefore = Array.from(bytes.slice(768, 1024));
    const guardBefore = Array.from(bytes.slice(resultEnd, resultEnd + 64));
    const pointer = runtime.repeat(source, count);
    const output = readRecord(memory, pointer);
    const currentBytes = new Uint8Array(memory.buffer);
    const sourceAfter = Array.from(currentBytes.slice(source, source + 12 + sourceLength));
    const occupiedAfter = Array.from(currentBytes.slice(768, 1024));
    const guardAfter = Array.from(currentBytes.slice(resultEnd, resultEnd + 64));
    const allocationDelta = runtime.__arena_used() - usedBefore;
    record("provider", {
      text,
      count: countLabel(count),
      reuse,
      output,
      allocationDelta,
      heapBefore,
      heapAfter: Number(runtime.heap.value) >>> 0,
      memoryBefore,
      setupMemoryBytes,
      memoryAfter: memory.buffer.byteLength,
      sourceBefore,
      sourceAfter,
      occupiedBefore,
      occupiedAfter,
      guardBefore,
      guardAfter,
    });
    expect(output.pointer).toBe(reuse ? source : heapBefore);
    expect(output.text).toBe(expected);
    expect(output.bytes).toEqual(expectedBytes);
    expect(output.length).toBe(expectedBytes.length);
    expect(output.capacity).toBe(expectedBytes.length + 4);
    expect(allocationDelta).toBe(delta);
    expect(Number(runtime.heap.value) >>> 0).toBe(heapBefore + delta);
    expect(sourceAfter).toEqual(sourceBefore);
    expect(occupiedAfter).toEqual(occupiedBefore);
    expect(guardAfter).toEqual(guardBefore);
    observations++;
  });

  it.each([
    ...["abc", ""].flatMap((text) => [-1, -Infinity, Infinity].map((count): [string, number] => [text, count])),
    ["abc", Number.MAX_SAFE_INTEGER] as [string, number],
    ["abc", 16_777_216] as [string, number],
  ])("rejects %j count %s before allocation", async (text, count) => {
    const runtime = await instantiateProvider();
    const source = writeSource(runtime.memory, text);
    const before = {
      used: runtime.__arena_used(),
      memoryBytes: runtime.memory.buffer.byteLength,
      bytes: Array.from(new Uint8Array(runtime.memory.buffer, 0, 2048)),
    };
    let failure: unknown;
    try {
      runtime.repeat(source, count);
    } catch (error) {
      failure = error;
    }
    const after = {
      used: runtime.__arena_used(),
      memoryBytes: runtime.memory.buffer.byteLength,
      bytes: Array.from(new Uint8Array(runtime.memory.buffer, 0, 2048)),
    };
    record("provider-trap", {
      text,
      count: countLabel(count),
      trap: failure instanceof Error ? failure.name : null,
      before,
      after,
    });
    expect(failure).toBeInstanceOf(WebAssembly.RuntimeError);
    expect(after).toEqual(before);
    observations++;
  });

  it("retains reservation identity, uniqueness, receipt and exact ABI controls", () => {
    const fixture = providerFixture();
    const { module, reservation, receipt, sourceFile, preparation } = fixture;
    const otherSource = ts.createSourceFile("other.ts", "", ts.ScriptTarget.ES2022, true);
    const outcomes: string[] = [];
    const rejects = (id: string, action: () => unknown, pattern: RegExp) => {
      expect(action).toThrow(pattern);
      outcomes.push(id);
    };
    rejects(
      "wrong-source",
      () => authenticateLinearStringRepeatReservationReceipt(module, receipt, otherSource, preparation),
      /source\/preparation identity/,
    );
    rejects(
      "wrong-preparation",
      () => authenticateLinearStringRepeatReservationReceipt(module, receipt, sourceFile, {}),
      /source\/preparation identity/,
    );
    rejects(
      "borrowed-receipt",
      () => authenticateLinearStringRepeatReservationReceipt(module, { ...receipt }, sourceFile, preparation),
      /source\/preparation identity/,
    );
    rejects(
      "borrowed-module",
      () =>
        authenticateLinearStringRepeatReservationReceipt(providerFixture().module, receipt, sourceFile, preparation),
      /source\/preparation identity/,
    );
    module.functions.push({ ...reservation.provider });
    rejects(
      "duplicate-provider",
      () => authenticateLinearStringRepeatProvider(module, reservation),
      /exact provider ABI/,
    );
    module.functions.pop();
    const signature = module.types[reservation.provider.typeIdx];
    if (signature?.kind !== "func") throw new Error("fixture missing provider ABI");
    signature.params[1] = { kind: "i32" };
    rejects("wrong-abi", () => authenticateLinearStringRepeatProvider(module, reservation), /exact provider ABI/);
    signature.params[1] = { kind: "f64" };
    module.functions.splice(module.functions.indexOf(reservation.provider), 1);
    rejects(
      "missing-provider",
      () => authenticateLinearStringRepeatProvider(module, reservation),
      /exact provider ABI/,
    );
    record("provider-controls", { outcomes });
    observations++;
  });

  it("records the exact provider body mechanism without rejecting baseline semantics", () => {
    const { module, reservation } = providerFixture();
    const ops: string[] = [];
    walkInstructions(reservation.provider.body, (instruction) => ops.push(instruction.op));
    const bulkCopies = ops.filter((op) => op === "memory.copy").length;
    const remainders = ops.filter((op) => op === "i32.rem_u").length;
    const { mechanism, structure } = classifyRepeatBody(module, reservation.provider);
    record("mechanism", {
      provider: reservation.provider.name,
      bulkCopies,
      remainders,
      mechanism,
      structure,
      locals: reservation.provider.locals.map((local) => ({ name: local.name, type: local.type.kind })),
    });
    // All three named historical/next-candidate forms remain distinguishable.
    expect(mechanism).not.toBe("unknown");
  });
});

it("runs the optional bounded source-derived paired instrument", async () => {
  if (process.env.JS2WASM_CAPTURE_LINEAR_REPEAT === "1") {
    await captureRepeatArtifacts();
    return;
  }
  if (process.env.JS2WASM_BENCH_LINEAR_REPEAT !== "1") {
    record("instrument", { enabled: false, status: "disabled", observations });
    return;
  }
  const started = performance.now();
  const checkBudget = (phase: string) => {
    const elapsedMs = performance.now() - started;
    if (elapsedMs >= 30_000) {
      record("instrument", {
        enabled: true,
        status: "incomplete",
        reason: "30-second total cap exceeded",
        phase,
        elapsedMs,
      });
      throw new Error(`incomplete repeat instrument: total cap exceeded at ${phase}`);
    }
  };
  // Total cap includes compilation, instantiation, checking, warmup and timings.
  // Compiler calls are not cancelled; a call that crosses the deadline is
  // reported as incomplete immediately on return, never credited as evidence.
  const cases = timedCases;
  const measurements: object[] = [];
  for (const [fragment, count] of cases) {
    checkBudget("before compilation");
    const artifact = await compileCounted(fragment, count, true);
    checkBudget("after ownership and output validation");
    const repeatedBytes = encoder.encode(fragment).length * count;
    // Conservatively charge literal records every call although they are cached
    // within a batch. Includes repeat + final seed concat and aligned headers.
    const estimatedAllocationPerCall =
      align8(repeatedBytes + 12) +
      align8(artifact.outputBytes + 12) +
      align8(4 + 12) +
      align8(encoder.encode(fragment).length + 12);
    const calls = Math.min(256, Math.floor(1_048_576 / estimatedAllocationPerCall));
    expect(calls).toBeGreaterThan(0);
    const samples: number[] = [];
    const batches: object[] = [];
    for (let batch = 0; batch < 10; batch++) {
      checkBudget("before batch instantiation");
      const instance = await WebAssembly.instantiate(artifact.module);
      checkBudget("after batch instantiation");
      const exports = instance.exports as unknown as {
        run: () => number;
        memory: WebAssembly.Memory;
        __arena_used: () => number;
      };
      expect(typeof exports.__arena_used).toBe("function");
      const before = { used: exports.__arena_used(), memoryBytes: exports.memory.buffer.byteLength };
      expect(before.used).toBe(0);
      let pointer = 0;
      let checksum = 0;
      const t0 = performance.now();
      for (let call = 0; call < calls; call++) {
        pointer = exports.run();
        checksum = (Math.imul(checksum, 31) + pointer) >>> 0;
      }
      const elapsedMs = performance.now() - t0;
      checkBudget("after timed batch");
      const output = readRecord(exports.memory, pointer);
      expect(output.text).toBe(artifact.expected);
      expect(output.bytes).toEqual(Array.from(encoder.encode(artifact.expected)));
      const after = { used: exports.__arena_used(), memoryBytes: exports.memory.buffer.byteLength };
      expect(after.used - before.used).toBeLessThanOrEqual(calls * estimatedAllocationPerCall);
      batches.push({
        batch,
        phase: batch < 3 ? "warmup" : "sample",
        checksum,
        before,
        after,
        growthBytes: after.memoryBytes - before.memoryBytes,
        retainedArenaBytes: after.used,
        calls,
        elapsedMs,
      });
      if (batch >= 3) samples.push(elapsedMs);
      // All output pointers die here. The next batch uses fresh instance state,
      // so no reset can invalidate a lazily cached literal pointer.
      checkBudget("after batch output validation");
    }
    expect(samples).toHaveLength(7);
    const sorted = [...samples].sort((a, b) => a - b);
    measurements.push({
      caseId: artifact.caseId,
      fragment,
      count,
      calls,
      outputBytes: artifact.outputBytes,
      estimatedAllocationPerCall,
      samplesMs: samples,
      medianMs: sorted[3],
      spreadMs: sorted[6]! - sorted[0]!,
      batches,
    });
    record("measurement", {
      caseId: artifact.caseId,
      measurements: measurements.at(-1),
      ratio: null,
      ratioReason: "parent joins identical case IDs from paired revision runs",
      warmup:
        "three independent batches sharing compiled Wasm module; seven fresh-instance samples; literal materialization once per batch is timed; no reset",
    });
    checkBudget("after measurement reporting");
  }
  expect(measurements).toHaveLength(8);
  record("instrument", {
    enabled: true,
    status: "complete",
    cases: measurements.length,
    elapsedMs: performance.now() - started,
    pairing: "parent alternates exact baseline/candidate order on the same machine and joins medians by caseId",
    observations,
  });
}, 35_000);
