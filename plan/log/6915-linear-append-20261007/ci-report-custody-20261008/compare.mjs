import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
const bytes = (name) => gunzipSync(readFileSync(new URL(name, import.meta.url)));
const json = (name) => JSON.parse(bytes(name).toString());
const previous = bytes("../repaired-v3.log.gz")
  .toString()
  .split("\n")
  .filter((line) => line.startsWith('{"schema":'))
  .map((line) => JSON.parse(line));
const current = bytes("graphs.ndjson.gz")
  .toString()
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.equal(previous.length, 38);
assert.equal(current.length, 38);
assert.ok(current.every((row) => row.schema === "6915-evidence-graph-v1"));
assert.equal(current[0].kind, "provenance");
assert.equal(current[37].kind, "completion");
assert.equal(new Set(current.slice(1, 37).map((row) => row.id)).size, 36);
assert.deepEqual(current.slice(1), previous.slice(1));
const reporter = json("reporter.json.gz");
for (const [key, expected] of Object.entries({
  numTotalTests: 36,
  numPassedTests: 36,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
}))
  assert.equal(reporter[key], expected);
assert.equal(reporter.success, true);
const receipt = json("receipt.json.gz");
assert.equal(receipt.code, 0);
assert.equal(receipt.signal, null);
assert.equal(receipt.killed, false);
assert.equal(receipt.spawnError, null);
assert.deepEqual(receipt.failures, []);
const before = json("before.json.gz");
assert.deepEqual(json("after.json.gz"), before);
assert.equal(before.head, "7be295c0d8611882ec09492af8d29c229bb4bfba");
assert.equal(before.sourceTree, "953f74f80cf2f8085b8e1c93489fcdd357929b37");
const reportBefore = bytes("boundary-report-before.raw.gz");
assert.deepEqual(bytes("boundary-report-after.raw.gz"), reportBefore);
assert.deepEqual(before.generatedBoundaryReport, {
  path: "compiler-boundaries-report.json",
  present: true,
  byteLength: 10924371,
  sha256: "334f7ab83404b62659eaab5e0e06d6ec655f2e66c214742c4ed27dfab52d2cb3",
});
assert.equal(createHash("sha256").update(reportBefore).digest("hex"), before.generatedBoundaryReport.sha256);
assert.equal(reportBefore.length, before.generatedBoundaryReport.byteLength);
assert.equal(Object.hasOwn(before.files, "compiler-boundaries-report.json"), false);
console.log(
  JSON.stringify(
    {
      executionHead: before.head,
      sourceTree: before.sourceTree,
      passed: 36,
      failed: 0,
      skipped: 0,
      todo: 0,
      graphEnvelopes: 38,
      exactObservationGraphs: 36,
      exactCompletionGraph: true,
      filteredGraphFields: [],
      beforeAfterCustodyEqual: true,
      generatedReport: before.generatedBoundaryReport,
      elapsedMs: receipt.elapsedMs,
      limitation:
        "Local CI-faithful reproduction; actual repaired CI still required. Different execution provenance retained separately. No native completion, performance acceptance, main delivery or hold release.",
    },
    null,
    2,
  ),
);
