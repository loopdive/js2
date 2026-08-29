import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { setupTypescriptUpstreamSuite } from "./setup-typescript-upstream-suite.mjs";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_HEAP_MB = 4_096;

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
  if (override) return resolve(root, override);
  if (mode === "source") return resolve(root, "src/typescript/typescript.ts");
  if (mode === "bundle") return resolve(root, "lib/typescript.js");
  throw new Error("--mode expects source or bundle");
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
  const jsonOnly = process.argv.includes("--json");
  if (!existsSync(entry)) throw new Error(`TypeScript ${mode} entry does not exist: ${entry}`);

  const startedAt = new Date().toISOString();
  const started = performance.now();
  const initialCpu = process.cpuUsage();
  let peakRssBytes = process.memoryUsage().rss;
  let lastProfileLine = null;
  let lastProfileAt = null;
  let finalMessage = null;
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
  process.exitCode = typescriptBuildProbeExitCode(finalMessage, invocationPlan.requirement, timedOut, workerExitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await runMain();
