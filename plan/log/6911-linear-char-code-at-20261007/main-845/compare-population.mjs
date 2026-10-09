import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const read = (name) => gunzipSync(readFileSync(new URL(name, import.meta.url))).toString("utf8");
const baseline = JSON.parse(read("baseline41.json.gz"));
const candidate = JSON.parse(read("candidate41.json.gz"));
for (const arm of [baseline, candidate]) {
  assert.equal(arm.numTotalTests, 41);
  assert.equal(arm.numPassedTests, 38);
  assert.equal(arm.numFailedTests, 3);
  assert.equal(arm.numPendingTests, 0);
}
const population = (arm) =>
  arm.testResults.flatMap((file) =>
    file.assertionResults.map((test) => ({
      name: test.fullName,
      status: test.status,
    })),
  );
assert.deepEqual(population(baseline), population(candidate));
const diagnostics = (name) => {
  const log = read(name);
  const start = log.indexOf(" FAIL ");
  const end = log.lastIndexOf(" Test Files ");
  assert.ok(start >= 0 && end > start);
  const text = log.slice(start, end);
  assert.equal((text.match(/ FAIL /g) ?? []).length, 3);
  return text;
};
const failureText = diagnostics("baseline41.log.gz");
assert.equal(failureText, diagnostics("candidate41.log.gz"));
console.log(
  JSON.stringify(
    {
      testsPerArm: 41,
      passedPerArm: 38,
      failedPerArm: 3,
      pendingPerArm: 0,
      orderedPopulationAndStatusesEqual: true,
      completeRawFailureTextEqual: true,
      failureTextCharacters: failureText.length,
      failures: population(baseline)
        .filter((test) => test.status === "failed")
        .map((test) => test.name),
    },
    null,
    2,
  ),
);
