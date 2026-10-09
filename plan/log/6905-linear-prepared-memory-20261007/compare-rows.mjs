import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import assert from "node:assert/strict";
const paths = process.argv.slice(2);
assert(paths.length === 2 || paths.length === 4);
const arms = paths.map((path) => {
  const records = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.startsWith('{"issue":6905'))
    .map((line) => JSON.parse(line));
  const rows = records.filter((row) => row.kind === "row");
  const population = records.filter((row) => row.kind === "population");
  const provenance = records.filter((row) => row.kind === "provenance");
  assert.equal(rows.length, 8);
  assert.equal(new Set(rows.map((row) => row.id)).size, 8);
  assert.equal(population.length, 1);
  assert.equal(population[0].count, 8);
  assert.equal(provenance.length, 1);
  return { path, provenance: provenance[0], rows };
});
const compare = (left, right, omitted = []) => {
  const differences = left.rows
    .filter(
      (row) =>
        !omitted.includes(row.id) &&
        !isDeepStrictEqual(
          row,
          right.rows.find((other) => other.id === row.id),
        ),
    )
    .map((row) => row.id);
  return {
    left: left.path,
    right: right.path,
    compared: 8 - omitted.length,
    equal: 8 - omitted.length - differences.length,
    differences,
  };
};
const comparisons = [
  compare(arms[0], arms[1]),
  ...(arms.length === 4
    ? [
        compare(arms[2], arms[3]),
        compare(arms[0], arms[2], ["overlay-allocation"]),
        compare(arms[1], arms[3], ["overlay-allocation"]),
      ]
    : []),
];
console.log(
  JSON.stringify(
    {
      arms: arms.map((arm) => ({
        path: arm.path,
        provenance: arm.provenance,
        rows: arm.rows.map((row) => ({ id: row.id, status: row.status, phase: row.evidence.phase })),
      })),
      comparisons,
    },
    null,
    2,
  ),
);
assert(
  comparisons.every((comparison) => comparison.differences.length === 0),
  "observation mismatch",
);
