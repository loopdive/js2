import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { gunzipSync } from "node:zlib";

const paths = process.argv.slice(2);
assert.equal(paths.length, 2, "baseline/candidate Vitest JSON reports required");
const arms = paths.map((path) => {
  const bytes = readFileSync(path);
  const report = JSON.parse((path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"));
  assert.equal(report.numTotalTests, 98);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.numTodoTests, 0);
  assert.equal(report.testResults.length, 6);
  const cases = report.testResults.flatMap((suite) =>
    suite.assertionResults.map((result) => ({
      file: basename(suite.name),
      name: result.fullName,
      status: result.status,
      failures: result.failureMessages,
    })),
  );
  assert.equal(cases.length, 98);
  assert.equal(new Set(cases.map((row) => `${row.file}:${row.name}`)).size, 98);
  assert.ok(cases.every((row) => ["passed", "failed"].includes(row.status)));
  return cases.sort((left, right) => `${left.file}:${left.name}`.localeCompare(`${right.file}:${right.name}`));
});
assert.deepEqual(
  arms[0].map(({ file, name }) => ({ file, name })),
  arms[1].map(({ file, name }) => ({ file, name })),
);
assert.equal(arms[0].filter((row) => row.status === "passed").length, 89);
assert.equal(arms[0].filter((row) => row.status === "failed").length, 9);
assert.equal(arms[1].filter((row) => row.status === "passed").length, 98);
for (const row of arms[0].filter((entry) => entry.status === "failed")) {
  assert.equal(row.file, "issue-6893-linear-cabi-array-forwarding.test.ts");
  assert.ok(row.failures.length > 0, "full baseline failure evidence required");
}
console.log(
  JSON.stringify({ exactCaseIdentities: 98, baselinePassed: 89, candidatePassed: 98, skips: 0, cases: arms }, null, 2),
);
