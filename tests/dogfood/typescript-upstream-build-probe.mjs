import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_HEAP_MB = 4_096;

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
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

async function runMain() {
  const root = resolve(optionValue("--root") ?? "");
  const mode = optionValue("--mode") ?? "source";
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
    workerData: { entry, mode, consumerDrivenBarrels, invokeExport, invokeString, expectedNumber },
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
    entryOverride,
    entry,
    startedAt,
    elapsedMs,
    timeoutMs,
    heapLimitMiB: heapMb,
    consumerDrivenBarrels,
    invokeExport,
    expectedNumber,
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
  process.exitCode = finalMessage?.type === "result" && finalMessage.success ? 0 : timedOut ? 124 : 1;
}

await runMain();
