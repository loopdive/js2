// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Harness request/IPC DATA only. No serialized Prepared capability or cache authority.
import { createHash } from "node:crypto";

function fail(detail) {
  throw new Error(`PREPARED_TRANSPORT_INVALID: ${detail}`);
}
function data(object, key) {
  const field = Object.getOwnPropertyDescriptor(object, key);
  if (!field) {
    if (key in object) fail(`inherited ${key}`);
    return undefined;
  }
  if (!("value" in field)) fail(`${key} must be DATA`);
  return field.value;
}

/** Capture exact demand before any caller option copying/getter evaluation. */
export function capturePreparedJobRequest(options, targetOverride) {
  if (options === undefined) return undefined;
  if (options === null || typeof options !== "object") fail("options must be an object");
  const request = data(options, "wholeProgram");
  if (request === undefined) return undefined;
  if (request === null || typeof request !== "object") fail("request must be versioned DATA");
  const prototype = Object.getPrototypeOf(request);
  const fields = Object.getOwnPropertyDescriptors(request);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Reflect.ownKeys(fields).length !== 2 ||
    !fields.kind ||
    !("value" in fields.kind) ||
    fields.kind.value !== "prepared-program-required" ||
    !fields.version ||
    !("value" in fields.version) ||
    fields.version.value !== 1
  )
    fail("unknown request shape/version");
  const selectedBackend = data(options, "backend");
  const backend = selectedBackend === undefined ? "wasmgc" : selectedBackend;
  const target = targetOverride !== undefined ? targetOverride : data(options, "target");
  if (backend !== "wasmgc" && backend !== "linear") fail("unknown native backend");
  if (target !== "standalone" && target !== "wasi") fail("required native target is unavailable");
  return Object.freeze({
    wholeProgram: Object.freeze({ kind: "prepared-program-required", version: 1 }),
    backend,
    target,
  });
}

export function refusePreparedArtifactPaths(request, wasmPath, metaPath) {
  if (request && (wasmPath !== undefined || metaPath !== undefined))
    fail("strict artifact cache paths are unavailable; no legacy artifact read/write");
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Called only with the worker's own namespace import and SAME actual successful result. */
export function observePreparedJobResult(compiler, result, request, source, jobId, workerPid) {
  if (typeof compiler.requiredPreparedEmission !== "function") fail("compiler bundle lacks actual emission reporter");
  const emitted = compiler.requiredPreparedEmission(result);
  if (!emitted) fail("result is not an actual required Prepared emission");
  if (emitted.target !== request.target || emitted.backend !== request.backend) fail("actual emission profile differs");
  if (result.success !== true || !(result.binary instanceof Uint8Array) || result.binary.byteLength === 0)
    fail("actual successful binary missing");
  if (
    !Number.isSafeInteger(jobId) ||
    jobId < 0 ||
    !Number.isSafeInteger(workerPid) ||
    workerPid <= 0 ||
    typeof source !== "string"
  )
    fail("job/source/process association missing");
  return Object.freeze({
    schema: "test262-prepared-compile-report-v1",
    requestVersion: 1,
    jobId,
    workerPid,
    backend: emitted.backend,
    target: emitted.target,
    sourceSha256: hash(source),
    binarySha256: hash(result.binary),
    binaryBytes: result.binary.byteLength,
  });
}

/** Reporting validation, never proof that a caller-shaped packet is a compiler owner. */
export function validatePreparedJobResponse(message, request, source, jobId, workerPid) {
  if (!Number.isSafeInteger(jobId) || jobId < 0 || !Number.isSafeInteger(workerPid) || workerPid <= 0)
    fail("expected job/process association missing");
  const report = data(message, "preparedReport");
  if (report === null || typeof report !== "object") fail("actual report missing");
  const keys = [
    "schema",
    "requestVersion",
    "jobId",
    "workerPid",
    "backend",
    "target",
    "sourceSha256",
    "binarySha256",
    "binaryBytes",
  ];
  if (Reflect.ownKeys(report).length !== keys.length) fail("unexpected report fields");
  const values = Object.fromEntries(keys.map((key) => [key, data(report, key)]));
  const binary = data(message, "binary");
  if (
    data(message, "ok") !== true ||
    data(message, "id") !== jobId ||
    values.schema !== "test262-prepared-compile-report-v1" ||
    values.requestVersion !== 1 ||
    values.jobId !== jobId ||
    values.workerPid !== workerPid ||
    values.backend !== request.backend ||
    values.target !== request.target ||
    values.sourceSha256 !== hash(source) ||
    !(binary instanceof Uint8Array) ||
    binary.byteLength === 0 ||
    values.binaryBytes !== binary.byteLength ||
    values.binarySha256 !== hash(binary)
  )
    fail("job/profile/source/binary report mismatch");
}

/** Same fixed constructor product only. Serialized DATA reports, never a portable capability. */
export function observePreparedExecutionJobResult(compiler, result, execution, request, source, jobId, workerPid) {
  if (typeof compiler.preparedRuntimeExecutionObservation !== "function")
    fail("compiler bundle lacks actual runtime owner");
  const initial = compiler.preparedRuntimeExecutionObservation(execution);
  if (!initial) fail("actual execution product missing; error/start failure owner is unavailable");
  if (typeof compiler.requiredPreparedFinalArtifactObservation !== "function")
    fail("final artifact conjunction unavailable");
  const artifact = compiler.requiredPreparedFinalArtifactObservation(result);
  if (!artifact || artifact.base !== initial.base) fail("result is not the SAME actual engine artifact");
  const observed = compiler.preparedRuntimeExecutionObservation(execution, result.binary, execution.imports);
  if (
    !observed ||
    observed.actualRuntimeContext !== "GENUINE_FIXED_CONSTRUCTION_AND_INSTANCE" ||
    observed.actualBinary !== "MATCHED_ACTUAL_ENGINE_OPERAND" ||
    observed.actualImports !== "MATCHED_ACTUAL_ENGINE_OPERAND"
  )
    fail("same actual engine product is not owned");
  const base = observed.base;
  if (base.target !== request.target || base.backend !== request.backend) fail("actual execution profile differs");
  if (
    !Array.isArray(base.units.sources) ||
    !base.units.sources.length ||
    !Array.isArray(base.units.original) ||
    !base.units.original.length ||
    !Array.isArray(base.units.emitted) ||
    !base.units.emitted.length ||
    base.units.emitted.length !== base.units.physical.length ||
    !base.units.abi.length ||
    result.success !== true ||
    !Array.isArray(result.errors) ||
    result.errors.length !== 0
  )
    fail("complete successful units/errors are missing");
  if (
    !Number.isSafeInteger(jobId) ||
    jobId < 0 ||
    !Number.isSafeInteger(workerPid) ||
    workerPid <= 0 ||
    typeof source !== "string"
  )
    fail("actual execution job association missing");
  return Object.freeze({
    schema: "test262-prepared-execution-report-v1",
    jobId,
    workerPid,
    backend: base.backend,
    target: base.target,
    sourceSha256: hash(source),
    binaryBytes: result.binary.byteLength,
    emittedUnits: base.units.emitted.length,
  });
}
export function validatePreparedExecutionJobResponse(message, request, source, jobId, workerPid) {
  const report = data(message, "preparedExecutionReport");
  if (!report || typeof report !== "object")
    fail("genuine execution report missing; failed-compilation/constructor error owner is unavailable");
  const keys = ["schema", "jobId", "workerPid", "backend", "target", "sourceSha256", "binaryBytes", "emittedUnits"];
  if (Reflect.ownKeys(report).length !== keys.length) fail("unknown execution reporting fields");
  const r = Object.fromEntries(keys.map((key) => [key, data(report, key)]));
  if (
    data(message, "id") !== jobId ||
    !["pass", "fail", "compile_error"].includes(data(message, "status")) ||
    r.schema !== "test262-prepared-execution-report-v1" ||
    r.jobId !== jobId ||
    r.workerPid !== workerPid ||
    r.backend !== request.backend ||
    r.target !== request.target ||
    r.sourceSha256 !== hash(source) ||
    !Number.isSafeInteger(r.binaryBytes) ||
    r.binaryBytes <= 8 ||
    !Number.isSafeInteger(r.emittedUnits) ||
    r.emittedUnits <= 0
  )
    fail("active execution job/profile/source reporting mismatch");
}

// Frontend rejection is a distinct compiler observation. These DATA packets
// never establish emission, physical lowering, runtime construction or execution.
function frontendRecord(value, detail) {
  if (
    value === null ||
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    fail(`${detail} must be a plain DATA record`);
  return value;
}

function frontendData(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1)
      fail("frontend DATA array has extra or missing fields");
    return Object.freeze(Array.from({ length: value.length }, (_, index) => frontendData(data(value, String(index)))));
  }
  frontendRecord(value, "frontend metadata");
  const copy = Object.create(null);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) fail("frontend metadata has a symbol field");
  for (const key of keys.sort()) {
    const field = data(value, key);
    // IPC drops undefined record fields; omit them in the producer snapshot too.
    if (field !== undefined) Object.defineProperty(copy, key, { value: frontendData(field), enumerable: true });
  }
  return Object.freeze(copy);
}

/** Snapshot the active job's expectation before dispatch; no compiler authority. */
export function capturePreparedFrontendJobExpectation(job) {
  frontendRecord(job, "frontend job");
  const fixtureFiles = data(job, "fixtureFiles");
  const fixtures = fixtureFiles === undefined ? undefined : frontendData(frontendRecord(fixtureFiles, "fixtures"));
  if (fixtures && Object.values(fixtures).some((text) => typeof text !== "string")) fail("fixture source must be text");
  return Object.freeze({
    isNegative: data(job, "isNegative"),
    isRuntimeNegative: data(job, "isRuntimeNegative"),
    negativePhase: data(job, "negativePhase"),
    expectedErrorType: data(job, "expectedErrorType"),
    originalHarness: data(job, "originalHarness"),
    entryFile: data(job, "entryFile"),
    requiresEntrySelfImportGraph: data(job, "requiresEntrySelfImportGraph"),
    fixtureFiles: fixtures,
  });
}

function frontendExpectedPhase(expectation) {
  if (
    data(expectation, "isNegative") !== true ||
    data(expectation, "isRuntimeNegative") !== false ||
    data(expectation, "expectedErrorType") !== "SyntaxError"
  )
    fail("frontend report requires an exact non-runtime SyntaxError negative");
  const expected = data(expectation, "negativePhase");
  if (expected !== "parse" && expected !== "early") fail("frontend negative phase is unavailable");
  return expected;
}

function frontendPhaseMatches(phase, expected) {
  // The shared early-error owner also supplies static SyntaxErrors required by
  // Test262 parse negatives that TypeScript's syntactic parser accepts.
  return expected === "parse" ? phase === "syntax" || phase === "early" : phase === "early";
}

// Match the public virtual-source spelling without importing the compiler or
// invoking another parser. This normalizes paths only, never source contents.
function frontendFileName(name) {
  if (typeof name !== "string" || name.length === 0) fail("frontend source filename missing");
  if (name.startsWith("file:")) {
    const url = new URL(name);
    if (url.protocol !== "file:" || url.search || url.hash) fail("unsupported frontend source URL");
    name = (url.hostname && url.hostname !== "localhost" ? `/${url.hostname}` : "") + decodeURIComponent(url.pathname);
  }
  const parts = [];
  for (const part of name.replaceAll("\\", "/").split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  }
  const normalized = parts.join("/");
  return /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(normalized) ? normalized : `${normalized}.ts`;
}

function frontendSources(rows) {
  if (!Array.isArray(rows) || rows.length === 0) fail("frontend full source graph missing");
  const names = new Set();
  const sources = frontendData(rows).map((row) => {
    frontendRecord(row, "frontend source");
    if (Reflect.ownKeys(row).length !== 2) fail("unknown frontend source fields");
    const file = frontendFileName(data(row, "file"));
    const text = data(row, "text");
    if (typeof text !== "string" || names.has(file)) fail("frontend source text/identity mismatch");
    names.add(file);
    return Object.freeze({ file, sourceSha256: hash(text) });
  });
  return Object.freeze(sources.sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0)));
}

function frontendExpectedSources(expectation, source) {
  if (typeof source !== "string") fail("active frontend source missing");
  const fixtures = data(expectation, "fixtureFiles");
  const entryFile = data(expectation, "entryFile");
  const graph =
    fixtures !== undefined &&
    (Reflect.ownKeys(fixtures).length > 0 || data(expectation, "requiresEntrySelfImportGraph") === true);
  if (!graph)
    return frontendSources([
      { file: data(expectation, "originalHarness") === true ? "test.js" : "test.ts", text: source },
    ]);
  if (data(expectation, "originalHarness") !== true || typeof entryFile !== "string")
    fail("active frontend fixture entry missing");
  const rows = Reflect.ownKeys(fixtures).map((file) => ({ file, text: data(fixtures, file) }));
  rows.push({ file: entryFile, text: source });
  return frontendSources(rows);
}

function frontendAssociation(request, source, jobId, workerPid, expectation) {
  if (
    !Number.isSafeInteger(jobId) ||
    jobId < 0 ||
    !Number.isSafeInteger(workerPid) ||
    workerPid <= 0 ||
    typeof source !== "string" ||
    !request ||
    (request.backend !== "wasmgc" && request.backend !== "linear") ||
    (request.target !== "standalone" && request.target !== "wasi")
  )
    fail("active frontend job/process/profile association missing");
  const captured = capturePreparedFrontendJobExpectation(expectation);
  return { expectedPhase: frontendExpectedPhase(captured), sources: frontendExpectedSources(captured, source) };
}

function frontendDiagnostics(diagnostics) {
  const copied = frontendData(diagnostics);
  if (!Array.isArray(copied) || copied.length === 0) fail("actual frontend diagnostics missing");
  for (const diagnostic of copied) {
    frontendRecord(diagnostic, "frontend diagnostic");
    if (
      typeof data(diagnostic, "message") !== "string" ||
      data(diagnostic, "message").trim().length === 0 ||
      !Number.isSafeInteger(data(diagnostic, "line")) ||
      data(diagnostic, "line") < 0 ||
      !Number.isSafeInteger(data(diagnostic, "column")) ||
      data(diagnostic, "column") < 0
    )
      fail("located frontend diagnostic missing");
  }
  if (!copied.some((diagnostic) => data(diagnostic, "severity") === "error")) fail("frontend error diagnostic missing");
  return copied;
}

/** SAME failed result, queried from the worker's actual compiler namespace only. */
export function observePreparedFrontendJobResult(compiler, result, request, source, jobId, workerPid, expectation) {
  const expected = frontendAssociation(request, source, jobId, workerPid, expectation);
  if (typeof compiler.requiredPreparedFrontendFailure !== "function") fail("compiler frontend reporter unavailable");
  const observed = compiler.requiredPreparedFrontendFailure(result);
  if (!observed) fail("actual frontend rejection is unavailable");
  if (data(result, "success") !== false) fail("frontend rejection requires the actual failed result");
  const phase = data(observed, "phase");
  if (
    data(observed, "schema") !== "test262-required-prepared-frontend-failure-v1" ||
    !frontendPhaseMatches(phase, expected.expectedPhase) ||
    data(observed, "backend") !== request.backend ||
    data(observed, "target") !== request.target ||
    JSON.stringify(frontendSources(data(observed, "sources"))) !== JSON.stringify(expected.sources)
  )
    fail("actual frontend phase/profile/full source graph differs");
  const diagnostics = frontendDiagnostics(data(observed, "diagnostics"));
  const errors = frontendDiagnostics(data(result, "errors")).map((row) => JSON.stringify(row));
  if (!diagnostics.every((diagnostic) => errors.includes(JSON.stringify(diagnostic))))
    fail("actual frontend diagnostics differ from the same result");
  return Object.freeze({
    schema: "test262-prepared-frontend-report-v1",
    requestVersion: 1,
    jobId,
    workerPid,
    backend: request.backend,
    target: request.target,
    sourceSha256: hash(source),
    sources: expected.sources,
    phase,
    expectedPhase: expected.expectedPhase,
    errorType: "SyntaxError",
    diagnostics,
  });
}

/** Validate reporting from the active builtin child; never a portable capability. */
export function validatePreparedFrontendJobResponse(message, request, source, jobId, workerPid, expectation) {
  const expected = frontendAssociation(request, source, jobId, workerPid, expectation);
  if (
    data(message, "id") !== jobId ||
    data(message, "status") !== "pass" ||
    data(message, "preparedExecutionReport") !== undefined ||
    data(message, "preparedReport") !== undefined ||
    data(message, "runtimeNegativePass") === true ||
    data(message, "binary") !== undefined
  )
    fail("frontend response cannot claim emission or execution");
  const report = frontendRecord(data(message, "preparedFrontendReport"), "frontend report");
  const keys = [
    "schema",
    "requestVersion",
    "jobId",
    "workerPid",
    "backend",
    "target",
    "sourceSha256",
    "sources",
    "phase",
    "expectedPhase",
    "errorType",
    "diagnostics",
  ];
  if (Reflect.ownKeys(report).length !== keys.length) fail("unknown frontend reporting fields");
  const copied = frontendData(report);
  const r = Object.fromEntries(keys.map((key) => [key, data(copied, key)]));
  if (
    r.schema !== "test262-prepared-frontend-report-v1" ||
    r.requestVersion !== 1 ||
    r.jobId !== jobId ||
    r.workerPid !== workerPid ||
    r.backend !== request.backend ||
    r.target !== request.target ||
    r.sourceSha256 !== hash(source) ||
    r.expectedPhase !== expected.expectedPhase ||
    !frontendPhaseMatches(r.phase, expected.expectedPhase) ||
    r.errorType !== "SyntaxError" ||
    JSON.stringify(r.sources) !== JSON.stringify(frontendData(expected.sources))
  )
    fail("active frontend job/process/profile/source/phase reporting mismatch");
  frontendDiagnostics(r.diagnostics);
  return copied;
}
