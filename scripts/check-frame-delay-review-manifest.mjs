// Read-only preflight: never launches comparison arms or grants execution approval.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReviewAdmission, sha } from "./lib/frame-delay-three-arm-contract.mjs";

assert.equal(process.argv.length, 4, "usage: check-frame-delay-review-manifest.mjs MANIFEST SHA256");
const bytes = readFileSync(resolve(process.argv[2]));
assert.match(process.argv[3], /^[a-f0-9]{64}$/);
assert.equal(sha(bytes), process.argv[3], "review manifest digest");
const manifest = JSON.parse(bytes);
assertReviewAdmission(manifest, resolve(dirname(fileURLToPath(import.meta.url)), ".."));
console.log(
  JSON.stringify({
    status: "REVIEW_PREFLIGHT_PASS_NOT_EXECUTION_APPROVAL",
    manifestSha256: sha(bytes),
    comparisonRuns: 0,
    compilerInvocations: 0,
  }),
);
