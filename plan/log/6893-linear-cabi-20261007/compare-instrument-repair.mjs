import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const paths = process.argv.slice(2);
assert.equal(paths.length, 4, "old/new baseline and old/new candidate logs required");
const read = (path) => {
  const bytes = readFileSync(path);
  const log = (path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8");
  const rows = log
    .split("\n")
    .filter((line) => line.startsWith('{"issue":6893,'))
    .map(JSON.parse);
  assert.equal(rows.length, 33, `missing records: ${path}`);
  assert.equal(rows.filter((row) => row.kind === "provenance").length, 1);
  assert.equal(rows[0].kind, "provenance");
  return rows;
};
const rows = paths.map(read);
const evidence = [];
for (const [arm, oldIndex, newIndex] of [
  ["baseline", 0, 1],
  ["candidate", 2, 3],
]) {
  const oldRows = rows[oldIndex];
  const newRows = rows[newIndex];
  assert.deepEqual(Object.keys(oldRows[0]), Object.keys(newRows[0]));
  for (const key of Object.keys(oldRows[0])) {
    if (["revision", "testSha256"].includes(key)) continue;
    assert.deepEqual(oldRows[0][key], newRows[0][key], `${arm} provenance ${key}`);
  }
  assert.notEqual(oldRows[0].testSha256, newRows[0].testSha256);
  assert.deepEqual(oldRows.slice(1), newRows.slice(1), `${arm}: all32 semantic records must remain exactly equal`);
  evidence.push({ arm, old: oldRows[0], repaired: newRows[0], semanticRecordsEqual: 32 });
}
assert.equal(rows[1][0].testSha256, rows[3][0].testSha256);
console.log(JSON.stringify({ provenanceExceptions: ["revision", "testSha256"], evidence }, null, 2));
