// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Run a long compileProject probe outside Vitest's worker process. Large npm
// graphs can synchronously occupy the compiler for longer than Vitest's worker
// heartbeat, producing a false infrastructure failure after valid assertions.

import { compileProject, type CompileOptions } from "../../src/index.js";
import { buildImports } from "../../src/runtime.js";

export const COMPILE_PROJECT_PROBE_MARKER = "__JS2_COMPILE_PROJECT_PROBE__";

const [entry, rawOptions, runExport] = process.argv.slice(2);
if (!entry || !rawOptions) {
  throw new Error("usage: compile-project-probe.ts <entry> <compile-options-json>");
}

const options = JSON.parse(rawOptions) as CompileOptions;
const result = await compileProject(entry, options);
let validationError: string | undefined;
let validationWat: string | undefined;
let instantiated = false;
let runtimeValue: unknown;
let runtimeError: string | undefined;
let instanceExports: WebAssembly.Exports | undefined;
let hostFailure: string | undefined;
let wasmImports: WebAssembly.ModuleImportDescriptor[] = [];
if (result.success) {
  try {
    const module = new WebAssembly.Module(result.binary);
    wasmImports = WebAssembly.Module.imports(module);
  } catch (error) {
    validationError = error instanceof Error ? error.message : String(error);
    const functionName = validationError.match(/function #\d+:\"([^\"]+)\"/)?.[1];
    if (functionName && result.wat) {
      const start = result.wat.indexOf(`(func $${functionName}`);
      if (start >= 0) {
        const next = result.wat.indexOf("\n  (func $", start + 1);
        validationWat = result.wat.slice(start, next >= 0 ? next : start + 24_000);
      }
    }
  }
  if (validationError === undefined && runExport) {
    try {
      const imports = buildImports(result.imports, undefined, result.stringPool);
      for (const [name, imported] of Object.entries(imports.env)) {
        if (typeof imported !== "function") continue;
        imports.env[name] = (...args: unknown[]) => {
          try {
            return imported(...args);
          } catch (error) {
            const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
            hostFailure = `${name}: ${detail}`;
            throw error;
          }
        };
      }
      const instantiatedResult = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
      instantiated = true;
      instanceExports = instantiatedResult.instance.exports;
      imports.setExports?.(instanceExports as Record<string, Function>);
      if (options.deferTopLevelInit) {
        const moduleInit = instanceExports.__module_init;
        if (typeof moduleInit === "function") moduleInit();
      }
      const exported = instanceExports[runExport];
      if (typeof exported !== "function") {
        throw new Error(`compiled module has no callable '${runExport}' export`);
      }
      runtimeValue = exported();
    } catch (error) {
      const exnTag = instanceExports?.__exn_tag;
      let thrownValue: unknown;
      if (error instanceof WebAssembly.Exception && exnTag instanceof WebAssembly.Tag && error.is(exnTag)) {
        thrownValue = error.getArg(exnTag, 0);
      }
      runtimeError =
        thrownValue !== undefined
          ? thrownValue instanceof Error
            ? (thrownValue.stack ?? `${thrownValue.name}: ${thrownValue.message}`)
            : String(thrownValue)
          : error instanceof Error
            ? (error.stack ?? `${error.name}: ${error.message}`)
            : typeof error === "object" && error !== null && "stack" in error
              ? String((error as { stack?: unknown }).stack ?? error)
              : String(error);
    }
  }
}
const report = {
  success: result.success,
  binaryByteLength: result.success ? result.binary.byteLength : 0,
  valid: result.success && validationError === undefined,
  validationError,
  validationWat,
  instantiated,
  runtimeValue,
  runtimeError,
  hostFailure,
  wasmImports,
  errors: result.errors.map((error) => ({
    message: error.message,
    severity: error.severity,
    file: error.file,
    line: error.line,
    column: error.column,
  })),
};

process.stdout.write(`${COMPILE_PROJECT_PROBE_MARKER}${JSON.stringify(report)}\n`);
