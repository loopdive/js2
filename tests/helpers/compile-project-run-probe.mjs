// Bounded compile + instantiate + primitive workload probe for npm dogfood.
//
// This intentionally lives beside compile-project-probe.ts instead of inside
// a package harness. Large package graphs must run out of process, but a
// package card must not call “compile + validate” a runtime proof. Callers
// provide a generated entry module and an exported zero-argument workload;
// this probe reports whether that function actually ran and what primitive it
// returned.

import { compileProject } from "../../src/index.ts";
import { renderHarnessThrownText } from "../../scripts/lib/wasm-exn-render.mjs";

export const COMPILE_PROJECT_RUN_PROBE_MARKER = "__JS2_COMPILE_PROJECT_RUN_PROBE__";

const [entry, rawOptions, exportName = "runCase"] = process.argv.slice(2);
if (!entry || !rawOptions) {
  throw new Error("usage: compile-project-run-probe.mjs <entry> <compile-options-json> [export-name]");
}

const options = JSON.parse(rawOptions);
const result = await compileProject(entry, options);
let valid = false;
let validationError = null;
let ran = false;
let value = null;
let runtimeError = null;
let runtimeStack = null;
let instance = null;

if (result.success) {
  try {
    const module = new WebAssembly.Module(result.binary);
    valid = true;
    const imports = result.importObject ?? {};
    instance = await WebAssembly.instantiate(module, imports);
    imports.__setInstance?.(instance);
    const workload = instance.exports[exportName];
    if (typeof workload !== "function") {
      runtimeError = `compiled module does not export ${JSON.stringify(exportName)}`;
    } else {
      value = workload();
      ran = true;
    }
  } catch (error) {
    if (!valid) {
      validationError = error instanceof Error ? error.message : String(error);
    } else {
      runtimeError = renderHarnessThrownText(error, instance);
      runtimeStack = error instanceof Error ? (error.stack ?? null) : null;
    }
  }
}

const report = {
  success: result.success,
  binaryByteLength: result.success ? result.binary.byteLength : 0,
  valid,
  validationError,
  errors: result.errors.map((error) => ({ message: error.message })),
  runtime: { ran, value, error: runtimeError, stack: runtimeStack },
};

process.stdout.write(`${COMPILE_PROJECT_RUN_PROBE_MARKER}${JSON.stringify(report)}\n`);
