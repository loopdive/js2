// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5368 — compile a LIST of one package's modules in a single child process
// and emit one JSON verdict line per module.
//
// The list lives in one process on purpose: `src/index.js` plus the TypeScript
// program setup is ~1.5 s of fixed cost, and the widened surface has ~20x more
// modules than the old one-entry-per-process shape. Paying that once per chunk
// rather than once per module is what keeps the gate inside its budget.
//
// Isolation is still real — the parent spawns these and kills a chunk that
// blows its deadline — but a compile that hard-crashes the process takes its
// chunk-mates' verdicts with it. The parent treats a chunk that stops early as
// an infrastructure failure rather than silently scoring the missing modules.
//
// USAGE (not a user-facing tool; the gate spawns it)
//   node --import tsx dogfood-surface-probe.mjs --package <name> --modules a.js,b.js

import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { compileProject, validateEmittedBinary } from "../../src/index.js";
import { dogfoodSurfaceModules } from "./dogfood-surface-modules.mjs";

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
}

const name = optionValue("--package");
const modulesArgument = optionValue("--modules");
if (!name || !modulesArgument) {
  process.stdout.write(`${JSON.stringify({ fatal: "usage: --package <name> --modules <a.js,b.js>" })}\n`);
  process.exit(2);
}

// Only the resolved package root is needed here — the parent already decided
// WHICH modules this chunk compiles.
const surface = dogfoodSurfaceModules(name);
const compileOptions = {
  allowJs: true,
  skipSemanticDiagnostics: true,
  target: "gc",
  platform: "node",
};

for (const modulePath of modulesArgument.split(",").filter(Boolean)) {
  const started = performance.now();
  let verdict = "invalid";
  let detail = null;
  let binaryBytes = 0;
  try {
    const result = await compileProject(join(surface.packageRoot, modulePath), compileOptions);
    if (!result.success) {
      // A module that does not codegen at all makes the implication vacuous.
      // That is a different gate's business (#5332); count it, never fail on it.
      verdict = "compile-failed";
      detail = result.errors[0]?.message ?? "compile did not emit a binary";
    } else {
      binaryBytes = result.binary.byteLength;
      const validation = validateEmittedBinary(result.binary);
      verdict = validation.valid ? "valid" : "invalid";
      detail = validation.valid ? null : (validation.detail ?? "emitted binary failed WebAssembly validation");
    }
  } catch (error) {
    // A throw out of compileProject is a compiler crash, not an invalid
    // binary; it says nothing about the implication under test.
    verdict = "compile-failed";
    detail = `compileProject threw: ${error instanceof Error ? error.message : String(error)}`;
  }
  process.stdout.write(
    `${JSON.stringify({
      package: name,
      module: modulePath,
      verdict,
      detail,
      binaryBytes,
      compileMs: Math.round(performance.now() - started),
    })}\n`,
  );
}
