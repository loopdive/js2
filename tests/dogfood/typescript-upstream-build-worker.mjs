import { parentPort, workerData } from "node:worker_threads";
import { writeFileSync } from "node:fs";

import { register } from "tsx/esm/api";

import { typescriptInvocationMatches } from "./typescript-upstream-build-probe.mjs";

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

const options = {
  // The npm-compat lane measures code generation rather than whether upstream's
  // own monorepo type-checks under js2's deliberately minimal ambient libs.
  // Keep the same diagnostic policy for source and published-JS comparisons.
  allowJs: true,
  skipSemanticDiagnostics: true,
  target: "gc",
  platform: "node",
  // This probe accepts the core binary and an executed export. Rendering the
  // same very large instruction graph as diagnostic WAT adds no evidence and
  // can dominate the bounded worker budget.
  emitWat: false,
  sourceMap: process.env.JS2WASM_TYPESCRIPT_PROBE_SOURCE_MAP === "1",
  ...(workerData.consumerDrivenBarrels ? { resolve: { consumerDrivenBarrels: true } } : {}),
};
const started = performance.now();

try {
  const result = await compileProject(workerData.entry, options);
  if (process.env.JS2WASM_TYPESCRIPT_PROBE_DIAGNOSTIC === "1") {
    writeFileSync("/private/tmp/ts2wasm-typescript-parser-latest.wasm", result.binary);
    if (result.sourceMap) writeFileSync("/private/tmp/ts2wasm-typescript-parser-latest.wasm.map", result.sourceMap);
  }
  let invocation = null;
  let invocations = null;
  if (result.success && workerData.invokeExport) {
    let runtimePhase = "instantiate";
    try {
      const imports = result.importObject ?? {};
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      runtimePhase = "bind-instance";
      imports.setInstance?.(instance);
      imports.__setInstance?.(instance);
      runtimePhase = "wrap-exports";
      const exports = wrapExports(instance, { signatures: result.exportSignatures });
      runtimePhase = "lookup-export";
      const callable = exports[workerData.invokeExport];
      if (typeof callable !== "function") throw new Error(`Missing export ${workerData.invokeExport}`);
      invocations = workerData.invocationCases.map(({ name, input, expected, requireSafeInteger }) => {
        try {
          runtimePhase = `invoke:${name}`;
          const actual = callable(input);
          return {
            name,
            inputBytes: Buffer.byteLength(input, "utf8"),
            actual,
            expected,
            matches: typescriptInvocationMatches(actual, expected, requireSafeInteger),
          };
        } catch (error) {
          const details = runtimeErrorDetails(error, result.sourceMap);
          return {
            name,
            inputBytes: Buffer.byteLength(input, "utf8"),
            expected,
            phase: runtimePhase,
            error: details.message,
            stack: details.stack,
            wasmOffset: details.wasmOffset,
            sourceLocation: details.sourceLocation,
            matches: false,
          };
        }
      });
      invocation = invocations.length === 1 ? invocations[0] : null;
    } catch (error) {
      const details = runtimeErrorDetails(error, result.sourceMap);
      invocations = workerData.invocationCases.map(({ name, input, expected }) => ({
        name,
        inputBytes: Buffer.byteLength(input, "utf8"),
        expected,
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
    !workerData.invokeExport ||
    (invocations?.length === workerData.requiredInvocations && invocations.every((record) => record.matches === true));
  parentPort.postMessage({
    type: "result",
    elapsedMs: Math.round(performance.now() - started),
    success: result.success && invocationMatches,
    compileSuccess: result.success,
    binaryBytes: result.binary.byteLength,
    validates: result.success && WebAssembly.validate(result.binary),
    errorCount: result.errors.length,
    invocation,
    invocations,
    errors: result.errors
      .slice(0, 20)
      .map(({ message, file, line, column, code, severity }) => ({ message, file, line, column, code, severity })),
  });
} catch (error) {
  parentPort.postMessage({
    type: "error",
    elapsedMs: Math.round(performance.now() - started),
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}
