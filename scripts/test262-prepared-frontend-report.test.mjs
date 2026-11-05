// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Protocol DATA tests only: constructed IPC packets never establish compiler ownership.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  capturePreparedJobRequest,
  capturePreparedFrontendJobExpectation,
  observePreparedFrontendJobResult,
  validatePreparedFrontendJobResponse,
  validatePreparedExecutionJobResponse,
} from "./test262-prepared-request.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const source = "let = ;";
const request = capturePreparedJobRequest({
  wholeProgram: { kind: "prepared-program-required", version: 1 },
  target: "standalone",
});
const jobId = 7;
const workerPid = 1234;
const job = {
  isNegative: true,
  isRuntimeNegative: false,
  negativePhase: "parse",
  expectedErrorType: "SyntaxError",
  originalHarness: true,
};
function message(overrides = {}) {
  return {
    id: jobId,
    status: "pass",
    preparedFrontendReport: {
      schema: "test262-prepared-frontend-report-v1",
      requestVersion: 1,
      jobId,
      workerPid,
      backend: "wasmgc",
      target: "standalone",
      sourceSha256: hash(source),
      sources: [{ file: "test.js", sourceSha256: hash(source) }],
      phase: "syntax",
      expectedPhase: "parse",
      errorType: "SyntaxError",
      diagnostics: [
        { message: "Declaration expected", line: 1, column: 5, file: "test.js", code: 1128, severity: "error" },
      ],
      ...overrides,
    },
  };
}
function validate(
  packet,
  expectation = job,
  activeSource = source,
  activeRequest = request,
  id = jobId,
  pid = workerPid,
) {
  return validatePreparedFrontendJobResponse(packet, activeRequest, activeSource, id, pid, expectation);
}

test("validates frontend-only IPC DATA and freezes its delivered recursive metadata", () => {
  const packet = message();
  const report = validate(packet);
  assert.equal(report.phase, "syntax");
  assert.equal(report.errorType, "SyntaxError");
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.sources), true);
  assert.equal(Object.isFrozen(report.diagnostics[0]), true);
  packet.preparedFrontendReport.diagnostics[0].message = "changed after delivery";
  assert.equal(report.diagnostics[0].message, "Declaration expected");
  assert.equal(Object.hasOwn(report, "emittedUnits"), false);
  assert.equal(Object.hasOwn(report, "actualRuntimeContext"), false);
  assert.throws(
    () => validatePreparedExecutionJobResponse(packet, request, source, jobId, workerPid),
    /execution report missing/,
  );
});

test("requires the active job, process, backend, target and exact source", () => {
  for (const change of [
    { jobId: jobId + 1 },
    { workerPid: workerPid + 1 },
    { backend: "linear" },
    { target: "wasi" },
    { sourceSha256: hash("different") },
    { schema: "test262-prepared-execution-report-v1" },
    { requestVersion: 2 },
  ])
    assert.throws(() => validate(message(change)), /PREPARED_TRANSPORT_INVALID/);
  assert.throws(() => validate(message(), job, source, request, jobId + 1), /PREPARED_TRANSPORT_INVALID/);
  assert.throws(() => validate(message(), job, source, request, jobId, workerPid + 1), /PREPARED_TRANSPORT_INVALID/);
  assert.throws(() => validate(message(), job, "different"), /PREPARED_TRANSPORT_INVALID/);
  for (const id of [-1, NaN, 1.5]) assert.throws(() => validate(message(), job, source, request, id), /association/);
  for (const pid of [0, -1, NaN])
    assert.throws(() => validate(message(), job, source, request, jobId, pid), /association/);
});

test("retains parse versus early and rejects resolution, runtime and wrong expected error types", () => {
  assert.equal(
    validate(message({ phase: "early", expectedPhase: "early" }), { ...job, negativePhase: "early" }).phase,
    "early",
  );
  assert.equal(validate(message({ phase: "early" })).expectedPhase, "parse");
  for (const expectation of [
    { ...job, negativePhase: "early" },
    { ...job, negativePhase: "resolution" },
    { ...job, negativePhase: "runtime" },
    { ...job, negativePhase: undefined },
    { ...job, expectedErrorType: "TypeError" },
    { ...job, expectedErrorType: "syntaxerror" },
    { ...job, isNegative: false },
    { ...job, isRuntimeNegative: true },
  ])
    assert.throws(() => validate(message(), expectation), /PREPARED_TRANSPORT_INVALID/);
  assert.throws(() => validate(message({ errorType: "TypeError" })), /reporting mismatch/);
  assert.throws(() => validate(message({ phase: "resolution" })), /reporting mismatch/);
  assert.throws(
    () => validate(message({ phase: "syntax", expectedPhase: "early" }), { ...job, negativePhase: "early" }),
    /reporting mismatch/,
  );
});

test("checks all fixture sources and snapshots the expected graph before dispatch", () => {
  const fixtureFiles = { "./fixtures/dependency.js": "export const broken = ;" };
  const graphJob = { ...job, entryFile: "/cases/entry.js", fixtureFiles };
  const captured = capturePreparedFrontendJobExpectation(graphJob);
  const sources = [
    { file: "cases/entry.js", sourceSha256: hash(source) },
    { file: "fixtures/dependency.js", sourceSha256: hash(fixtureFiles["./fixtures/dependency.js"]) },
  ];
  assert.equal(validate(message({ sources }), captured).sources.length, 2);
  fixtureFiles["./fixtures/dependency.js"] = "changed";
  assert.equal(validate(message({ sources }), captured).sources.length, 2);
  assert.throws(() => validate(message({ sources }), graphJob), /reporting mismatch/);
  assert.throws(() => validate(message({ sources: sources.slice(0, 1) }), captured), /reporting mismatch/);
  assert.throws(
    () => validate(message({ sources: [...sources, { file: "unrelated.js", sourceSha256: hash("extra") }] }), captured),
    /reporting mismatch/,
  );
  assert.throws(
    () => validate(message({ sources: sources.map((row) => ({ ...row, sourceSha256: hash("wrong") })) }), captured),
    /reporting mismatch/,
  );
  assert.throws(
    () => validate(message(), { ...job, entryFile: "test.js", fixtureFiles: { "test.js": "collision" } }),
    /source text\/identity mismatch/,
  );
});

test("rejects accessor/inherited DATA without invoking getters", () => {
  let reads = 0;
  const packet = message();
  Object.defineProperty(packet.preparedFrontendReport, "phase", {
    get() {
      reads++;
      return "syntax";
    },
  });
  assert.throws(() => validate(packet), /must be DATA/);
  const inherited = message();
  inherited.preparedFrontendReport = Object.create(inherited.preparedFrontendReport);
  assert.throws(() => validate(inherited), /plain DATA record/);
  const expectation = { ...job };
  Object.defineProperty(expectation, "expectedErrorType", {
    get() {
      reads++;
      return "SyntaxError";
    },
  });
  assert.throws(() => validate(message(), expectation), /must be DATA/);
  const nested = message();
  Object.defineProperty(nested.preparedFrontendReport.diagnostics[0], "message", {
    get() {
      reads++;
      return "error";
    },
  });
  assert.throws(() => validate(nested), /must be DATA/);
  assert.equal(reads, 0);
});

test("does not accept mixed emission/execution packets or generic compiler failures", () => {
  for (const extra of [
    { preparedExecutionReport: {} },
    { preparedReport: {} },
    { runtimeNegativePass: true },
    { binary: new Uint8Array([0]) },
    { status: "compile_error" },
    { status: "fail" },
  ])
    assert.throws(() => validate({ ...message(), ...extra }), /cannot claim emission or execution/);
  assert.throws(() => validate({ id: jobId, status: "pass" }), /frontend report/);
  assert.throws(() => validate(message({ diagnostics: [] })), /diagnostics missing/);
  assert.throws(
    () => validate(message({ diagnostics: [{ message: "internal failure" }] })),
    /located frontend diagnostic/,
  );
  assert.throws(() => validate(message({ emittedUnits: 1 })), /unknown frontend reporting fields/);
  const failed = { success: false, errors: [{ message: "unsupported body", line: 1, column: 1 }] };
  assert.throws(
    () => observePreparedFrontendJobResult({}, failed, request, source, jobId, workerPid, job),
    /frontend reporter unavailable/,
  );
  assert.throws(
    () =>
      observePreparedFrontendJobResult(
        { requiredPreparedFrontendFailure: () => undefined },
        failed,
        request,
        source,
        jobId,
        workerPid,
        job,
      ),
    /actual frontend rejection is unavailable/,
  );
});
