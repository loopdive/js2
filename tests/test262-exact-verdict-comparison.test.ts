// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const pass = { file: "test/a.js", status: "pass" };
const fail = { file: "test/b.js", status: "fail", error: "original\0error\ud800" };
function compare(before: unknown[], after: unknown[], count: number | null = 2) {
  const root = mkdtempSync(join(tmpdir(), "js2-exact-verdicts-"));
  const baseline = join(root, "baseline.jsonl");
  const candidate = join(root, "candidate.jsonl");
  writeFileSync(baseline, before.map((row) => JSON.stringify(row)).join("\n"));
  writeFileSync(candidate, after.map((row) => JSON.stringify(row)).join("\n"));
  return spawnSync(
    process.execPath,
    [
      resolve("scripts/compare-test262-artifact.mjs"),
      "--type",
      "verdicts",
      "--baseline",
      baseline,
      "--candidate",
      candidate,
      ...(count === null ? [] : ["--expected-count", String(count)]),
    ],
    { encoding: "utf8" },
  );
}

it("accepts exact verdicts in different order without comparing timing metadata", () => {
  const result = compare(
    [pass, fail],
    [
      { ...fail, exec_ms: 100 },
      { ...pass, timestamp: "later" },
    ],
  );
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toEqual({
    expectedCount: 2,
    baselineRows: 2,
    candidateRows: 2,
    differences: 0,
  });
});

it("rejects offsetting improvement/regression despite equal net pass counts", () => {
  expect(
    compare(
      [pass, fail],
      [
        { ...pass, status: "fail", error: "new" },
        { file: fail.file, status: "pass" },
      ],
    ).status,
  ).toBe(1);
});

it("preserves exact error text including NUL and unpaired surrogate escapes", () => {
  const result = compare([pass, fail], [pass, { ...fail, error: "original^@error\ud800" }]);
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout.split("\n")[0]).baseline.error).toBe(fail.error);
});

it("distinguishes absent error from an empty error string", () => {
  expect(compare([pass, fail], [{ ...pass, error: "" }, fail]).status).toBe(1);
});

it("rejects equally sized but different fixture sets", () => {
  expect(compare([pass, fail], [{ ...pass, file: "test/c.js" }, fail]).status).toBe(1);
});

for (const rows of [
  [],
  [pass],
  [pass, pass],
  [pass, { ...fail, status: "compiled" }],
  [pass, { ...fail, error: null }],
  [pass, { status: "pass" }],
]) {
  it(`refuses invalid or incomplete rows: ${JSON.stringify(rows)}`, () => {
    expect(compare(rows, rows).status).toBe(2);
  });
}

it("requires a positive expected population", () => {
  expect(compare([], [], 0).status).toBe(2);
});

it("refuses an omitted expected population", () => {
  expect(compare([pass, fail], [pass, fail], null).status).toBe(2);
});
