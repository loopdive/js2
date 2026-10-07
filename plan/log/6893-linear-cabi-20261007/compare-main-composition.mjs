import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { isDeepStrictEqual } from "node:util";

const read = (path) => {
  const bytes = readFileSync(path);
  return (path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8");
};
const [baselinePath, candidatePath] = process.argv.slice(2);
assert.ok(baselinePath && candidatePath, "two raw logs required");
const logs = [read(baselinePath), read(candidatePath)];
const arms = logs.map((log) =>
  log
    .split("\n")
    .filter((line) => line.startsWith('{"issue":6893,'))
    .map(JSON.parse),
);
const counts = {
  provenance: 1,
  "public-namesake-compile": 1,
  "public-namesake-imports": 1,
  "public-namesake-invocation": 1,
  "public-namesake-array": 1,
  "public-compile": 8,
  "public-array": 5,
  "public-scalar": 2,
  "public-string": 1,
  "import-only-missing-resolver": 1,
  "runtime-growth": 3,
  "wrapper-contract": 3,
  "runtime-no-growth": 2,
  "missing-resolver": 1,
  "no-resolver-string": 1,
  "no-resolver-scalar": 1,
};
const allowed = {
  provenance: ["revision", "sourceSha256"],
  "public-array": ["pair", "elements"],
  "runtime-growth": ["actual"],
  "wrapper-contract": ["targets", "body"],
  "missing-resolver": ["failure"],
  "import-only-missing-resolver": ["failure"],
};
for (const rows of arms) {
  assert.equal(rows.length, 33);
  const actualCounts = {};
  for (const row of rows) actualCounts[row.kind] = (actualCounts[row.kind] ?? 0) + 1;
  assert.deepEqual(actualCounts, counts);
  assert.equal(rows[0].testSha256, "7612ec537bd3876f3a872e029629601442b7593b1150c30cd25d49db7351be62");
  const scalar = rows.find((row) => row.kind === "public-scalar" && row.caseId === "aliasScalar31-out-of-scope-A");
  assert.ok(scalar, "original scalar witness missing");
  assert.equal(scalar.actual, 3.75);
  for (const row of rows.filter((entry) => entry.kind === "runtime-growth")) {
    assert.deepEqual(row.before, row.afterOldest);
    assert.deepEqual(row.before, row.afterCurrent);
    assert.equal(row.usedBefore, row.usedAfterOldest);
    assert.equal(row.usedBefore, row.usedAfterCurrent);
    assert.deepEqual(row.hostCalls, []);
    assert.deepEqual(row.alreadyCurrent.elements, row.expected);
    assert.equal(row.expected.length, 96);
  }
}
assert.match(logs[0], /Tests\s+9 failed \| 89 passed \(98\)/);
assert.match(logs[1], /Tests\s+98 passed \(98\)/);
const differences = [];
for (let index = 0; index < 33; index++) {
  const [before, after] = arms.map((rows) => rows[index]);
  assert.deepEqual(Object.keys(before), Object.keys(after));
  assert.equal(before.kind, after.kind);
  const changed = Object.keys(before).filter((key) => !isDeepStrictEqual(before[key], after[key]));
  for (const key of changed) assert.ok(allowed[before.kind]?.includes(key), `unexpected ${index}:${key}`);
  if (changed.length) differences.push({ index, kind: before.kind, changed });
  if (after.kind === "runtime-growth") {
    assert.deepEqual(after.actual, after.alreadyCurrent);
    assert.notDeepEqual(before.actual, after.actual);
  }
  if (after.kind === "wrapper-contract") {
    assert.equal(after.targets.filter((target) => target.name === "__arr_resolve").length, 1);
  }
  if (["missing-resolver", "import-only-missing-resolver"].includes(after.kind)) {
    assert.equal(after.failure.name, "Error");
    assert.equal(
      after.failure.message,
      "C-ABI array return for export 'wrapped' is missing required __arr_resolve; register the array runtime before emitting C-ABI wrappers.",
    );
  }
}
assert.equal(differences.length, 13, "all intended deltas must be observed");
console.log(
  JSON.stringify(
    {
      baseline: arms[0][0],
      candidate: arms[1][0],
      recordsEach: 33,
      counts,
      differences,
      growthCustodyEqual: true,
      candidateTestsPassed: 98,
    },
    null,
    2,
  ),
);
