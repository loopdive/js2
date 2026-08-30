import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";

import { compile, compileProject, instantiateLinkedProject } from "../../src/index.ts";
import { buildCompiledImports, wrapExports } from "../../src/runtime.ts";
import { getWebHostConstructors } from "../../src/runtime/web-host-constructors.ts";
import {
  configuredUpstreamTestTimeoutMs,
  emitWorkerResult,
  runSequentialUpstreamTests,
  signalWorkerCompileComplete,
} from "./upstream-suite-worker-protocol.mjs";

const generatedPath = process.argv[2];
const mode = process.argv[3] ?? "project";

const emit = emitWorkerResult;

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

function sourceLocationForWasmError(error, sourceMapText) {
  const stack = String(error?.stack ?? "");
  const match = stack.match(/wasm-function\[\d+\]:(0x[\da-f]+)/i);
  if (!match || !sourceMapText) return null;
  const target = Number.parseInt(match[1], 16);
  const map = JSON.parse(sourceMapText);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const decode = (segment) => {
    const values = [];
    for (let index = 0; index < segment.length; ) {
      let value = 0;
      let shift = 0;
      let digit;
      do {
        digit = alphabet.indexOf(segment[index++]);
        value |= (digit & 31) << shift;
        shift += 5;
      } while (digit & 32);
      values.push(value & 1 ? -(value >>> 1) : value >>> 1);
    }
    return values;
  };
  let offset = 0;
  let source = 0;
  let line = 0;
  let column = 0;
  let best = null;
  for (const segment of String(map.mappings ?? "").split(",")) {
    const values = decode(segment);
    if (values.length < 4) continue;
    offset += values[0];
    source += values[1];
    line += values[2];
    column += values[3];
    if (offset > target) break;
    best = `${map.sources?.[source] ?? "?"}:${line + 1}:${column + 1}`;
  }
  return best;
}

async function loadNodeHostDependencies() {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const dependencies = Object.create(null);
  const { DOM_GLOBALS } = await import("./react-test-environment.mjs");
  // Resolve both the namespace-qualified import and the exported class/function
  // names. This keeps the worker generic for upstream suites that use a small
  // Node builtin surface without replacing any package implementation.
  for (const moduleName of [
    "node:async_hooks",
    "node:assert",
    "node:assert/strict",
    "node:buffer",
    "node:child_process",
    "node:crypto",
    "node:dns",
    "node:events",
    "node:fs",
    "node:fs/promises",
    "node:http",
    "node:https",
    "node:module",
    "node:net",
    "node:os",
    "node:perf_hooks",
    "node:process",
    "node:querystring",
    "node:readline",
    "node:stream",
    "node:string_decoder",
    "node:timers",
    "node:timers/promises",
    "node:tls",
    "node:tty",
    "node:url",
    "node:util",
    "node:vm",
    "node:worker_threads",
    "node:zlib",
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
  for (const name of DOM_GLOBALS) {
    const value = globalThis[name];
    if (value !== undefined) dependencies[name] = value;
  }
  return dependencies;
}

// The compiler's default web import object is intentionally hermetic and
// therefore cannot see the JSDOM globals installed by this worker. Upstream
// ReactDOM tests need the actual document/window objects and their constructors
// at the Wasm boundary, so bind exactly the explicit environment surface rather
// than relying on an ambient empty-object provider.
async function loadWebHostDependencies() {
  const { DOM_GLOBALS } = await import("./react-test-environment.mjs");
  const dependencies = Object.create(null);
  Object.assign(dependencies, getWebHostConstructors());
  for (const name of DOM_GLOBALS) {
    const value = globalThis[name];
    if (value !== undefined) dependencies[name] = value;
  }
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
    installReactUpstreamInfrastructure({
      react: workerRequire("react"),
      preferReactDomAct: process.env.DOGFOOD_REACT_DOM_ACT === "1",
    });
  }
  let result;
  try {
    const projectOptions = {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "gc",
      platform,
      // A package opts into the Node host lane explicitly when it imports
      // path-based `node:fs` APIs. Keep the default web lane hermetic, but do
      // enable the compiler's real-fs capability gate for that same opt-in;
      // otherwise the worker resolves the namespace and still emits a null
      // provider for `readFileSync`/`existsSync`.
      allowFs: platform === "node" || process.env.DOGFOOD_NODE_HOST_DEPS === "1",
      experimentalIR: process.env.DOGFOOD_REACT_DOM_LEGACY !== "1",
      // The upstream compatibility lane only needs the binary. WAT is a
      // diagnostic artifact and can become quadratic for large generated
      // closed-dispatch functions, turning a valid compile into a watchdog
      // timeout without affecting validation or execution.
      emitWat: false,
      sourceMap: process.env.DOGFOOD_SOURCE_DIAG === "1",
      // Original suites frequently initialize object graphs at module load.
      // In the JS-host lane, WasmGC field/callable reflection only becomes
      // available after the instance is handed to the runtime. Run the same
      // initializer after that handoff instead of inside WebAssembly.start.
      deferTopLevelInit: true,
      ...(process.env.DOGFOOD_PACKAGE_CACHE_DIR
        ? {
            packageCacheDir: process.env.DOGFOOD_PACKAGE_CACHE_DIR,
            // A package-cache benchmark measures separate provider modules.
            // Do not silently recompile their sources monolithically when the
            // consumer itself has an unsupported compiler shape.
            packageLinking: "separate",
          }
        : {}),
    };
    result =
      mode === "source"
        ? await compile(readFileSync(generatedPath, "utf8"), {
            fileName: generatedPath,
            skipSemanticDiagnostics: true,
            experimentalIR: process.env.DOGFOOD_REACT_DOM_LEGACY !== "1",
            sourceMap: true,
            platform,
            allowFs: platform === "node" || process.env.DOGFOOD_NODE_HOST_DEPS === "1",
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
  // The parent owns two independent deadlines. Signal the stage boundary
  // before validation, instantiation, or an upstream async test can wait on
  // runtime/host behavior and be mislabeled as a compile timeout.
  signalWorkerCompileComplete(durationMs);
  if (!result.success || !result.binary?.length) {
    emit({
      compile: {
        success: false,
        validates: false,
        durationMs,
        binaryBytes: 0,
        errors: result.errors ?? [],
        linkPlan: result.linkPlan ?? null,
      },
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
        linkPlan: result.linkPlan ?? null,
        errors: [],
        validationError: errorText(error),
      },
      wasm: null,
    });
    return;
  }

  if (mode === "source") {
    emit({
      compile: {
        success: true,
        validates: true,
        durationMs,
        binaryBytes: result.binary.length,
        linkPlan: result.linkPlan ?? null,
        errors: [],
      },
      wasm: null,
    });
    return;
  }

  try {
    const imports = buildCompiledImports(
      result,
      platform === "node" || process.env.DOGFOOD_NODE_HOST_DEPS === "1"
        ? await loadNodeHostDependencies()
        : await loadWebHostDependencies(),
    );
    const { instance } = result.linkedModules?.length
      ? await instantiateLinkedProject(result, imports)
      : await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    imports.__setInstance?.(instance);
    try {
      instance.exports.__module_init?.();
    } catch (error) {
      const sourceLocation =
        process.env.DOGFOOD_SOURCE_DIAG === "1" ? sourceLocationForWasmError(error, result.sourceMap) : null;
      emit({
        compile: {
          success: true,
          validates: true,
          durationMs,
          binaryBytes: result.binary.length,
          linkPlan: result.linkPlan ?? null,
          errors: [],
        },
        wasm: {
          fatal: `module init: ${errorText(error, instance)}${sourceLocation ? `\nsource: ${sourceLocation}` : ""}`,
          count: 0,
          statuses: [],
        },
      });
      return;
    }
    const exports = wrapExports(instance, { signatures: result.exportSignatures });
    const testTimeoutMs = configuredUpstreamTestTimeoutMs();
    let statuses;
    let errors;
    if (process.env.DOGFOOD_NAMED_TEST_EXPORTS === "1" && typeof exports.upstreamTestNames === "function") {
      const names = Array.from(await exports.upstreamTestNames(), String);
      ({ statuses, errors } = await runSequentialUpstreamTests({
        ids: names,
        invoke: (name) => exports[name](),
        timeoutMs: testTimeoutMs,
        thrownText: (error) => errorText(error, instance),
        failureText: () => {
          try {
            return String(exports.__react_last_error?.() ?? exports.__last_error?.() ?? "");
          } catch {
            return "";
          }
        },
      }));
    } else if (typeof exports.runUpstreamTest === "function") {
      // Run one callback at a time so Promise-returning upstream tests can be
      // awaited without putting the whole synchronous suite behind one async
      // state machine. This keeps the Wasm/native contract aligned while
      // preserving the original fast path for synchronous callbacks.
      const count = Number(await exports.upstreamTestCount());
      ({ statuses, errors } = await runSequentialUpstreamTests({
        ids: Array.from({ length: count }, (_, index) => index),
        invoke: (index) => exports.runUpstreamTest(index),
        timeoutMs: testTimeoutMs,
        thrownText: (error) => errorText(error, instance),
        failureText: (index) => {
          try {
            return String(exports.upstreamTestErrors()[index] ?? "");
          } catch {
            return "";
          }
        },
      }));
    } else {
      statuses = Array.from(exports.runUpstreamTests(), (value) => Number(value) === 1);
      errors = Array.from(exports.upstreamTestErrors(), String);
    }
    await exports.cleanupUpstreamTestEnvironment?.();
    emit({
      compile: {
        success: true,
        validates: true,
        durationMs,
        binaryBytes: result.binary.length,
        linkPlan: result.linkPlan ?? null,
        errors: [],
      },
      wasm: { count: Number(exports.upstreamTestCount()), statuses, errors },
    });
  } catch (error) {
    emit({
      compile: {
        success: true,
        validates: true,
        durationMs,
        binaryBytes: result.binary.length,
        linkPlan: result.linkPlan ?? null,
        errors: [],
      },
      wasm: { fatal: errorText(error), count: 0, statuses: [] },
    });
  }
}

main().catch((error) => {
  emit(
    {
      compile: {
        success: false,
        validates: false,
        durationMs: 0,
        binaryBytes: 0,
        errors: [{ message: errorText(error) }],
      },
      wasm: null,
    },
    1,
  );
});
