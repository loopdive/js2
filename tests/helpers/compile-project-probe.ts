// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Run a long compileProject probe outside Vitest's worker process. Large npm
// graphs can synchronously occupy the compiler for longer than Vitest's worker
// heartbeat, producing a false infrastructure failure after valid assertions.

import { compileProject, type CompileOptions } from "../../src/index.js";

export const COMPILE_PROJECT_PROBE_MARKER = "__JS2_COMPILE_PROJECT_PROBE__";

const [entry, rawOptions] = process.argv.slice(2);
if (!entry || !rawOptions) {
  throw new Error("usage: compile-project-probe.ts <entry> <compile-options-json>");
}

const options = JSON.parse(rawOptions) as CompileOptions;
const result = await compileProject(entry, options);
let valid = false;
let validationError: string | null = null;
if (result.success) {
  try {
    new WebAssembly.Module(result.binary);
    valid = true;
  } catch (error) {
    validationError = error instanceof Error ? error.message : String(error);
  }
}
const report = {
  success: result.success,
  binaryByteLength: result.success ? result.binary.byteLength : 0,
  valid,
  validationError,
  errors: result.errors.map((error) => ({ message: error.message })),
};

process.stdout.write(`${COMPILE_PROJECT_PROBE_MARKER}${JSON.stringify(report)}\n`);
