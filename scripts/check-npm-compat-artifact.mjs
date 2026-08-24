#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Sanity-check the assembled npm-compat artifact before promotion.
//
// This logic used to live INLINE in npm-compat-refresh.yml as a single-quoted
// `node -e '…'` block. A JS comment containing an apostrophe ("this run's
// data", added 2026-08-23 in dae19f63) terminated the bash string, so node
// received a truncated program and every coordinator run from 04:53Z to the
// 10:17Z reword failed at this step with `SyntaxError: Unexpected end of
// input` — promotion skipped every time and the npm-compat page served a
// three-day-old artifact. No gate saw it: the workflow is not a required
// check, and an inline script is invisible to biome/prettier/node --check.
// Living here, the script is covered by the repo's normal lint surface and
// the quoting class is structurally gone. (#4604 S8 follow-up)
//
// Exit 0 = safe to publish. Exit 1 = refuse (the reason is the thrown error).

import { readFileSync } from "node:fs";

const path = process.argv[2] ?? "benchmarks/results/npm-compat.json";
const pinsPath = process.argv[3] ?? "tests/dogfood/npm-compat-upstream-sources.json";

const report = JSON.parse(readFileSync(path, "utf8"));
const packages = report.packages ?? report;
if (!Array.isArray(packages) || packages.length < 20) {
  throw new Error(`${path} has ${packages?.length ?? "no"} packages; refusing to publish`);
}
if (!packages.every((entry) => entry.name && entry.compile)) {
  throw new Error(`${path} has entries missing name/compile; refusing to publish`);
}

const byName = new Map(packages.map((entry) => [entry.name, entry]));
const suitePins = JSON.parse(readFileSync(pinsPath, "utf8"));
for (const pin of suitePins.filter((entry) => entry.suiteScript)) {
  const entry = byName.get(pin.name);
  // A failed worker is carried forward from the last committed snapshot. Its
  // old test numbers are useful context, but they must not block publication
  // or masquerade as data from this run.
  if (entry?.refresh?.status === "stale") continue;
  const tests = entry?.tests;
  if (!tests || typeof tests.passed !== "number" || typeof tests.total !== "number") {
    throw new Error(`${pin.name} has ${pin.suiteScript} but its unit-test result is absent from ${path}`);
  }
  if (tests.status === "not-integrated") {
    throw new Error(`${pin.name} still reports adapter pending despite ${pin.suiteScript}`);
  }
}

console.log(`ok: ${packages.length} packages`);
