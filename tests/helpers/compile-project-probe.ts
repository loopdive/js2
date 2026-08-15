// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Run a long compileProject probe outside Vitest's worker process. Large npm
// graphs can synchronously occupy the compiler for longer than Vitest's worker
// heartbeat, producing a false infrastructure failure after valid assertions.

import { compileProject, validateEmittedBinary, type CompileOptions } from "../../src/index.js";

export const COMPILE_PROJECT_PROBE_MARKER = "__JS2_COMPILE_PROJECT_PROBE__";

const [entry, rawOptions] = process.argv.slice(2);
if (!entry || !rawOptions) {
  throw new Error("usage: compile-project-probe.ts <entry> <compile-options-json>");
}

const options = JSON.parse(rawOptions) as CompileOptions;
const result = await compileProject(entry, options);
// (#4420) `success` means codegen finished, not that the engine accepts the
// bytes — the package-entry harness reports "compiled" off this probe, so the
// verdict has to come from the shared engine gate rather than a local copy of
// the validate-then-recover-the-detail idiom.
let valid = false;
let validationError: string | null = null;
if (result.success) {
  const validation = validateEmittedBinary(result.binary);
  valid = validation.valid;
  validationError = valid ? null : (validation.detail ?? "emitted binary failed WebAssembly validation");
}
const report = {
  success: result.success,
  binaryByteLength: result.success ? result.binary.byteLength : 0,
  valid,
  validationError,
  errors: result.errors.map((error) => ({
    message: error.message,
    line: error.line,
    column: error.column,
    severity: error.severity,
    ...(error.file ? { file: error.file } : {}),
  })),
};

process.stdout.write(`${COMPILE_PROJECT_PROBE_MARKER}${JSON.stringify(report)}\n`);
