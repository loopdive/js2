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
  return parseTest262CompilerPath(raw);
}

export function test262CompilerPathStatus(raw) {
  const compilerPath = parseTest262CompilerPath(raw);
  return {
    schema: "test262-compiler-path-status-v1",
    compilerPath,
    compilerPathVerified: false,
    executionCompilerPath: "unknown",
    state: "requested",
  };
}

export function test262RequestedCompilerPathMetadata(raw, target) {
  const compilerPath = requireTest262CompilerPath(raw);
  return {
    compilerPath,
    ...(compilerPath === "ir" ? { requestedCompilerPath: "ir" } : {}),
    compilerPathVerified: false,
    executionCompilerPath: "unknown",
    // This describes configuration, never proves which executable units ran.
    // Actual target-profile.ts maps only linear to Linear; WASI stays WasmGC.
    configuredCompilerPath:
      compilerPath === "ir"
        ? "ir"
        : target === "linear"
          ? "legacy"
          : target === undefined || ["gc", "wasi", "standalone"].includes(target)
            ? "hybrid"
            : "unknown",
  };
}

/** Serialized reports describe producer observations; this function cannot issue runtime ownership. */
export function summarizeTest262CompilerPaths(records, requested) {
  if (requested !== undefined) requireTest262CompilerPath(requested);
  const paths = new Set(),
    configurations = new Set();
  let attemptedCases = 0,
    skippedCases = 0,
    compileErrorCases = 0,
    compileTimeoutCases = 0,
    verifiedExecutionCases = 0,
    verifiedFrontendCases = 0;
  let infrastructure = false;
  for (const record of records) {
    const path = record.compilerPath ?? "unknown";
    const execution = record.executionCompilerPath ?? "unknown";
    if (!["legacy", "ir", "unknown"].includes(path)) throw new Error(`Invalid result compilerPath: ${path}`);
    if (!["legacy", "hybrid", "ir", "unknown"].includes(execution))
      throw new Error(`Invalid executionCompilerPath: ${execution}`);
    if (requested !== undefined && path !== "unknown" && path !== requested)
      throw new Error("Compiler path request contradicts result rows");
    const verified = record.compilerPathVerified === true;
    if (verified || execution === "ir") {
      const proof = record.preparedExecutionReport;
      if (
        path !== "ir" ||
        execution !== "ir" ||
        !verified ||
        !proof ||
        proof.schema !== "test262-prepared-execution-report-v1" ||
        !Number.isSafeInteger(proof.jobId) ||
        proof.jobId < 0 ||
        !Number.isSafeInteger(proof.workerPid) ||
        proof.workerPid <= 0 ||
        !Number.isSafeInteger(proof.emittedUnits) ||
        proof.emittedUnits <= 0 ||
        !Number.isSafeInteger(proof.binaryBytes) ||
        proof.binaryBytes <= 8 ||
        !/^[a-f0-9]{64}$/.test(proof.sourceSha256 ?? "")
      )
        throw new Error("Missing same-job Prepared execution report");
    }
    // Syntax/early rejection is conformance evidence for negative tests,
    // independently from constructing and executing a prepared Wasm program.
    if (record.frontendPathVerified === true) {
      const proof = record.preparedFrontendReport;
      if (
        path !== "ir" ||
        verified ||
        execution !== "unknown" ||
        record.status !== "pass" ||
        !proof ||
        proof.schema !== "test262-prepared-frontend-report-v1" ||
        proof.requestVersion !== 1 ||
        proof.errorType !== "SyntaxError" ||
        !["parse", "early"].includes(proof.expectedPhase) ||
        !(proof.expectedPhase === "parse" ? ["syntax", "early"].includes(proof.phase) : proof.phase === "early") ||
        !Number.isSafeInteger(proof.jobId) ||
        proof.jobId < 0 ||
        !Number.isSafeInteger(proof.workerPid) ||
        proof.workerPid <= 0 ||
        !/^[a-f0-9]{64}$/.test(proof.sourceSha256 ?? "") ||
        !Array.isArray(proof.sources) ||
        proof.sources.length === 0 ||
        !Array.isArray(proof.diagnostics) ||
        proof.diagnostics.length === 0
      )
        throw new Error("Missing distinct same-job Prepared frontend report");
      verifiedFrontendCases++;
    }
    paths.add(path);
    const configuration = record.configuredCompilerPath ?? "unknown";
    if (!["legacy", "hybrid", "ir", "unknown"].includes(configuration))
      throw new Error(`Invalid configuredCompilerPath: ${configuration}`);
    configurations.add(configuration);
    if (record.status === "skip") skippedCases++;
    else if (verified) verifiedExecutionCases++;
    if (record.status === "compile_error") compileErrorCases++;
    if (record.status === "compile_timeout") compileTimeoutCases++;
    const attempts = record.compilerAttempts ?? 0;
    if (!Number.isSafeInteger(attempts) || attempts < 0) throw new Error("Invalid compiler attempt count");
    attemptedCases += attempts;
    infrastructure ||=
      record.compilerPathFailureKind === "transport" || record.compilerPathFailureKind === "infrastructure";
  }
  const identity = (values) =>
    values.size === 1 ? values.values().next().value : values.size > 1 ? "mixed" : "unknown";
  const unverifiedExecutionCases = records.length - skippedCases - verifiedExecutionCases;
  const compilerPathVerified = verifiedExecutionCases > 0 && unverifiedExecutionCases === 0;
  return {
    compilerPath: identity(paths),
    compilerPathVerified,
    executionCompilerPath: compilerPathVerified ? "ir" : "unknown",
    configuredCompilerPath: identity(configurations),
    ...(requested === undefined ? {} : { requestedCompilerPath: requested }),
    measurementState: attemptedCases > 0 && !infrastructure ? "measured" : "unavailable",
    attemptedCases,
    completedCases: records.length,
    skippedCases,
    compileErrorCases,
    compileTimeoutCases,
    verifiedExecutionCases,
    verifiedFrontendCases,
    unverifiedExecutionCases,
  };
}

export function test262CacheDirectoryName(raw) {
  return parseTest262CompilerPath(raw) === "ir" ? ".test262-cache-ir" : ".test262-cache";
}
