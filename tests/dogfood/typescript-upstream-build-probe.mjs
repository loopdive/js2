import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { setupTypescriptUpstreamSuite } from "./setup-typescript-upstream-suite.mjs";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_HEAP_MB = 4_096;
const TYPESCRIPT_PROBE_ARTIFACT_FS = { existsSync, renameSync, rmSync, writeFileSync };

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
}

function optionValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index++) {
    if (process.argv[index] === name) values.push(process.argv[index + 1]);
  }
  if (values.some((value) => value === undefined)) throw new Error(`${name} requires a value`);
  return values;
}

function numericOption(name, fallback) {
  const raw = optionValue(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} expects a positive integer`);
  }
  return value;
}

function mib(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function entryFor(root, mode, override) {
  if (mode !== "source" && mode !== "bundle") throw new Error("--mode expects source or bundle");
  if (override) return resolve(root, override);
  if (mode === "source") return resolve(root, "src/typescript/typescript.ts");
  return resolve(root, "lib/typescript.js");
}

/**
 * Legacy --expected-number accepts any finite Number. Repeated --invoke-case
 * values carry packed parser fingerprints and therefore require safe integers.
 */
export function typescriptInvocationMatches(actual, expected, requireSafeInteger) {
  if (!Number.isFinite(actual) || !Number.isFinite(expected) || !Object.is(actual, expected)) return false;
  return !requireSafeInteger || (Number.isSafeInteger(actual) && Number.isSafeInteger(expected));
}

/**
 * A compile result is only an acceptance success when it emitted valid Wasm.
 * If the caller requested an exported runtime oracle, that invocation must
 * also have run and matched. Kept pure/exported so the CLI's exit contract has
 * a fast unit test instead of relying on a multi-minute TypeScript build.
 */
export function typescriptBuildProbeSucceeded(finalMessage, invocationRequirement) {
  if (
    finalMessage?.type !== "result" ||
    finalMessage.success !== true ||
    finalMessage.compileSuccess !== true ||
    finalMessage.validates !== true
  ) {
    return false;
  }

  const required =
    typeof invocationRequirement === "number" ? invocationRequirement : invocationRequirement === true ? 1 : 0;
  if (required === 0) return true;
  const records = Array.isArray(finalMessage.invocations)
    ? finalMessage.invocations
    : finalMessage.invocation
      ? [finalMessage.invocation]
      : [];
  if (records.length !== required) return false;
  const requireSafeIntegers = typeof invocationRequirement === "number";
  return records.every((record) => {
    return (
      record?.matches === true &&
      record.error === undefined &&
      typescriptInvocationMatches(record.actual, record.expected, requireSafeIntegers)
    );
  });
}

/**
 * Convert the worker lifecycle plus result verdict into the probe's CLI status.
 * A result message is not final authority by itself: the worker may post it and
 * then hang, crash, or exit nonzero while flushing follow-up work. Timeouts keep
 * their conventional 124 status; every other lifecycle failure exits 1.
 */
export function typescriptBuildProbeExitCode(finalMessage, invocationRequirement, timedOut, workerExitCode) {
  if (timedOut) return 124;
  if (workerExitCode !== 0) return 1;
  return typescriptBuildProbeSucceeded(finalMessage, invocationRequirement) ? 0 : 1;
}

/**
 * Keep the bounded JSON report useful when warnings precede the diagnostic
 * that actually prevented emission. Preserve relative order within both
 * groups, but never let the warning cap hide a non-warning tail failure.
 */
export function typescriptBuildProbeErrorSummary(errors, limit = 20) {
  const nonWarnings = [];
  const warnings = [];
  for (const error of errors) {
    const bucket = error.severity === "warning" ? warnings : nonWarnings;
    if (bucket.length < limit) bucket.push(error);
  }
  return [...nonWarnings, ...warnings].slice(0, limit).map(({ message, file, line, column, code, severity }) => ({
    message,
    file,
    line,
    column,
    code,
    severity,
  }));
}

/**
 * Remove the transferred diagnostic payload before retaining or rendering the
 * worker result. The candidate can be tens of MiB; it belongs only to the
 * parent-side publisher and must never be cloned into the JSON summary.
 */
export function takeTypescriptBuildProbeArtifactCandidate(message) {
  if (message?.type !== "result" || !("diagnosticArtifactCandidate" in message)) return null;
  const candidate = message.diagnosticArtifactCandidate;
  delete message.diagnosticArtifactCandidate;
  return candidate;
}

/**
 * Give each bounded TypeScript workload its own last-known-good diagnostic
 * artifact. Removing the conventional `-workload` suffix preserves the
 * parser probe's established /private/tmp filename while keeping binder and
 * later compiler slices separate. Generic source and bundle entries retain a
 * mode suffix so those two probes cannot overwrite each other.
 */
export function typescriptBuildProbeArtifactPath(entry, artifactDirectory = "/private/tmp", mode = null) {
  const entryName = basename(entry, extname(entry));
  const hasWorkloadSuffix = entryName.endsWith("-workload");
  const workloadName = entryName
    .replace(/-workload$/, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const modeName = String(mode ?? "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const artifactName = `${workloadName || "typescript"}${!hasWorkloadSuffix && modeName ? `-${modeName}` : ""}`;
  return join(artifactDirectory, `ts2wasm-${artifactName}-latest.wasm`);
}

/**
 * Publish only an already accepted probe result. Both outputs are staged next
 * to their destinations; the source map is installed first and the atomic
 * Wasm rename is the commit marker. A rejected probe does not touch an older
 * accepted artifact, and a synchronous staging failure leaves it intact.
 */
export function publishTypescriptBuildProbeArtifact(
  { artifactPath, binary, sourceMap, accepted },
  fileSystem = TYPESCRIPT_PROBE_ARTIFACT_FS,
) {
  const mapPath = `${artifactPath}.map`;
  if (!accepted) {
    return { artifactPath, mapPath, published: false, sourceMapPublished: false };
  }

  const token = `${process.pid}-${randomUUID()}`;
  const pendingBinaryPath = `${artifactPath}.${token}.tmp`;
  const pendingMapPath = `${mapPath}.${token}.tmp`;
  const previousMapPath = `${mapPath}.${token}.previous`;
  const hasSourceMap = typeof sourceMap === "string";
  let previousMapMoved = false;
  let nextMapInstalled = false;
  let binaryCommitted = false;
  const cleanupErrors = [];
  let publication;

  const removeTemporary = (path) => {
    try {
      fileSystem.rmSync(path, { force: true });
    } catch (error) {
      cleanupErrors.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
  };

  try {
    fileSystem.writeFileSync(pendingBinaryPath, binary);
    if (hasSourceMap) fileSystem.writeFileSync(pendingMapPath, sourceMap);

    if (fileSystem.existsSync(mapPath)) {
      fileSystem.renameSync(mapPath, previousMapPath);
      previousMapMoved = true;
    }
    if (hasSourceMap) {
      fileSystem.renameSync(pendingMapPath, mapPath);
      nextMapInstalled = true;
    }

    fileSystem.renameSync(pendingBinaryPath, artifactPath);
    binaryCommitted = true;
    publication = { artifactPath, mapPath, published: true, sourceMapPublished: hasSourceMap };
  } catch (error) {
    const rollbackErrors = [];
    let previousMapRestored = false;
    if (!binaryCommitted) {
      if (nextMapInstalled) {
        try {
          fileSystem.renameSync(mapPath, pendingMapPath);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
          try {
            fileSystem.rmSync(mapPath, { force: true });
          } catch (removalError) {
            rollbackErrors.push(removalError);
          }
        }
      }
      if (previousMapMoved) {
        if (fileSystem.existsSync(previousMapPath)) {
          try {
            fileSystem.renameSync(previousMapPath, mapPath);
            previousMapRestored = true;
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        } else {
          rollbackErrors.push(new Error(`Previous diagnostic source map disappeared from ${previousMapPath}`));
        }
      }
    }
    if (rollbackErrors.length > 0) {
      const recoveryDetail = previousMapMoved
        ? previousMapRestored
          ? "the previous map was restored despite the rollback error"
          : `the previous map remains recoverable at ${previousMapPath}`
        : "no previous map existed to restore";
      throw new AggregateError(
        [error, ...rollbackErrors],
        `TypeScript diagnostic artifact publication failed and map rollback reported errors; ${recoveryDetail}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    removeTemporary(pendingBinaryPath);
    removeTemporary(pendingMapPath);
    if (binaryCommitted) removeTemporary(previousMapPath);
  }

  if (cleanupErrors.length > 0) publication.cleanupErrors = cleanupErrors;
  return publication;
}

/**
 * The parent owns final publication because worker success is provisional
 * until the worker exits cleanly. A timeout or post-result nonzero exit must
 * preserve the previous accepted artifact.
 */
export function publishTypescriptBuildProbeArtifactAfterExit({
  artifactPath,
  binary,
  sourceMap,
  finalMessage,
  invocationRequirement,
  timedOut,
  workerExitCode,
}) {
  return publishTypescriptBuildProbeArtifact({
    artifactPath,
    binary,
    sourceMap,
    accepted: typescriptBuildProbeExitCode(finalMessage, invocationRequirement, timedOut, workerExitCode) === 0,
  });
}

function invocationCasesFor(root, invokeExport, invokeString, expectedNumberRaw, expectedNumber) {
  const specs = optionValues("--invoke-case");
  const requiredRaw = optionValue("--require-invocations");
  const required = requiredRaw === null ? null : numericOption("--require-invocations", 1);
  const hasLegacyInvocation = invokeString !== null || expectedNumberRaw !== null;

  if (specs.length > 0 && hasLegacyInvocation) {
    throw new Error("--invoke-case cannot be mixed with --invoke-string/--expected-number");
  }
  if ((specs.length > 0 || required !== null) && invokeExport === null) {
    throw new Error("--invoke-case/--require-invocations require --invoke-export");
  }
  if (specs.length === 0) {
    if (invokeExport !== null && expectedNumberRaw === null) {
      throw new Error("--invoke-export requires --expected-number so runtime execution has an oracle");
    }
    if (required !== null && required !== 1) {
      throw new Error("legacy --invoke-string mode can require exactly one invocation");
    }
    return {
      cases:
        invokeExport === null
          ? []
          : [{ name: "inline", input: invokeString, expected: expectedNumber, requireSafeInteger: false }],
      required: invokeExport === null ? 0 : 1,
      requirement: invokeExport !== null,
    };
  }
  if (required === null) throw new Error("repeated --invoke-case requires --require-invocations");
  if (specs.length !== required) {
    throw new Error(`--require-invocations ${required} does not match ${specs.length} --invoke-case values`);
  }

  const cases = specs.map((spec) => {
    const separator = spec.lastIndexOf("=");
    if (separator <= 0 || separator === spec.length - 1) {
      throw new Error("--invoke-case expects <path>=<safe-integer>");
    }
    const name = spec.slice(0, separator);
    const expected = Number(spec.slice(separator + 1));
    if (!Number.isSafeInteger(expected)) throw new Error(`--invoke-case expected value is not a safe integer: ${spec}`);
    const inputPath = resolve(root, name);
    if (!existsSync(inputPath)) throw new Error(`TypeScript parser input does not exist: ${inputPath}`);
    return { name, input: readFileSync(inputPath, "utf8"), expected, requireSafeInteger: true };
  });
  return { cases, required, requirement: required };
}

async function runMain() {
  const root = resolve(optionValue("--root") ?? "");
  const mode = optionValue("--mode") ?? "source";
  const preparePinnedTypescript = process.argv.includes("--prepare-pinned-typescript");
  const preparedSuite = preparePinnedTypescript ? setupTypescriptUpstreamSuite() : null;
  if (preparedSuite !== null && resolve(preparedSuite.root) !== root) {
    throw new Error(`--prepare-pinned-typescript requires --root ${resolve(preparedSuite.root)}; got ${root}`);
  }
  const entryOverride = optionValue("--entry");
  const entry = entryFor(root, mode, entryOverride);
  const timeoutMs = numericOption("--timeout-ms", DEFAULT_TIMEOUT_MS);
  const heartbeatMs = numericOption("--heartbeat-ms", DEFAULT_HEARTBEAT_MS);
  const heapMb = numericOption("--heap-mb", DEFAULT_HEAP_MB);
  const consumerDrivenBarrels = process.argv.includes("--consumer-driven-barrels");
  const invokeExport = optionValue("--invoke-export");
  const invokeString = optionValue("--invoke-string");
  const expectedNumberRaw = optionValue("--expected-number");
  const expectedNumber = expectedNumberRaw === null ? null : Number(expectedNumberRaw);
  if (expectedNumberRaw !== null && !Number.isFinite(expectedNumber)) {
    throw new Error("--expected-number expects a finite number");
  }
  const invocationPlan = invocationCasesFor(root, invokeExport, invokeString, expectedNumberRaw, expectedNumber);
  const diagnosticArtifactPath = typescriptBuildProbeArtifactPath(entry, "/private/tmp", mode);
  const diagnosticArtifactEnabled = process.env.JS2WASM_TYPESCRIPT_PROBE_DIAGNOSTIC === "1";
  const jsonOnly = process.argv.includes("--json");
  if (!existsSync(entry)) throw new Error(`TypeScript ${mode} entry does not exist: ${entry}`);

  const startedAt = new Date().toISOString();
  const started = performance.now();
  const initialCpu = process.cpuUsage();
  let peakRssBytes = process.memoryUsage().rss;
  let lastProfileLine = null;
  let lastProfileAt = null;
  let finalMessage = null;
  let diagnosticArtifactCandidate = null;
  let workerExitCode = null;
  let timedOut = false;
  const profileCounts = {};

  const worker = new Worker(new URL("./typescript-upstream-build-worker.mjs", import.meta.url), {
    workerData: {
      entry,
      mode,
      consumerDrivenBarrels,
      invokeExport,
      invocationCases: invocationPlan.cases,
      requiredInvocations: invocationPlan.required,
      diagnosticArtifactPath,
      diagnosticArtifactEnabled,
    },
    stderr: true,
    env: { ...process.env, JS2WASM_COMPILE_PROFILE: "stream" },
    resourceLimits: { maxOldGenerationSizeMb: heapMb },
  });

  worker.stderr.setEncoding("utf8");
  let stderrRemainder = "";
  worker.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    const lines = `${stderrRemainder}${chunk}`.split(/\r?\n/);
    stderrRemainder = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("[js2:profile]")) {
        lastProfileLine = line;
        lastProfileAt = performance.now();
      }
    }
  });
  worker.on("message", (message) => {
    if (message.type === "profile") {
      const lines = message.text.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        if (!line.startsWith("[js2:profile]")) continue;
        lastProfileLine = line;
        lastProfileAt = performance.now();
        const count = line.match(/^\[js2:profile\] count ([^=]+)=(\d+)$/);
        if (count) profileCounts[count[1]] = Number(count[2]);
      }
      return;
    }
    const candidate = takeTypescriptBuildProbeArtifactCandidate(message);
    if (candidate) diagnosticArtifactCandidate = candidate;
    finalMessage = message;
  });

  const heartbeat = () => {
    const now = performance.now();
    const memory = process.memoryUsage();
    peakRssBytes = Math.max(peakRssBytes, memory.rss);
    const cpu = process.cpuUsage(initialCpu);
    const cpuMs = (cpu.user + cpu.system) / 1_000;
    const elapsedMs = now - started;
    const sample = {
      type: "heartbeat",
      elapsedMs: Math.round(elapsedMs),
      cpuMs: Math.round(cpuMs),
      averageCpuCores: Math.round((cpuMs / elapsedMs) * 100) / 100,
      rssMiB: mib(memory.rss),
      peakRssMiB: mib(peakRssBytes),
      workerEventLoopUtilization: Math.round(worker.performance.eventLoopUtilization().utilization * 1_000) / 1_000,
      lastProfileLine,
      lastProfileAgeMs: lastProfileAt === null ? null : Math.round(now - lastProfileAt),
    };
    process.stderr.write(`[typescript-upstream-probe] ${JSON.stringify(sample)}\n`);
  };

  heartbeat();
  const heartbeatTimer = setInterval(heartbeat, heartbeatMs);
  const timeoutTimer = setTimeout(async () => {
    timedOut = true;
    await worker.terminate();
  }, timeoutMs);

  workerExitCode = await new Promise((resolveExit, reject) => {
    worker.once("error", reject);
    worker.once("exit", resolveExit);
  });
  clearInterval(heartbeatTimer);
  clearTimeout(timeoutTimer);
  heartbeat();

  const elapsedMs = Math.round(performance.now() - started);
  const cpu = process.cpuUsage(initialCpu);
  const cpuMs = Math.round((cpu.user + cpu.system) / 1_000);
  const buildExitCode = typescriptBuildProbeExitCode(
    finalMessage,
    invocationPlan.requirement,
    timedOut,
    workerExitCode,
  );
  let diagnosticArtifact = null;
  let artifactPublicationFailed = false;
  if (diagnosticArtifactEnabled) {
    try {
      diagnosticArtifact = publishTypescriptBuildProbeArtifactAfterExit({
        artifactPath: diagnosticArtifactPath,
        binary: diagnosticArtifactCandidate?.binary,
        sourceMap: diagnosticArtifactCandidate?.sourceMap,
        finalMessage,
        invocationRequirement: invocationPlan.requirement,
        timedOut,
        workerExitCode,
      });
    } catch (error) {
      artifactPublicationFailed = buildExitCode === 0;
      diagnosticArtifact = {
        artifactPath: diagnosticArtifactPath,
        mapPath: `${diagnosticArtifactPath}.map`,
        published: false,
        sourceMapPublished: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (finalMessage?.type === "result") finalMessage.diagnosticArtifact = diagnosticArtifact;
  }
  const summary = {
    mode,
    root,
    preparePinnedTypescript,
    generatedDiagnostics: preparedSuite?.generatedDiagnostics ?? null,
    entryOverride,
    entry,
    startedAt,
    elapsedMs,
    timeoutMs,
    heapLimitMiB: heapMb,
    consumerDrivenBarrels,
    invokeExport,
    expectedNumber,
    requiredInvocations: invocationPlan.required,
    invocationCases: invocationPlan.cases.map(({ name, input, expected }) => ({
      name,
      inputBytes: Buffer.byteLength(input, "utf8"),
      expected,
    })),
    diagnosticArtifactPath,
    diagnosticArtifactEnabled,
    diagnosticArtifact,
    timedOut,
    workerExitCode,
    cpuMs,
    averageCpuCores: Math.round((cpuMs / elapsedMs) * 100) / 100,
    peakRssMiB: mib(peakRssBytes),
    profileCounts,
    lastProfileLine,
    lastProfileAgeMs: lastProfileAt === null ? null : Math.round(performance.now() - lastProfileAt),
    result: finalMessage,
  };
  const rendered = JSON.stringify(summary);
  if (jsonOnly) process.stdout.write(`${rendered}\n`);
  else process.stdout.write(`[typescript-upstream-probe] ${rendered}\n`);
  process.exitCode = artifactPublicationFailed ? 1 : buildExitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await runMain();
