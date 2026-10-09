import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";

const ids = [
  "native",
  "source-ascii",
  "runtime-ascii",
  "runtime-bmp",
  "runtime-astral",
  "runtime-extremes",
  "registration",
  "deep-custody",
  "import-binding",
  "cache-effects",
];
function arm(path) {
  const bytes = readFileSync(path);
  const records = (path.endsWith(".gz") ? gunzipSync(bytes) : bytes)
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(records.length >= 12, "missing provenance/population or observations");
  const provenance = records.filter((row) => row.kind === "provenance");
  assert.equal(provenance.length, 1);
  assert.equal(provenance[0].expectedRows, 10);
  assert.equal(provenance[0].nativeCases, 41);
  const population = records.filter((row) => row.kind === "population");
  assert.equal(population.length, 1);
  assert.equal(population[0].count, 10);
  assert.deepEqual(population[0].ids, ids);
  const rows = records.filter((row) => row.kind === "observation");
  assert.equal(rows.length, 10);
  assert.deepEqual(
    rows.map((row) => row.id),
    ids,
  );
  assert.ok(rows.every((row) => row.issue === 6911 && row.schemaVersion === 1 && !row.duplicate));
  const expectedCases = {
    native: 41,
    "source-ascii": 5,
    "runtime-ascii": 24,
    "runtime-bmp": 19,
    "runtime-astral": 9,
    "runtime-extremes": 5,
    "import-binding": 2,
    "cache-effects": 8,
  };
  for (const [id, count] of Object.entries(expectedCases)) {
    const row = rows.find((entry) => entry.id === id);
    assert.equal(row.evidence.caseCount, count);
    assert.equal(row.evidence.cases.length, count);
  }
  let artifactCount = 0;
  function artifacts(value) {
    if (!value || typeof value !== "object") return;
    if (typeof value.binaryBase64 === "string") {
      const binary = Buffer.from(value.binaryBase64, "base64");
      assert.ok(binary.length > 0);
      assert.equal(value.byteLength, binary.length);
      assert.equal(value.valid, true);
      assert.equal(value.sha256, createHash("sha256").update(binary).digest("hex"));
      assert.equal(WebAssembly.validate(new Uint8Array(binary)), true);
      artifactCount++;
    }
    for (const child of Object.values(value)) artifacts(child);
  }
  rows.forEach(artifacts);
  assert.equal(artifactCount, 14, "missing recorded binary witnesses");
  return { provenance: provenance[0], rows, artifactCount };
}
assert.equal(process.argv.length, 4, "provide baseline and candidate observation paths");
const baseline = arm(process.argv[2]);
const candidate = arm(process.argv[3]);
assert.equal(candidate.provenance.testSha256, baseline.provenance.testSha256);
assert.equal(candidate.provenance.sourceSha256, baseline.provenance.sourceSha256);
assert.deepEqual(candidate.provenance.options, baseline.provenance.options);
assert.deepEqual(candidate.rows, baseline.rows, "full provider rows/artifacts changed");
console.log(
  JSON.stringify({
    rows: 10,
    nativeCases: 41,
    binaryWitnessesPerArm: baseline.artifactCount,
    fullRowsEqual: true,
    baselineHead: baseline.provenance.head,
    candidateHead: candidate.provenance.head,
    passedPerArm: baseline.rows.filter((row) => row.status === "passed").length,
    failedPerArm: baseline.rows.filter((row) => row.status === "failed").length,
  }),
);
