// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Issue-local evidence replay. Capture schema validation must precede execution.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const started = performance.now();
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_BINARY_BYTES = 2 * 1024 * 1024;
const ALLOCATION_LIMIT = 1048576;
const NODE_VERSION = "v22.23.2";
const V8_VERSION = "12.4.254.21-node.56";
const APPROVED_TEST_SHA256 = "19b728dfe6941a44941e0817f70c8c2b333f63e858a85cc596814686a3763e82";
const LOCK_SHA256 = "6a8b59fd4430c6600dc16ac33a749d0f5fed4ef0c100425de8490e43d916f2ac";
const EPOCHS = {
  A: {
    revision: "a5c5689f9c85090d44f940204ae3c65605f01ce5",
    sourceTree: "a2c05cf247880acb2bee3650f3735303927e0594",
    kernelSha256: "c8df1de8944d12cd155a29f321fe4bd09f72cb3b36078ec8b828ce9de32dfcad",
  },
  B: {
    revision: "6b33a4934e8f95cc2d8c788f059844ffaa5a8f7b",
    sourceTree: "fb5702851a974b8de9d2744ddc1460420efe5cca",
    kernelSha256: "5ba8a23ed459fb717864e776813d5df09c1846a060e3a3ceaa7753a05db821b1",
  },
};
const align8 = (value) => Math.ceil(value / 8) * 8;
const CASES = ["xy", "abc"].flatMap((fragment) =>
  [3, 9, 1024, 65537].map((count) => {
    const expectedText = "seed" + fragment.repeat(count);
    const expectedBytes = Buffer.from(expectedText, "utf8");
    const estimatedAllocationPerCall =
      align8(fragment.length * count + 12) +
      align8(expectedBytes.length + 12) +
      align8(16) +
      align8(fragment.length + 12);
    return {
      caseId: `ascii-${fragment.length}-n-${count}`,
      fragment,
      count,
      expectedText,
      expectedBytes,
      estimatedAllocationPerCall,
      calls: Math.min(256, Math.floor(ALLOCATION_LIMIT / estimatedAllocationPerCall)),
    };
  }),
);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const decoder = new TextDecoder("utf-8", { fatal: true });
let completedBatches = 0;
let completedCases = 0;
let phase = "startup";

function checkBudget(label) {
  phase = label;
  assert(performance.now() - started < 30000, `30-second whole-run cap exceeded at ${label}`);
}

function record(kind, data) {
  checkBudget(`before ${kind} reporting`);
  process.stdout.write(JSON.stringify({ issue: 6892, schemaVersion: 1, kind, ...data }) + "\n");
  checkBudget(`after ${kind} reporting`);
}

function readBounded(path) {
  checkBudget("before capture read");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const bytes = readSync(fd, buffer, length, buffer.length - length, null);
      if (bytes === 0) break;
      length += bytes;
      checkBudget("during capture read");
    }
    assert(length <= MAX_INPUT_BYTES, "capture input exceeds 32 MiB");
    checkBudget("after capture read");
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

function finiteNumbers(value) {
  if (typeof value === "number") assert(Number.isFinite(value), "nonfinite capture number");
  else if (Array.isArray(value)) value.forEach(finiteNumbers);
  else if (value && typeof value === "object") Object.values(value).forEach(finiteNumbers);
}

function captureRecords(raw) {
  const records = [];
  const lines = decoder.decode(raw).split(/\r?\n/);
  const summaryLines = lines.map(stripVTControlCharacters).filter((line) => /^\s*Tests\s+/.test(line));
  assert.equal(summaryLines.length, 1, "capture needs exactly one complete full-suite summary");
  assert(
    /^\s*Tests\s+61 passed \(61\)\s*$/.test(summaryLines[0]),
    "capture requires all 61 tests passed, no failed/skipped cases",
  );
  const fileSummaries = lines.map(stripVTControlCharacters).filter((line) => /^\s*Test Files\s+/.test(line));
  assert.equal(fileSummaries.length, 1, "capture needs exactly one test-file summary");
  assert(/^\s*Test Files\s+1 passed \(1\)\s*$/.test(fileSummaries[0]), "capture suite file failed or is incomplete");
  assert(!lines.some((line) => /^\s*Errors\s+/.test(stripVTControlCharacters(line))), "capture reports runner errors");
  for (const line of lines) {
    checkBudget("capture parsing");
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      assert(!trimmed.includes("artifact-capture"), "malformed capture record");
      continue;
    }
    let value;
    try {
      value = JSON.parse(trimmed);
    } catch (error) {
      assert(!trimmed.includes("artifact-capture"), `malformed capture JSON: ${error.message}`);
      continue;
    }
    assert(
      !(value?.issue === 6892 && ["instrument", "measurement"].includes(value.kind)),
      "legacy instrument records are not capture evidence",
    );
    if (typeof value?.kind !== "string" || !value.kind.startsWith("artifact-capture")) continue;
    assert.equal(value.issue, 6892);
    assert.equal(value.schemaVersion, 1);
    finiteNumbers(value);
    records.push(value);
  }
  assert.equal(records.length, 10, "expected one start, eight artifacts, one complete footer");
  assert.equal(records[0].kind, "artifact-capture-start");
  assert.equal(records.at(-1).kind, "artifact-capture-complete");
  for (const row of records.slice(1, -1)) assert.equal(row.kind, "artifact-capture");
  return records;
}

function canonicalBase64(text, maximum, label) {
  assert.equal(typeof text, "string", `${label} must be base64 text`);
  assert(text.length <= Math.ceil(maximum / 3) * 4, `${label} exceeds byte limit`);
  const bytes = Buffer.from(text, "base64");
  assert(bytes.length <= maximum, `${label} exceeds byte limit`);
  assert.equal(bytes.toString("base64"), text, `${label} base64 is not canonical`);
  return bytes;
}

function parseCapture(raw, arm, approvedTestHash) {
  const records = captureRecords(raw);
  const start = records[0];
  const footer = records.at(-1);
  exactKeys(start, [
    "issue",
    "kind",
    "schemaVersion",
    "sourceEpoch",
    "head",
    "sourceTree",
    "epochSourceTree",
    "sourceClean",
    "kernelSha256",
    "testSha256",
    "lockfileName",
    "lockfileSha256",
    "node",
    "v8",
    "platform",
    "arch",
    "execPath",
    "execArgv",
    "nodeOptions",
    "lane",
    "harness",
    "flags",
    "compileConfiguration",
    "caseIds",
    "count",
  ]);
  assert.equal(start.sourceEpoch, EPOCHS[arm].revision);
  assert.equal(start.sourceTree, EPOCHS[arm].sourceTree);
  assert.equal(start.epochSourceTree, EPOCHS[arm].sourceTree);
  assert.equal(start.sourceClean, true);
  assert.equal(typeof start.head, "string");
  assert(/^[a-f0-9]{40}$/.test(start.head), "invalid recorded HEAD");
  assert.equal(start.kernelSha256, EPOCHS[arm].kernelSha256);
  assert.equal(start.testSha256, approvedTestHash);
  assert.equal(start.lockfileName, "pnpm-lock.yaml");
  assert.equal(start.lockfileSha256, LOCK_SHA256);
  assert.equal(start.node, NODE_VERSION);
  assert.equal(start.v8, V8_VERSION);
  assert.equal(start.platform, process.platform);
  assert.equal(start.arch, process.arch);
  nonemptyString(start.execPath, "producer execPath");
  assert(Array.isArray(start.execArgv) && start.execArgv.every((arg) => typeof arg === "string"));
  assert.equal(start.nodeOptions, "");
  assert.equal(start.lane, "linear");
  assert.equal(start.harness, "tests/issue-6892-linear-repeat-bulk-copy.test.ts");
  assert.deepEqual(start.flags, { JS2WASM_LINEAR_IR: "1", JS2WASM_IR_STRING_BUILDER: "1" });
  const compileConfiguration = { target: "linear", optimize: false, emitWat: true, allocator: "arena-reset" };
  assert.deepEqual(start.compileConfiguration, compileConfiguration);
  const caseIds = CASES.map((testCase) => testCase.caseId);
  assert.deepEqual(start.caseIds, caseIds);
  assert.equal(start.count, 8);
  exactKeys(footer, ["issue", "kind", "schemaVersion", "status", "count", "caseIds", "binarySha256s", "elapsedMs"]);
  assert.equal(footer.status, "complete");
  assert.equal(footer.count, 8);
  assert.deepEqual(footer.caseIds, caseIds);
  assert(typeof footer.elapsedMs === "number" && footer.elapsedMs >= 0 && footer.elapsedMs < 30000);
  const artifacts = records.slice(1, -1).map((row, ordinal) => {
    checkBudget(`before ${arm} artifact validation ${ordinal}`);
    exactKeys(row, [
      "issue",
      "kind",
      "schemaVersion",
      "ordinal",
      "caseId",
      "fragment",
      "count",
      "source",
      "sourceSha256",
      "fileName",
      "compileOptions",
      "binaryBase64",
      "binaryByteLength",
      "binarySha256",
      "imports",
      "exports",
      "outputBytes",
      "estimatedAllocationPerCall",
      "calls",
      "semanticWitness",
      "receiptWitness",
      "repeatCount",
    ]);
    const testCase = CASES[ordinal];
    assert.equal(row.ordinal, ordinal);
    assert.equal(row.caseId, testCase.caseId);
    assert.equal(row.fragment, testCase.fragment);
    assert.equal(row.count, testCase.count);
    const expectedSource = `export function run(): string {
    let value = "seed";
    for (let index = 0; index < ${testCase.count}; index++) value = value + ${JSON.stringify(testCase.fragment)};
    return value;
  }`;
    assert.equal(row.source, expectedSource, "source differs from producer's exact counted fixture");
    assert.equal(row.sourceSha256, sha256(row.source));
    assert.equal(row.fileName, `issue-6892-${testCase.caseId}.ts`);
    assert.deepEqual(row.compileOptions, { ...compileConfiguration, fileName: row.fileName });
    const binary = canonicalBase64(row.binaryBase64, MAX_BINARY_BYTES, "artifact binary");
    assert(binary.length > 0);
    assert.equal(row.binaryByteLength, binary.length);
    assert.equal(row.binarySha256, sha256(binary));
    assert.deepEqual(row.imports, []);
    validateExports(row.exports);
    assert.equal(row.outputBytes, testCase.expectedBytes.length);
    assert.equal(row.estimatedAllocationPerCall, testCase.estimatedAllocationPerCall);
    assert.equal(row.calls, testCase.calls);
    assert.equal(row.calls, [256, 256, 252, 3, 256, 256, 168, 2][ordinal]);
    assert.equal(row.repeatCount, 1);
    validateWitness(row, testCase);
    checkBudget(`after ${arm} artifact validation ${ordinal}`);
    // Only declared binary differences are removed from cross-arm evidence.
    const { binaryBase64, binaryByteLength, binarySha256, ...commonEvidence } = row;
    return { binary, exports: row.exports, binarySha256, commonEvidence };
  });
  assert.deepEqual(
    footer.binarySha256s,
    artifacts.map((artifact) => artifact.binarySha256),
  );
  const { sourceEpoch, head, sourceTree, epochSourceTree, kernelSha256, ...commonProvenance } = start;
  return { start, footer, commonProvenance, artifacts };
}

function exactKeys(value, keys) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "expected capture object");
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), "capture schema keys differ");
}

function nonemptyString(value, label) {
  assert(typeof value === "string" && value.length > 0, `${label} must be a nonempty string`);
}

function validateExports(descriptions) {
  assert(Array.isArray(descriptions), "exports must be an array");
  const names = new Set();
  for (const item of descriptions) {
    exactKeys(item, ["name", "kind"]);
    nonemptyString(item.name, "export name");
    assert(["function", "memory", "table", "global", "tag"].includes(item.kind));
    assert(!names.has(item.name), "duplicate export name");
    names.add(item.name);
  }
  for (const [name, kind] of [
    ["run", "function"],
    ["memory", "memory"],
    ["__arena_used", "function"],
  ]) {
    assert(
      descriptions.some((item) => item.name === name && item.kind === kind),
      `missing export ${name}`,
    );
  }
}

function validateWitness(row, testCase) {
  // These are consistency checks on untrusted serialized producer evidence,
  // not re-authentication of compiler receipt objects or source admission.
  const witness = row.semanticWitness;
  exactKeys(witness, ["caseId", "fragment", "count", "compiled", "rejected", "associations", "output"]);
  assert.equal(witness.caseId, testCase.caseId);
  assert.equal(witness.fragment, testCase.fragment);
  assert.equal(witness.count, testCase.count);
  assert.deepEqual(witness.compiled, ["run"]);
  assert.deepEqual(witness.rejected, []);
  const association = witness.associations;
  exactKeys(association, ["owner", "siteId", "parsed", "planOwner", "planSource", "repeatSite", "encoding", "binding"]);
  exactKeys(association.owner, ["outcome", "ownerUnitId", "legacyName"]);
  assert.equal(association.owner.outcome, "compiled");
  assert.equal(association.owner.legacyName, "run");
  nonemptyString(association.planOwner, "plan owner");
  nonemptyString(association.planSource, "plan source");
  assert.equal(association.owner.ownerUnitId, association.planOwner);
  const parsed = association.parsed;
  exactKeys(parsed, ["sourceId", "ownerUnitId", "loopStart", "loopEnd"]);
  assert.equal(parsed.sourceId, association.planSource);
  assert.equal(parsed.ownerUnitId, association.planOwner);
  assert(Number.isSafeInteger(parsed.loopStart) && Number.isSafeInteger(parsed.loopEnd));
  assert.equal(parsed.loopStart, row.source.indexOf("for ("));
  assert.equal(parsed.loopEnd, row.source.indexOf(";\n    return value;") + 1);
  assert(parsed.loopEnd > parsed.loopStart);
  const sourceMatch = /^ir-source:v1:([0-9]{16}):entry:([^:]+)$/.exec(parsed.sourceId);
  assert(sourceMatch, "source witness must identify the entry source");
  assert(Number.isSafeInteger(Number(sourceMatch[1])));
  assert.equal(Number(sourceMatch[1]).toString().padStart(16, "0"), sourceMatch[1]);
  assert.equal(sourceMatch[2], encodeURIComponent(row.fileName));
  const ownerPrefix = `ir-unit:v1:${encodeURIComponent(parsed.sourceId)}:root:top-level-function:`;
  assert(parsed.ownerUnitId.startsWith(ownerPrefix), "owner is not the source-qualified top-level function");
  const ownerOrdinal = parsed.ownerUnitId.slice(ownerPrefix.length);
  assert(/^[0-9]{16}$/.test(ownerOrdinal) && Number.isSafeInteger(Number(ownerOrdinal)));
  assert.equal(Number(ownerOrdinal).toString().padStart(16, "0"), ownerOrdinal);
  const expectedSite = `ir-counted-string-append-site:v1:${encodeURIComponent(parsed.sourceId)}:${encodeURIComponent(parsed.ownerUnitId)}:${parsed.loopStart.toString().padStart(16, "0")}:${parsed.loopEnd.toString().padStart(16, "0")}`;
  assert.equal(association.siteId, expectedSite);
  assert.equal(association.repeatSite, expectedSite);
  assert.equal(association.encoding, "ascii");
  assert.deepEqual(association.binding, { kind: "intrinsic", symbol: "__ir_string_repeat" });
  const receipt = row.receiptWitness;
  exactKeys(receipt, ["count", "siteId", "planSiteId", "tripCount", "planOwner", "planSource"]);
  assert.equal(receipt.count, 1);
  assert.equal(receipt.siteId, expectedSite);
  assert.equal(receipt.planSiteId, expectedSite);
  assert.equal(receipt.tripCount, testCase.count);
  assert.equal(receipt.planOwner, parsed.ownerUnitId);
  assert.equal(receipt.planSource, parsed.sourceId);
  const output = witness.output;
  exactKeys(output, ["pointer", "capacity", "length", "bytes", "text"]);
  assert(Number.isInteger(output.pointer) && output.pointer >= 0 && output.pointer <= 0xffffffff);
  assert.equal(output.capacity, testCase.expectedBytes.length + 4);
  assert.equal(output.length, testCase.expectedBytes.length);
  assert.equal(output.text, testCase.expectedText);
  assert(Array.isArray(output.bytes) && output.bytes.length === testCase.expectedBytes.length);
  assert(output.bytes.every((value) => Number.isInteger(value) && value >= 0 && value <= 255));
  assert(Buffer.from(output.bytes).equals(testCase.expectedBytes), "capture full output bytes differ, including seed");
}

function processInfo() {
  return {
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    execArgv: process.execArgv,
    nodeOptions: process.env.NODE_OPTIONS ?? "",
  };
}

function outputRecord(memory, rawPointer, testCase) {
  assert(
    Number.isInteger(rawPointer) && rawPointer >= -0x80000000 && rawPointer <= 0xffffffff,
    "run returned an invalid i32 pointer",
  );
  const pointer = rawPointer >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  assert(pointer + 12 <= bytes.length, "output header outside memory");
  const view = new DataView(memory.buffer);
  const capacity = view.getUint32(pointer + 4, true);
  const length = view.getUint32(pointer + 8, true);
  assert.equal(length, testCase.expectedBytes.length);
  assert.equal(capacity, length + 4);
  assert(pointer + 12 + length <= bytes.length, "output payload outside memory");
  const payload = Buffer.from(bytes.subarray(pointer + 12, pointer + 12 + length));
  assert(payload.equals(testCase.expectedBytes), "full output bytes differ");
  const text = decoder.decode(payload);
  assert.equal(text, testCase.expectedText);
  // Retain the full observed payload in every batch, outside the timed loop.
  return { pointer, capacity, length, bytes: Array.from(payload), text, bytesSha256: sha256(payload) };
}

// Identical caller and loop for warmup and measured batches, both arms.
function timedLoop(run, calls) {
  let pointer = 0;
  let checksum = 0;
  const t0 = performance.now();
  for (let call = 0; call < calls; call++) {
    pointer = run();
    checksum = (Math.imul(checksum, 31) + pointer) >>> 0;
  }
  const elapsedMs = performance.now() - t0;
  return { pointer, checksum, elapsedMs };
}

function batch(module, testCase, context, reference) {
  checkBudget("before batch instantiation");
  const instance = new WebAssembly.Instance(module);
  checkBudget("after batch instantiation");
  const exports = instance.exports;
  assert.equal(typeof exports.run, "function");
  assert.equal(typeof exports.__arena_used, "function");
  assert(exports.memory instanceof WebAssembly.Memory);
  const before = { used: exports.__arena_used(), memoryBytes: exports.memory.buffer.byteLength };
  assert.equal(before.used, 0);
  assert(
    before.memoryBytes > 0 && before.memoryBytes <= 16 * 1024 * 1024,
    "initial memory exceeds the captured Linear limit",
  );
  const initialMemory = Buffer.from(new Uint8Array(exports.memory.buffer));
  if (reference) {
    assert.deepEqual(before, reference.before);
    assert(initialMemory.equals(reference.initialMemory), "full initial memory differs within quartet");
  }
  checkBudget("before timed loop");
  const timed = timedLoop(exports.run, testCase.calls);
  checkBudget("after timed loop");
  assert(Number.isFinite(timed.elapsedMs) && timed.elapsedMs >= 0, "invalid elapsed time");
  const output = outputRecord(exports.memory, timed.pointer, testCase);
  const after = { used: exports.__arena_used(), memoryBytes: exports.memory.buffer.byteLength };
  assert(Number.isInteger(after.used) && after.used >= before.used, "invalid arena usage");
  assert(after.used - before.used <= testCase.calls * testCase.estimatedAllocationPerCall);
  assert(after.used - before.used <= ALLOCATION_LIMIT);
  assert(after.memoryBytes >= before.memoryBytes);
  assert(after.memoryBytes <= 16 * 1024 * 1024, "final memory exceeds the captured Linear limit");
  const finalMemory = Buffer.from(new Uint8Array(exports.memory.buffer));
  const state = {
    pointer: timed.pointer,
    checksum: timed.checksum,
    output,
    before,
    after,
    growthBytes: after.memoryBytes - before.memoryBytes,
  };
  if (reference) {
    assert.deepEqual(state, reference.state, "quartet output/allocation/checksum state differs");
    assert(finalMemory.equals(reference.finalMemory), "full final memory differs within quartet");
  }
  checkBudget("after full batch comparisons");
  record("paired-batch", {
    caseId: testCase.caseId,
    ...context,
    calls: testCase.calls,
    elapsedMs: timed.elapsedMs,
    ...state,
    initialMemorySha256: sha256(initialMemory),
    finalMemorySha256: sha256(finalMemory),
    initialMemoryByteLength: initialMemory.length,
    finalMemoryByteLength: finalMemory.length,
    equality: reference ? "exact-full-bytes-and-state" : "quartet-reference",
  });
  completedBatches++;
  return {
    elapsedMs: timed.elapsedMs,
    reference: reference ?? { initialMemory, finalMemory, before, state },
  };
}

function distribution(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const median = (values) => {
    const middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  };
  const center = median(sorted);
  return {
    samples,
    median: center,
    min: sorted[0],
    max: sorted.at(-1),
    mad: median(samples.map((value) => Math.abs(value - center)).sort((a, b) => a - b)),
  };
}

function replayCase(testCase, artifacts) {
  const modules = {};
  for (const arm of ["A", "B"]) {
    checkBudget("before module compilation");
    const binary = artifacts[arm].binary;
    assert(WebAssembly.validate(binary), "captured Wasm does not validate");
    checkBudget("after module validation");
    modules[arm] = new WebAssembly.Module(binary);
    checkBudget("after module compilation");
    assert.deepEqual(WebAssembly.Module.imports(modules[arm]), []);
    const descriptions = WebAssembly.Module.exports(modules[arm]);
    assert.deepEqual(descriptions, artifacts[arm].exports);
    for (const [name, kind] of [
      ["run", "function"],
      ["memory", "memory"],
      ["__arena_used", "function"],
    ]) {
      assert(
        descriptions.some((item) => item.name === name && item.kind === kind),
        `missing export ${name}`,
      );
    }
  }
  assert.deepEqual(WebAssembly.Module.exports(modules.A), WebAssembly.Module.exports(modules.B));
  record("paired-case-output", {
    caseId: testCase.caseId,
    fragment: testCase.fragment,
    count: testCase.count,
    outputBase64: testCase.expectedBytes.toString("base64"),
    outputText: testCase.expectedText,
    outputSha256: sha256(testCase.expectedBytes),
    outputBytes: testCase.expectedBytes.length,
    estimatedAllocationPerCall: testCase.estimatedAllocationPerCall,
    calls: testCase.calls,
    binarySha256s: { A: artifacts.A.binarySha256, B: artifacts.B.binarySha256 },
  });
  const samples = { A: [], B: [] };
  const ratios = [];
  const orders = [];
  let sufficientResolution = true;
  for (let quartet = 0; quartet < 14; quartet++) {
    const order = quartet % 2 === 0 ? "ABBA" : "BAAB";
    const quartetPhase = quartet < 2 ? "warmup" : "measured";
    let reference;
    const times = { A: [], B: [] };
    for (let position = 0; position < 4; position++) {
      const arm = order[position];
      const result = batch(modules[arm], testCase, { phase: quartetPhase, quartet, position, order, arm }, reference);
      reference = result.reference;
      times[arm].push(result.elapsedMs);
      if (quartetPhase === "measured") samples[arm].push(result.elapsedMs);
    }
    reference = undefined;
    if (quartetPhase === "measured") {
      const resolved = [...times.A, ...times.B].every((time) => time > 0 && Number.isFinite(time));
      const ratio = resolved ? (times.A[0] + times.A[1]) / (times.B[0] + times.B[1]) : null;
      const valid = ratio !== null && Number.isFinite(ratio) && ratio > 0;
      sufficientResolution &&= valid;
      ratios.push(valid ? ratio : null);
      orders.push(order);
      record("paired-quartet", { caseId: testCase.caseId, quartet, order, times, ratio: valid ? ratio : null });
    }
  }
  assert.equal(samples.A.length, 24);
  assert.equal(samples.B.length, 24);
  assert.equal(ratios.length, 12);
  const classification = !sufficientResolution
    ? "insufficient-resolution; performance-unresolved"
    : ratios.every((ratio) => ratio > 1)
      ? "consistent-observed-candidate-benefit"
      : ratios.every((ratio) => ratio < 1)
        ? "consistent-observed-candidate-regression"
        : "mixed; performance-unresolved";
  const result = {
    caseId: testCase.caseId,
    classification,
    ratios,
    arms: { A: distribution(samples.A), B: distribution(samples.B) },
    ratioDistribution: sufficientResolution ? distribution(ratios) : null,
    byOrder: sufficientResolution
      ? Object.fromEntries(
          ["ABBA", "BAAB"].map((order) => [order, distribution(ratios.filter((_, i) => orders[i] === order))]),
        )
      : null,
    firstSix: sufficientResolution ? distribution(ratios.slice(0, 6)) : null,
    lastSix: sufficientResolution ? distribution(ratios.slice(6)) : null,
  };
  record("paired-case-complete", result);
  completedCases++;
  return result;
}

function argumentsForReplay() {
  const args = process.argv.slice(2);
  assert.equal(args.length, 6, "usage: --baseline <log> --candidate <log> --test-sha256 <approved hash>");
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    assert(["--baseline", "--candidate", "--test-sha256"].includes(args[i]), "unknown replay argument");
    assert(!Object.hasOwn(values, args[i]), "duplicate replay argument");
    assert(args[i + 1] && !args[i + 1].startsWith("--"), "missing replay argument value");
    values[args[i]] = args[i + 1];
  }
  assert(/^[a-f0-9]{64}$/.test(values["--test-sha256"]), "approved test hash must be canonical SHA256");
  assert.equal(values["--test-sha256"], APPROVED_TEST_SHA256, "test hash differs from the reviewed frozen producer");
  return values;
}

try {
  const args = argumentsForReplay();
  const processConfiguration = processInfo();
  assert.equal(process.version, NODE_VERSION);
  assert.equal(process.versions.v8, V8_VERSION);
  assert.deepEqual(process.execArgv, [], "primary replay requires no execArgv");
  assert.equal(process.env.NODE_OPTIONS ?? "", "", "primary replay requires empty NODE_OPTIONS");
  checkBudget("before runner hashing");
  const runnerSha256 = sha256(readFileSync(fileURLToPath(import.meta.url)));
  const raw = { A: readBounded(args["--baseline"]), B: readBounded(args["--candidate"]) };
  record("paired-replay-start", {
    epochs: EPOCHS,
    runnerSha256,
    testSha256: args["--test-sha256"],
    inputSha256: { A: sha256(raw.A), B: sha256(raw.B) },
    process: processConfiguration,
    caseIds: CASES.map((testCase) => testCase.caseId),
    plannedBatches: 448,
    lifecycle: "shared compiled modules; fresh instances; no reset, pre-growth, forced GC or tier claims",
  });
  const captures = {
    A: parseCapture(raw.A, "A", args["--test-sha256"]),
    B: parseCapture(raw.B, "B", args["--test-sha256"]),
  };
  assert.deepEqual(captures.A.commonProvenance, captures.B.commonProvenance);
  for (let i = 0; i < CASES.length; i++) {
    checkBudget("cross-arm capture witness comparison");
    assert.deepEqual(
      captures.A.artifacts[i].commonEvidence,
      captures.B.artifacts[i].commonEvidence,
      `capture source/config/semantic/receipt/export evidence differs for ${CASES[i].caseId}`,
    );
  }
  record("paired-captures-verified", {
    producer: captures.A.commonProvenance,
    heads: { A: captures.A.start.head, B: captures.B.start.head },
    sourceEpochs: { A: captures.A.start.sourceEpoch, B: captures.B.start.sourceEpoch },
    captureFooters: { A: captures.A.footer, B: captures.B.footer },
    suitePassedPerArm: 61,
    witnessClassification: "serialized producer consistency; no new receipt authentication",
    originalFunctionalRows: "90-row comparison belongs to parent; not performed by replay",
  });
  const results = CASES.map((testCase, i) =>
    replayCase(testCase, { A: captures.A.artifacts[i], B: captures.B.artifacts[i] }),
  );
  assert.equal(completedBatches, 448);
  assert.equal(completedCases, 8);
  record("paired-replay-complete", {
    status: "complete",
    completedBatches,
    completedCases,
    allEqualityChecksPassed: true,
    elapsedMs: performance.now() - started,
    results,
    acceptance: "parent review required; no hold or queue change",
  });
} catch (error) {
  process.exitCode = 1;
  // Error reporting remains available even after the budget is exhausted.
  process.stdout.write(
    JSON.stringify({
      issue: 6892,
      schemaVersion: 1,
      kind: "paired-replay-incomplete",
      status: "incomplete",
      phase,
      completedBatches,
      completedCases,
      elapsedMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error),
    }) + "\n",
  );
}
