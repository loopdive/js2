import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";

function readArm(name) {
  const path = fileURLToPath(new URL(`${name}-existing-controls.log.gz`, import.meta.url));
  const log = gunzipSync(readFileSync(path)).toString("utf8");
  assert.match(log, /3 failed \| 28 passed \(31\)/);
  assert.match(log, /issue-2956.test.ts \(20 tests \| 3 failed\)/);
  assert.match(log, /linear-charcodeat-ascii-fast-path.test.ts \(11 tests\)/);
  const start = log.indexOf(" FAIL ");
  const end = log.lastIndexOf(" Test Files ");
  assert.ok(start >= 0 && end > start, "missing complete failure section");
  const failureText = log.slice(start, end);
  assert.equal((failureText.match(/^ FAIL /gm) ?? []).length, 3);
  return failureText;
}

const baseline = readArm("baseline");
const candidate = readArm("candidate");
assert.equal(candidate, baseline, "complete failure diagnostics changed");
console.log(
  JSON.stringify({
    controls: 31,
    passedPerArm: 28,
    failedPerArm: 3,
    completeFailureTextEqual: true,
    failureTextCharacters: baseline.length,
  }),
);
