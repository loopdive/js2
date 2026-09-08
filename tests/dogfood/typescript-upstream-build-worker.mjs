import { parentPort, workerData } from "node:worker_threads";
import { setFlagsFromString } from "node:v8";

import { register } from "tsx/esm/api";

import {
  assertTypescriptBuildProbeInvocationSupported,
  typescriptBuildProbeErrorSummary,
  typescriptBuildProbeTarget,
  typescriptInvocationMatches,
} from "./typescript-upstream-build-probe.mjs";

function decodeVlq(segment) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const values = [];
  for (let index = 0; index < segment.length; ) {
    let value = 0;
    let shift = 0;
    let digit;
    do {
      digit = alphabet.indexOf(segment[index++]);
      if (digit < 0) return values;
      value |= (digit & 31) << shift;
      shift += 5;
    } while (digit & 32);
    values.push(value & 1 ? -(value >>> 1) : value >>> 1);
  }
  return values;
}

function sourceAtWasmOffset(sourceMapJson, wasmOffset) {
  if (!sourceMapJson || wasmOffset === null) return null;
  const sourceMap = JSON.parse(sourceMapJson);
  let offset = 0;
  let source = 0;
  let line = 0;
  let column = 0;
  let best = null;
  for (const segment of String(sourceMap.mappings ?? "").split(",")) {
    const values = decodeVlq(segment);
    if (values.length < 4) continue;
    offset += values[0];
    source += values[1];
    line += values[2];
    column += values[3];
    if (offset > wasmOffset) break;
    best = { source: sourceMap.sources?.[source] ?? "", line: line + 1, column: column + 1, wasmOffset: offset };
  }
  return best;
}

function runtimeErrorDetails(error, sourceMapJson) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  const stackOffsetMatch = stack?.match(/:0x([\da-f]+)\)?/i);
  const validationOffsetMatch = message.match(/@\+(\d+)/);
  const wasmOffset = stackOffsetMatch
    ? Number.parseInt(stackOffsetMatch[1], 16)
    : validationOffsetMatch
      ? Number.parseInt(validationOffsetMatch[1], 10)
      : null;
  return { message, stack, wasmOffset, sourceLocation: sourceAtWasmOffset(sourceMapJson, wasmOffset) };
}

const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...args) => {
  const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  if (text.includes("[js2:profile]")) parentPort.postMessage({ type: "profile", text });
  if (process.env.JS2WASM_TYPESCRIPT_PROBE_DIAGNOSTIC === "1" && text.includes("[js2:profile]")) return true;
  return originalStderrWrite(chunk, ...args);
};

register();
const { compileProject } = await import("../../src/index.ts");
const { wrapExports } = await import("../../src/runtime.ts");
const requestedTarget = typescriptBuildProbeTarget(workerData.requestedTarget);
assertTypescriptBuildProbeInvocationSupported(
  requestedTarget,
  workerData.invocationCases?.length > 0,
  workerData.invocationCases?.length > 0 && workerData.invocationCases.every((record) => record.zeroArguments === true),
);

const options = {
  // The npm-compat lane measures code generation rather than whether upstream's
  // own monorepo type-checks under js2's deliberately minimal ambient libs.
  // Keep the same diagnostic policy for source and published-JS comparisons.
  allowJs: true,
  skipSemanticDiagnostics: true,
  target: requestedTarget,
  // Standalone is a host-free deployment lane. Leaving platform unset is
  // part of the contract: ambient Node globals must not leak into its graph.
  ...(requestedTarget === "gc" ? { platform: "node" } : {}),
  // This probe accepts the core binary and an executed export. Rendering the
  // same very large instruction graph as diagnostic WAT adds no evidence and
  // can dominate the bounded worker budget.
  emitWat: false,
  sourceMap: process.env.JS2WASM_TYPESCRIPT_PROBE_SOURCE_MAP === "1",
  trackIrOutcomes: process.env.JS2WASM_TYPESCRIPT_PROBE_IR_OUTCOMES === "1",
  ...(workerData.consumerDrivenBarrels ? { resolve: { consumerDrivenBarrels: true } } : {}),
};
const started = performance.now();

try {
  const result = await compileProject(workerData.entry, options);
  const actualTarget = result.targetProfile?.target ?? null;
  let module = null;
  let moduleImports = null;
  let validationError = null;
  if (result.binary?.byteLength > 0) {
    try {
      module = new WebAssembly.Module(result.binary);
      moduleImports = WebAssembly.Module.imports(module).map(({ module: namespace, name, kind }) => ({
        module: namespace,
        name,
        kind,
      }));
    } catch (error) {
      validationError = runtimeErrorDetails(error, result.sourceMap);
    }
  }
  const validates = result.success && module !== null;
  let invocation = null;
  let invocations = null;
  if (result.success && workerData.invocationCases.length > 0) {
    let runtimePhase = "instantiate";
    try {
      if (module === null) throw new Error(validationError?.message ?? "Wasm module validation failed");
      if (requestedTarget === "standalone" && moduleImports?.length !== 0) {
        throw new Error(`Standalone module unexpectedly has ${moduleImports?.length ?? "unknown"} imports`);
      }
      const imports = requestedTarget === "standalone" ? {} : (result.importObject ?? {});
      // Enable tracing only around startup: --trace-wasm on the Node command
      // line also traces tsx's own Wasm parser during compilation (millions of
      // irrelevant calls). This changes diagnostics, not the module or verdict.
      const traceStartup = process.env.JS2WASM_TYPESCRIPT_PROBE_TRACE_STARTUP === "1";
      let instance;
      if (traceStartup) setFlagsFromString("--trace-wasm");
      try {
        instance = await WebAssembly.instantiate(module, imports);
      } finally {
        if (traceStartup) setFlagsFromString("--no-trace-wasm");
      }
      let exports;
      if (requestedTarget === "standalone") {
        exports = instance.exports;
      } else {
        runtimePhase = "bind-instance";
        imports.setInstance?.(instance);
        imports.__setInstance?.(instance);
        runtimePhase = "wrap-exports";
        exports = wrapExports(instance, { signatures: result.exportSignatures });
      }
      invocations = workerData.invocationCases.map(
        ({ name, exportName, input, expected, requireSafeInteger, zeroArguments }) => {
          try {
            runtimePhase = `lookup-export:${exportName}`;
            const callable = exports[exportName];
            if (typeof callable !== "function") throw new Error(`Missing export ${exportName}`);
            runtimePhase = `invoke:${name}`;
            const traceInvocation = process.env.JS2WASM_TYPESCRIPT_PROBE_TRACE_INVOKE === "1";
            let actual;
            if (traceInvocation) setFlagsFromString("--trace-wasm");
            try {
              actual = zeroArguments ? callable() : callable(input);
            } finally {
              if (traceInvocation) setFlagsFromString("--no-trace-wasm");
            }
            return {
              name,
              exportName,
              inputBytes: input === null ? 0 : Buffer.byteLength(input, "utf8"),
              actual,
              expected,
              zeroArguments,
              matches: typescriptInvocationMatches(actual, expected, requireSafeInteger),
            };
          } catch (error) {
            const details = runtimeErrorDetails(error, result.sourceMap);
            return {
              name,
              exportName,
              inputBytes: input === null ? 0 : Buffer.byteLength(input, "utf8"),
              expected,
              zeroArguments,
              phase: runtimePhase,
              error: details.message,
              stack: details.stack,
              wasmOffset: details.wasmOffset,
              sourceLocation: details.sourceLocation,
              matches: false,
            };
          }
        },
      );
      invocation = invocations.length === 1 ? invocations[0] : null;
    } catch (error) {
      const details = runtimeErrorDetails(error, result.sourceMap);
      invocations = workerData.invocationCases.map(({ name, exportName, input, expected, zeroArguments }) => ({
        name,
        exportName,
        inputBytes: input === null ? 0 : Buffer.byteLength(input, "utf8"),
        expected,
        zeroArguments,
        phase: runtimePhase,
        error: details.message,
        stack: details.stack,
        wasmOffset: details.wasmOffset,
        sourceLocation: details.sourceLocation,
        matches: false,
      }));
      invocation = invocations.length === 1 ? invocations[0] : null;
    }
  }
  const invocationMatches =
    workerData.invocationCases.length === 0 ||
    (invocations?.length === workerData.requiredInvocations && invocations.every((record) => record.matches === true));
  const targetMatches = actualTarget === requestedTarget;
  const importPolicyMatches =
    Array.isArray(moduleImports) && (requestedTarget !== "standalone" || moduleImports.length === 0);
  const accepted = result.success && validates && targetMatches && importPolicyMatches && invocationMatches;
  const diagnosticArtifactCandidate =
    workerData.diagnosticArtifactEnabled && accepted ? { binary: result.binary, sourceMap: result.sourceMap } : null;
  const message = {
    type: "result",
    requestedTarget,
    actualTarget,
    elapsedMs: Math.round(performance.now() - started),
    success: accepted,
    compileSuccess: result.success,
    binaryBytes: result.binary.byteLength,
    validates,
    validationError,
    moduleImports,
    moduleImportCount: moduleImports?.length ?? null,
    errorCount: result.errors.length,
    invocation,
    invocations,
    diagnosticArtifactCandidate,
    ...(options.trackIrOutcomes ? { irOutcomes: result.irOutcomes ?? null } : {}),
    errors: typescriptBuildProbeErrorSummary(result.errors),
  };
  const transferList =
    diagnosticArtifactCandidate?.binary.buffer instanceof ArrayBuffer
      ? [diagnosticArtifactCandidate.binary.buffer]
      : [];
  parentPort.postMessage(message, transferList);
} catch (error) {
  parentPort.postMessage({
    type: "error",
    requestedTarget,
    actualTarget: null,
    moduleImports: null,
    elapsedMs: Math.round(performance.now() - started),
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}
