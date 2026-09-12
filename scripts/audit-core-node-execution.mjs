#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runCoreNodeExecution } from "./lib/core-node-execution-witness.mjs";

const args = process.argv.slice(2);
let root, json;
try {
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index],
      value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${key}`);
    if (key === "--root" && root === undefined) root = resolve(value);
    else if (key === "--json" && json === undefined) json = resolve(value);
    else throw new Error(`unknown/duplicate option ${key}`);
  }
  if (!root || !json)
    throw new Error("usage: node --import tsx scripts/audit-core-node-execution.mjs --root PATH --json PATH");
  const report = await runCoreNodeExecution({ root });
  writeFileSync(json, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      schema: report.schema,
      ok: report.ok,
      programs: report.programs.length,
      fullWitnessCount: report.fullWitnessCount,
      denominator: report.denominator,
      cutStatus: report.cutStatus,
      closureCertified: false,
      retirementCertified: false,
      errors: report.errors,
      json,
    }),
  );
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
