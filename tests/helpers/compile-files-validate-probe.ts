// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4420) Run `compileFiles` with the engine-validation gate outside Vitest's
// worker process. Same reason as `compile-project-probe.ts`: a real source
// graph (the compiler's own `src/emit/binary.ts` pulls in ~270 KB of Wasm)
// needs more heap than the 512 MB the fork pool gives a worker, and a
// heap-exhausted worker reads as an infrastructure failure rather than a
// verdict.
//
// Prints one marker line with the verdict: whether `compileFiles` reported
// success under `validate: true`, and — independently — whether the host
// engine actually accepts the emitted bytes.

import { createRequire } from "node:module";

// `analyzeFiles` (src/checker/index.ts) reaches for a bare `require("node:path")`.
// Under an ESM entry that binding does not exist, and Node reports it as
// ERR_AMBIGUOUS_MODULE_SYNTAX rather than a missing global. Provide it before
// the compiler is loaded.
(globalThis as unknown as { require?: NodeRequire }).require ??= createRequire(import.meta.url);

const { compileFiles } = await import("../../src/index.js");

export const COMPILE_FILES_VALIDATE_PROBE_MARKER = "__JS2_COMPILE_FILES_VALIDATE_PROBE__";

const [entry] = process.argv.slice(2);
if (!entry) {
  throw new Error("usage: compile-files-validate-probe.ts <entry>");
}

// `emitWat: false`: the full-module WAT for a graph this size is a multi-MB
// string built from millions of fragments, and nothing here reads it.
const result = await compileFiles(entry, { validate: true, emitWat: false });

let engineAccepts = false;
let engineError: string | null = null;
try {
  await WebAssembly.compile(result.binary as unknown as BufferSource);
  engineAccepts = true;
} catch (error) {
  engineError = error instanceof Error ? error.message : String(error);
}

const report = {
  success: result.success,
  binaryByteLength: result.binary.byteLength,
  engineAccepts,
  engineError,
  errors: result.errors
    .filter((error) => error.severity !== "warning")
    .map((error) => ({
      message: error.message,
      line: error.line,
      column: error.column,
    })),
};

process.stdout.write(`${COMPILE_FILES_VALIDATE_PROBE_MARKER}${JSON.stringify(report)}\n`);
