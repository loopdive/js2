import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
const read = (name) => gunzipSync(readFileSync(new URL(name, import.meta.url))).toString("utf8");
const records = read("6899-unicode-slice-probe-v2.log.gz")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const provenance = records.filter((row) => row.kind === "provenance");
const rows = records.filter((row) => row.kind === "row");
const terminal = records.filter((row) => row.kind === "terminal");
assert.equal(provenance.length, 1);
assert.equal(provenance[0].head, "3fee634ae67f23f57085ce6b792e584cd78e85ac");
assert.equal(provenance[0].sourceTree, "953f74f80cf2f8085b8e1c93489fcdd357929b37");
assert.equal(
  createHash("sha256").update(read("6899-unicode-slice-probe.mts.gz")).digest("hex"),
  provenance[0].probeHash,
);
assert.equal(rows.length, 4);
assert.equal(new Set(rows.map((row) => `${row.mode}:${row.text}`)).size, 4);
assert.equal(records.filter((row) => row.kind === "row-error").length, 0);
assert.equal(terminal.length, 1);
assert.equal(terminal[0].sourceCustodyUnchanged, true);
assert.equal(terminal[0].expectedRows, 4);
for (const row of rows) {
  assert.equal(row.success, true);
  assert.equal(row.valid, true);
  assert.deepEqual(row.errors, []);
  assert.deepEqual(row.args, [1, 2]);
  assert.equal(row.native, 1);
  assert.equal(row.actual, row.text === "ax" ? 1 : 0);
  assert.equal(createHash("sha256").update(row.source).digest("hex"), row.sourceSha256);
}
const ascii = rows.find((row) => row.mode === "overlay" && row.text === "ax");
const unicode = rows.find((row) => row.mode === "overlay" && row.text === "éx");
assert.deepEqual(ascii.compiled, ["run"]);
assert.deepEqual(ascii.rejected, []);
assert.deepEqual(unicode.compiled, []);
assert.equal(unicode.rejected.length, 1);
assert.equal(unicode.rejected[0].outcome.code, "string-evidence-unsupported");
console.log(
  JSON.stringify({
    observations: 4,
    asciiControlsMatchingNative: 2,
    legacyUnicodeMismatches: 2,
    acceptedUnicodeIrFunctions: 0,
    sourceCustodyUnchanged: true,
  }),
);
