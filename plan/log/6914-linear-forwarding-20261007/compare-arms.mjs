import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const read = (path) => {
  const bytes = readFileSync(path);
  return (path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8");
};

const ids = [
  "source-alias31",
  "source-push31",
  "source-alias-push21",
  "source-import-custody",
  "resolve-zero-hop",
  "resolve-one-hop",
  "resolve-three-hop",
  "legacy-u8-forwarded",
  "registration-array-first",
  "registration-u8-first",
  "installed-exact-body-abi",
  "import-offset-artifact",
  "fresh-object-custody",
];
const hash = (value) => createHash("sha256").update(value).digest("hex");
function arm(log, report, head, runtime) {
  const rows = read(log)
    .split("\n")
    .filter((line) => line.startsWith('{"issue":6914,'))
    .map(JSON.parse);
  assert.equal(rows.length, 14);
  const provenance = rows.filter((row) => row.kind === "provenance");
  assert.equal(provenance.length, 1);
  assert.equal(provenance[0].head, head);
  assert.equal(provenance[0].runtimeSha256, runtime);
  assert.equal(provenance[0].dirty, "");
  assert.equal(provenance[0].testSha256, "1e5114449c2a05d73b5a0c20a746cf1a12d179bbef083254dd4a2ca286c7a1f1");
  assert.equal(provenance[0].baseline, "3146af9a349bb20a5a398fba37e8b69b16fb4ab9");
  const observations = rows.filter((row) => row.kind === "observation");
  assert.deepEqual(observations.map((row) => row.id).sort(), [...ids].sort());
  let binaries = 0;
  let memories = 0;
  function inspect(value) {
    if (!value || typeof value !== "object") return;
    if (Object.hasOwn(value, "binaryBase64")) {
      const bytes = Buffer.from(value.binaryBase64, "base64");
      assert.ok(bytes.length > 8);
      assert.equal(bytes.length, value.byteLength);
      assert.equal(hash(bytes), value.sha256);
      assert.equal(value.valid, true);
      assert.equal(WebAssembly.validate(new Uint8Array(bytes)), true);
      binaries++;
    }
    if (Object.hasOwn(value, "memoryBase64")) {
      const bytes = Buffer.from(value.memoryBase64, "base64");
      assert.ok(bytes.length >= 65536);
      assert.equal(bytes.length, value.memoryBytes);
      assert.equal(hash(bytes), value.memorySha256);
      memories++;
    }
    for (const child of Object.values(value)) inspect(child);
  }
  for (const row of observations) {
    assert.equal(row.status, "passed");
    assert.equal(row.failure, null);
    inspect(row.evidence);
  }
  assert.ok(binaries >= 13);
  assert.ok(memories >= 10);
  const result = JSON.parse(read(report));
  assert.equal(result.numTotalTests, 51);
  assert.equal(result.numPassedTests, 51);
  assert.equal(result.numFailedTests, 0);
  assert.equal(result.numPendingTests, 0);
  assert.equal(result.numTodoTests, 0);
  assert.equal(result.testResults.length, 3);
  const cases = result.testResults.flatMap((file) =>
    file.assertionResults.map((test) => ({ name: test.fullName, status: test.status, failures: test.failureMessages })),
  );
  assert.equal(cases.length, 51);
  assert.equal(new Set(cases.map((test) => test.name)).size, 51);
  for (const test of cases) {
    assert.equal(test.status, "passed");
    assert.deepEqual(test.failures, []);
  }
  const { head: ignoredHead, runtimeSha256: ignoredRuntime, ...commonProvenance } = provenance[0];
  return {
    observations,
    cases: cases.sort((a, b) => a.name.localeCompare(b.name)),
    commonProvenance,
    binaries,
    memories,
  };
}
assert.equal(process.argv.length, 6, "baseline log/report, candidate log/report required");
const baseline = arm(
  process.argv[2],
  process.argv[3],
  "da6d5ceed9bceb02c648a09801f5d186421db228",
  "2a562751f9e2c6291944836681b3bc99b402c2d154a88c429ee16013eaf09e0f",
);
const candidate = arm(
  process.argv[4],
  process.argv[5],
  "06533320a4a1a47414d953a6f1656eabb05d6ad6",
  "2335826df9ce1609a10e62ad065870d354b429a5e110995d0f80d8fc2a61e039",
);
assert.deepEqual(candidate, baseline);
console.log(
  JSON.stringify({
    status: "exact-equality",
    cases: 51,
    observations: 13,
    binariesPerArm: baseline.binaries,
    memoriesPerArm: baseline.memories,
    provenanceExceptions: ["head", "runtimeSha256"],
  }),
);
