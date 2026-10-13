/** Compiler route identity is separate from backend, providers and IR_FIRST. */
export const IR_COMPILER_PATH_BLOCKER = "ir-only-compiler-api-unavailable";
export const IR_COMPILER_PATH_REASON =
  "IR-only Test262 compilation is unavailable: public compile/compileMulti still use direct generators. " +
  "The internal prepared pipeline has no adopted public complete-program route; IR_FIRST and per-unit IR telemetry are not IR-only execution.";

export function parseTest262CompilerPath(raw) {
  if (raw === undefined || raw === "" || raw === "legacy") return "legacy";
  if (raw === "ir") return raw;
  throw new Error(`Invalid compiler path: ${raw}; expected legacy or ir`);
}

export function requireTest262CompilerPath(raw) {
  const path = parseTest262CompilerPath(raw);
  if (path === "ir") {
    const error = new Error(IR_COMPILER_PATH_REASON);
    error.code = IR_COMPILER_PATH_BLOCKER;
    throw error;
  }
  return path;
}

export function test262CompilerPathStatus(raw) {
  const compilerPath = parseTest262CompilerPath(raw);
  return {
    schema: "test262-compiler-path-status-v1",
    compilerPath,
    compilerPathVerified: false,
    executionCompilerPath: "unknown",
    state: compilerPath === "ir" ? "unavailable" : "requested",
    ...(compilerPath === "ir" ? { reason: IR_COMPILER_PATH_REASON, blockerCode: IR_COMPILER_PATH_BLOCKER } : {}),
  };
}

export function test262RequestedCompilerPathMetadata(raw, target) {
  const compilerPath = requireTest262CompilerPath(raw);
  return {
    compilerPath,
    compilerPathVerified: false,
    executionCompilerPath: "unknown",
    // This describes configuration, never proves which executable units ran.
    // Actual target-profile.ts maps only linear to Linear; WASI stays WasmGC.
    configuredCompilerPath:
      target === "linear"
        ? "legacy"
        : target === undefined || ["gc", "wasi", "standalone"].includes(target)
          ? "hybrid"
          : "unknown",
  };
}

export function summarizeTest262CompilerPaths(records, requested) {
  if (requested !== undefined) requireTest262CompilerPath(requested);
  const paths = new Set();
  const configurations = new Set();
  for (const record of records) {
    const path = record.compilerPath ?? "unknown";
    if (!["legacy", "ir", "unknown"].includes(path)) throw new Error(`Invalid result compilerPath: ${path}`);
    const execution = record.executionCompilerPath ?? "unknown";
    if (!["legacy", "hybrid", "ir", "unknown"].includes(execution)) {
      throw new Error(`Invalid executionCompilerPath: ${execution}`);
    }
    // No adopted authentic IR execution contract exists yet. Row booleans,
    // filenames and CLI requests cannot manufacture it, including negatives.
    if (path === "ir" || record.executionCompilerPath === "ir" || record.compilerPathVerified === true) {
      throw new Error(IR_COMPILER_PATH_REASON);
    }
    if (requested !== undefined && path !== "unknown" && path !== requested) {
      throw new Error("Compiler path request contradicts result rows");
    }
    paths.add(path);
    const configuration = record.configuredCompilerPath ?? "unknown";
    if (!["legacy", "hybrid", "unknown"].includes(configuration)) {
      throw new Error(`Invalid configuredCompilerPath: ${configuration}`);
    }
    configurations.add(configuration);
  }
  const identity = (values) =>
    values.size === 1 ? values.values().next().value : values.size > 1 ? "mixed" : "unknown";
  return {
    compilerPath: identity(paths),
    compilerPathVerified: false,
    executionCompilerPath: "unknown",
    configuredCompilerPath: identity(configurations),
    ...(requested === undefined ? {} : { requestedCompilerPath: requested }),
  };
}

export function test262CacheDirectoryName(raw) {
  return parseTest262CompilerPath(raw) === "ir" ? ".test262-cache-ir" : ".test262-cache";
}
