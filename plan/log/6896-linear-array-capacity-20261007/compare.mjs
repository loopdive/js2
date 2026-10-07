// Reviewable comparison of frozen regression logs. No compiler/test mutation.
import fs from "node:fs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const [baselinePath, candidatePath] = process.argv.slice(2);
const read = (path) => {
  const raw = fs.readFileSync(path, "utf8");
  const rows = raw
    .split("\n")
    .filter((line) => line.startsWith('{"issue":6896,'))
    .map((line) => JSON.parse(line));
  assert.equal(rows.length, 23, "Expected provenance + 20 runtime/unit rows + two source-IR rows");
  assert.equal(new Set(rows.map((row) => row.caseId)).size, 23);
  return { raw, rows, sha256: createHash("sha256").update(raw).digest("hex") };
};
const baseline = read(baselinePath);
const candidate = read(candidatePath);
const controls = baseline.rows.filter(
  (row) =>
    row.caseId.startsWith("small-") ||
    ["new-C-minus-1", "new-C", "grow-min-C", "grow-old-H", "parent-compile", "parent-run"].includes(row.caseId),
);
assert.equal(controls.length, 11);
for (const row of controls) {
  const matching = candidate.rows.find((entry) => entry.caseId === row.caseId);
  assert.ok(matching);
  // Guard insertion changes the emitted binary; every other actual field must match.
  const withoutBinaryDigest = (value) => {
    const copy = structuredClone(value);
    delete copy.binarySha256;
    delete copy.emittedSha256;
    delete copy.returnedBinarySha256;
    return copy;
  };
  assert.deepEqual(withoutBinaryDigest(matching.actual), withoutBinaryDigest(row.actual), row.caseId);
}
const provenance = (run) => run.rows.find((row) => row.lane === "provenance").actual;
assert.equal(provenance(baseline).testSha256, provenance(candidate).testSha256);
assert.match(baseline.raw, /Tests\s+11 failed \| 10 passed \(21\)/);
assert.match(candidate.raw, /Tests\s+21 passed \(21\)/);
console.log(
  JSON.stringify(
    {
      baselineSha256: baseline.sha256,
      candidateSha256: candidate.sha256,
      baselineProvenance: provenance(baseline),
      candidateProvenance: provenance(candidate),
      identicalControlRows: controls.map((row) => row.caseId),
      baseline: { passed: 10, failed: 11 },
      candidate: { passed: 21, failed: 0 },
      rowsPerRun: 23,
    },
    null,
    2,
  ),
);
