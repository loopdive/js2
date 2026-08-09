import { parentPort, workerData } from "node:worker_threads";

import { register } from "tsx/esm/api";

const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...args) => {
  const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  if (text.includes("[js2:profile]")) parentPort.postMessage({ type: "profile", text });
  return originalStderrWrite(chunk, ...args);
};

register();
const { compileProject } = await import("../../src/index.ts");

const options = {
  // The npm-compat lane measures code generation rather than whether upstream's
  // own monorepo type-checks under js2's deliberately minimal ambient libs.
  // Keep the same diagnostic policy for source and published-JS comparisons.
  allowJs: true,
  skipSemanticDiagnostics: true,
  target: "gc",
  platform: "node",
};
const started = performance.now();

try {
  const result = await compileProject(workerData.entry, options);
  parentPort.postMessage({
    type: "result",
    elapsedMs: Math.round(performance.now() - started),
    success: result.success,
    binaryBytes: result.binary.byteLength,
    validates: result.success && WebAssembly.validate(result.binary),
    errorCount: result.errors.length,
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
