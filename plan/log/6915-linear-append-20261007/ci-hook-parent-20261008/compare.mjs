import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
const read = (name) => gunzipSync(readFileSync(new URL(name, import.meta.url))).toString();
const previous = read("../repaired-v3.log.gz")
  .split("\n")
  .filter((line) => line.startsWith('{"schema":'))
  .map((line) => JSON.parse(line));
const current = read("graphs.ndjson.gz")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.equal(previous.length, 38);
assert.equal(current.length, 38);
assert.equal(current[0].kind, "provenance");
assert.equal(current[37].kind, "completion");
assert.ok(current.every((row) => row.schema === "6915-evidence-graph-v1"));
assert.equal(new Set(current.slice(1, 37).map((row) => row.id)).size, 36);
assert.deepEqual(current.slice(1), previous.slice(1));
const reporter = JSON.parse(read("reporter.json.gz"));
for (const [key, expected] of Object.entries({
  numTotalTests: 36,
  numPassedTests: 36,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
}))
  assert.equal(reporter[key], expected);
assert.equal(reporter.success, true);
const receipt = JSON.parse(read("receipt.json.gz"));
assert.equal(receipt.code, 0);
assert.equal(receipt.signal, null);
assert.equal(receipt.killed, false);
assert.equal(receipt.spawnError, null);
assert.deepEqual(receipt.failures, []);
const before = JSON.parse(read("before.json.gz"));
assert.deepEqual(JSON.parse(read("after.json.gz")), before);
assert.equal(before.head, "0d210cfa5f9a214309681ef1b8ecf2a6c260c6d7");
assert.equal(before.sourceTree, "953f74f80cf2f8085b8e1c93489fcdd357929b37");
console.log(
  JSON.stringify(
    {
      executionHead: before.head,
      sourceTree: before.sourceTree,
      invocation: "pnpm run test:changed-root with independently approved parent manifest",
      passed: 36,
      failed: 0,
      skipped: 0,
      todo: 0,
      graphEnvelopes: 38,
      exactObservationGraphs: 36,
      exactCompletionGraph: true,
      filteredGraphFields: [],
      beforeAfterCustodyEqual: true,
      elapsedMs: receipt.elapsedMs,
      stdoutBytes: receipt.bytes,
      limitation:
        "Existing public Linear overlay only; provenance epoch separately retained and validated. No native completion, performance acceptance, main delivery or hold release.",
    },
    null,
    2,
  ),
);
