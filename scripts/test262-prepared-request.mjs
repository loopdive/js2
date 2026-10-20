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
