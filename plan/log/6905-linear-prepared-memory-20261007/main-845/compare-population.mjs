import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";

const read = (name) => gunzipSync(readFileSync(new URL(name, import.meta.url))).toString("utf8");
const ids = [
  "native",
  "shared-scalar",
  "direct-allocation",
  "shared-allocation",
  "overlay-allocation",
  "unit-abi",
  "unit-freshness",
  "unit-runtime",
];
const arms = ["baseline", "candidate"].map((arm) => {
  const report = JSON.parse(read(`${arm}25.json.gz`));
  assert.equal(report.numTotalTests, 25);
  assert.equal(report.numPassedTests, 24);
  assert.equal(report.numFailedTests, 1);
  assert.equal(report.numPendingTests, 0);
  const receipt = JSON.parse(read(`${arm}-receipt.json.gz`));
  assert.equal(receipt.status, 1);
  assert.equal(receipt.signal, null);
  assert.deepEqual(receipt.before, receipt.after);
  const log = read(`${arm}25.log.gz`);
  const records = log
    .split("\n")
    .filter((line) => line.startsWith('{"issue":6905'))
    .map((line) => JSON.parse(line));
  const provenance = records.filter((row) => row.kind === "provenance");
  const population = records.filter((row) => row.kind === "population");
  const rows = records.filter((row) => row.kind === "row");
  assert.equal(provenance.length, 1);
  assert.equal(provenance[0].head, receipt.before.head);
  assert.equal(
    provenance[0].testSha256,
    receipt.before.hashes["tests/issue-6905-linear-prepared-memory-materialization.test.ts"],
  );
  assert.equal(provenance[0].runtimeSha256, receipt.before.hashes["src/codegen-linear/runtime.ts"]);
  assert.equal(
    provenance[0].helperSha256,
    receipt.before.hashes["src/codegen-linear/runtime/vector-initialization.ts"],
  );
  assert.equal(rows.length, 8);
  assert.deepEqual(
    rows.map((row) => row.id),
    ids,
  );
  assert.equal(population.length, 1);
  assert.equal(population[0].count, 8);
  assert.deepEqual(population[0].ids, ids);
  assert.equal(rows.filter((row) => row.status === "passed").length, 7);
  assert.equal(rows.filter((row) => row.status === "failed").length, 1);
  assert.equal(rows.find((row) => row.status === "failed").id, "shared-allocation");
  const start = log.indexOf(" FAIL "),
    end = log.lastIndexOf(" Test Files ");
  assert.ok(start >= 0 && end > start);
  const failures = log.slice(start, end);
  assert.equal((failures.match(/ FAIL /g) ?? []).length, 1);
  const statuses = report.testResults.flatMap((file) =>
    file.assertionResults.map((test) => ({ name: test.fullName, status: test.status })),
  );
  return { rows, provenance: provenance[0], receipt, statuses, failures };
});
assert.deepEqual(arms[0].rows, arms[1].rows);
assert.deepEqual(arms[0].statuses, arms[1].statuses);
assert.equal(arms[0].failures, arms[1].failures);
for (const key of [
  "testSha256",
  "source",
  "sourceSha256",
  "scalarSource",
  "scalarSourceSha256",
  "logicalFile",
  "node",
  "v8",
  "execArgv",
  "nodeOptions",
  "options",
  "expectedRows",
  "sourceRows",
  "initializerUnitRows",
])
  assert.deepEqual(arms[0].provenance[key], arms[1].provenance[key]);
let binaryWitnesses = 0;
const visit = (value) => {
  if (!value || typeof value !== "object") return;
  if (typeof value.binaryBase64 === "string") {
    const bytes = Buffer.from(value.binaryBase64, "base64");
    assert.ok(bytes.length > 0);
    assert.equal(WebAssembly.validate(bytes), true);
    assert.equal(bytes.length, value.byteLength);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), value.sha256);
    binaryWitnesses++;
  }
  for (const child of Object.values(value)) visit(child);
};
visit(arms[0].rows);
assert.equal(binaryWitnesses, 5);
console.log(
  JSON.stringify(
    {
      testsPerArm: 25,
      passedPerArm: 24,
      failedPerArm: 1,
      pendingPerArm: 0,
      fullObservationRowsEqual: 8,
      completeRawFailureTextEqual: true,
      failureTextCharacters: arms[0].failures.length,
      binaryWitnessesPerArm: binaryWitnesses,
      baselineHead: arms[0].receipt.before.head,
      candidateHead: arms[1].receipt.before.head,
    },
    null,
    2,
  ),
);
