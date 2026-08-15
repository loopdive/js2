import { performance } from "node:perf_hooks";

import { compileProject } from "../../src/index.ts";
import { wrapExports } from "../../src/runtime.ts";

const generatedPath = process.argv[2];

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function main() {
  const started = performance.now();
  let result;
  try {
    result = await compileProject(generatedPath, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "gc",
      platform: "node",
      // The upstream compatibility lane only needs the binary. WAT is a
      // diagnostic artifact and can become quadratic for large generated
      // closed-dispatch functions, turning a valid compile into a watchdog
      // timeout without affecting validation or execution.
      emitWat: false,
      // Original suites frequently initialize object graphs at module load.
      // In the JS-host lane, WasmGC field/callable reflection only becomes
      // available after the instance is handed to the runtime. Run the same
      // initializer after that handoff instead of inside WebAssembly.start.
      deferTopLevelInit: true,
    });
  } catch (error) {
    emit({
      compile: {
        success: false,
        validates: false,
        durationMs: Math.round(performance.now() - started),
        binaryBytes: 0,
        errors: [{ message: errorText(error) }],
      },
      wasm: null,
    });
    return;
  }

  const durationMs = Math.round(performance.now() - started);
  if (!result.success || !result.binary?.length) {
    emit({
      compile: { success: false, validates: false, durationMs, binaryBytes: 0, errors: result.errors ?? [] },
      wasm: null,
    });
    return;
  }

  try {
    await WebAssembly.compile(result.binary);
  } catch (error) {
    emit({
      compile: {
        success: true,
        validates: false,
        durationMs,
        binaryBytes: result.binary.length,
        errors: [],
        validationError: errorText(error),
      },
      wasm: null,
    });
    return;
  }

  try {
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    imports.__setInstance?.(instance);
    instance.exports.__module_init?.();
    const exports = wrapExports(instance, { signatures: result.exportSignatures });
    const statuses = Array.from(exports.runUpstreamTests(), (value) => Number(value) === 1);
    const errors = Array.from(exports.upstreamTestErrors(), String);
    emit({
      compile: { success: true, validates: true, durationMs, binaryBytes: result.binary.length, errors: [] },
      wasm: { count: Number(exports.upstreamTestCount()), statuses, errors },
    });
  } catch (error) {
    emit({
      compile: { success: true, validates: true, durationMs, binaryBytes: result.binary.length, errors: [] },
      wasm: { fatal: errorText(error), count: 0, statuses: [] },
    });
  }
}

main().catch((error) => {
  emit({
    compile: {
      success: false,
      validates: false,
      durationMs: 0,
      binaryBytes: 0,
      errors: [{ message: errorText(error) }],
    },
    wasm: null,
  });
  process.exitCode = 1;
});
