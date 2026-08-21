import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";

import { compile, compileProject } from "../../src/index.ts";
import { buildCompiledImports, wrapExports } from "../../src/runtime.ts";
import { getWebHostConstructors } from "../../src/runtime/web-host-constructors.ts";

const generatedPath = process.argv[2];
const mode = process.argv[3] ?? "project";

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function errorText(error, instance) {
  let text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (error && typeof error.getArg === "function" && instance?.exports) {
    for (const tagName of ["__exn_tag", "__tag"]) {
      const tag = instance.exports[tagName];
      if (!tag) continue;
      try {
        const payload = error.getArg(tag, 0);
        if (payload !== undefined && payload !== null) text += ` payload=${String(payload)}`;
      } catch {
        // The exception may belong to a host tag rather than the module tag.
      }
    }
  }
  if (error?.stack && !text.includes(error.stack)) text += `\n${error.stack}`;
  return text;
}

async function loadNodeHostDependencies() {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const dependencies = Object.create(null);
  // Resolve both the namespace-qualified import and the exported class/function
  // names. This keeps the worker generic for upstream suites that use a small
  // Node builtin surface without replacing any package implementation.
  for (const moduleName of [
    "node:async_hooks",
    "node:assert",
    "node:buffer",
    "node:crypto",
    "node:events",
    "node:os",
    "node:stream",
    "node:timers",
    "node:url",
    "node:util",
  ]) {
    try {
      const namespace = require(moduleName);
      dependencies[moduleName] = namespace;
      dependencies[moduleName.slice(5)] = namespace;
      Object.assign(dependencies, namespace);
    } catch {
      // Optional builtins remain subject to the compiler's normal diagnostic.
    }
  }
  // Node exposes the WHATWG encoding/stream constructors globally, but the
  // compiled adapter resolves extern classes from the explicit dependency
  // map. Forward the same host constructors so upstream Node tests can use
  // TextEncoder/TextDecoder and related Web APIs without a package shim.
  Object.assign(dependencies, getWebHostConstructors());
  return dependencies;
}

async function main() {
  const started = performance.now();
  const platform = process.env.DOGFOOD_PLATFORM ?? "web";
  // ReactDOM's original tests execute against Jest's jsdom environment. The
  // compiler worker is a separate process, so the parent harness's globals do
  // not cross the process boundary. Install the same explicit browser-global
  // set before building the import object when this worker is used for that
  // lane; other upstream suites keep the worker hermetic.
  if (process.env.DOGFOOD_INSTALL_JSDOM === "1") {
    const { installReactTestEnvironment } = await import("./react-test-environment.mjs");
    const { installReactUpstreamInfrastructure } = await import("./react-upstream-infrastructure.mjs");
    installReactTestEnvironment();
    const { createRequire } = await import("node:module");
    const workerRequire = createRequire(import.meta.url);
    installReactUpstreamInfrastructure({ react: workerRequire("react") });
  }
  let result;
  try {
    const projectOptions = {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "gc",
      platform,
      experimentalIR: process.env.DOGFOOD_REACT_DOM_LEGACY !== "1",
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
    };
    result =
      mode === "source"
        ? await compile(readFileSync(generatedPath, "utf8"), {
            fileName: generatedPath,
            skipSemanticDiagnostics: true,
            experimentalIR: process.env.DOGFOOD_REACT_DOM_LEGACY !== "1",
            sourceMap: true,
            platform,
            deferTopLevelInit: true,
          })
        : await compileProject(generatedPath, projectOptions);
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

  if (mode === "source") {
    emit({
      compile: { success: true, validates: true, durationMs, binaryBytes: result.binary.length, errors: [] },
      wasm: null,
    });
    return;
  }

  try {
    const imports =
      platform === "node" || process.env.DOGFOOD_NODE_HOST_DEPS === "1"
        ? buildCompiledImports(result, await loadNodeHostDependencies())
        : (result.importObject ?? {});
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    imports.__setInstance?.(instance);
    try {
      instance.exports.__module_init?.();
    } catch (error) {
      emit({
        compile: { success: true, validates: true, durationMs, binaryBytes: result.binary.length, errors: [] },
        wasm: { fatal: `module init: ${errorText(error, instance)}`, count: 0, statuses: [] },
      });
      return;
    }
    const exports = wrapExports(instance, { signatures: result.exportSignatures });
    let statuses;
    let errors;
    if (process.env.DOGFOOD_NAMED_TEST_EXPORTS === "1" && typeof exports.upstreamTestNames === "function") {
      const names = Array.from(await exports.upstreamTestNames(), String);
      statuses = [];
      errors = [];
      for (const name of names) {
        let value;
        let thrown = null;
        try {
          value = await exports[name]();
        } catch (error) {
          thrown = error;
        }
        statuses.push(Number(value) === 1);
        if (Number(value) === 1) errors.push("");
        else if (thrown) errors.push(errorText(thrown, instance));
        else {
          try {
            errors.push(String(exports.__react_last_error?.() ?? exports.__last_error?.() ?? ""));
          } catch {
            errors.push("");
          }
        }
      }
    } else if (typeof exports.runUpstreamTest === "function") {
      // Run one callback at a time so Promise-returning upstream tests can be
      // awaited without putting the whole synchronous suite behind one async
      // state machine. This keeps the Wasm/native contract aligned while
      // preserving the original fast path for synchronous callbacks.
      const count = Number(await exports.upstreamTestCount());
      statuses = [];
      errors = [];
      for (let index = 0; index < count; index++) {
        let value;
        let thrown = null;
        try {
          value = await exports.runUpstreamTest(index);
        } catch (error) {
          thrown = error;
        }
        statuses.push(Number(value) === 1);
        if (Number(value) === 1) errors.push("");
        else if (thrown) errors.push(errorText(thrown, instance));
        else {
          try {
            errors.push(String(exports.upstreamTestErrors()[index] ?? ""));
          } catch {
            errors.push("");
          }
        }
      }
    } else {
      statuses = Array.from(exports.runUpstreamTests(), (value) => Number(value) === 1);
      errors = Array.from(exports.upstreamTestErrors(), String);
    }
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
