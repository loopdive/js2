import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
const raw = (name) => gunzipSync(readFileSync(new URL(name, import.meta.url)));
const json = (name) => JSON.parse(raw(name));
const parse = (bytes) => bytes.toString().trim().split("\n").map(JSON.parse);
const current = parse(raw("candidate-graphs.ndjson.gz"));
const previous = raw("../repaired-v3.log.gz")
  .toString()
  .split("\n")
  .filter((line) => line.startsWith('{"schema":'))
  .map(JSON.parse);
assert.equal(current.length, 38);
assert.equal(previous.length, 38);
assert.ok(current.every((row) => row.schema === "6915-evidence-graph-v1"));
assert.equal(current[0].kind, "provenance");
assert.equal(current[37].kind, "completion");
assert.equal(new Set(current.slice(1, 37).map((row) => row.id)).size, 36);
assert.deepEqual(current.slice(1), previous.slice(1));
const receipt = json("candidate-receipt.json.gz");
assert.equal(receipt.code, 0);
assert.equal(receipt.signal, null);
assert.equal(receipt.killed, false);
assert.equal(receipt.spawnError, null);
assert.deepEqual(receipt.failures, []);
const reporter = json("candidate-reporter.json.gz");
for (const [key, expected] of Object.entries({
  numTotalTests: 36,
  numPassedTests: 36,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
}))
  assert.equal(reporter[key], expected);
assert.equal(reporter.success, true);
const before = json("candidate-before.json.gz");
assert.deepEqual(json("candidate-after.json.gz"), before);
assert.equal(before.head, "1a0584f07f69914482c91e9a82e00ac54aada092");
assert.equal(before.sourceTree, "953f74f80cf2f8085b8e1c93489fcdd357929b37");
assert.equal(
  before.files["scripts/hooks/run-linear-append-provenance.mjs"],
  "3a154510e5f1280cb7dc71f2a89bae77386ba109990fecb71d586531d9c75e54",
);
assert.deepEqual(raw("candidate-boundary-report-before.raw.gz"), raw("candidate-boundary-report-after.raw.gz"));
assert.deepEqual(before.generatedBoundaryReport, {
  path: "compiler-boundaries-report.json",
  present: true,
  byteLength: 10924371,
  sha256: "334f7ab83404b62659eaab5e0e06d6ec655f2e66c214742c4ed27dfab52d2cb3",
});
const transportLines = raw("candidate-stdout.log.gz")
  .toString()
  .split("\n")
  .filter((line) => line.includes('"schema":"6915-'));
assert.equal(transportLines.length, 38);
assert.ok(transportLines.every((line) => line.startsWith("{")));
assert.deepEqual(transportLines.map(JSON.parse), current);
console.log(
  JSON.stringify(
    {
      executionHead: before.head,
      passed: 36,
      failed: 0,
      skipped: 0,
      todo: 0,
      completeEnvelopes: 38,
      plainTransport: true,
      exactObservationGraphs: 36,
      exactCompletionGraph: true,
      filteredGraphFields: [],
      inputAndReportCustodyEqual: true,
      elapsedMs: receipt.elapsedMs,
      limitation:
        "Local repaired qualification under formerly failing incoming color environment. Actual repaired CI, native completion and protected main delivery remain unproven.",
    },
    null,
    2,
  ),
);
