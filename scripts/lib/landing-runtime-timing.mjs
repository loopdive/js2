// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { spawnSync } from "node:child_process";

import { landingWasmtimeRunArgs } from "./landing-wasmtime-runtime.mjs";

export function landingAuxiliaryRuntimeSource(source, arg, iterations = 1) {
  if (typeof source !== "string" || !source) throw new Error("auxiliary source must be non-empty");
  if (!Number.isFinite(arg)) throw new Error("auxiliary runtime argument must be finite");
  if (!Number.isSafeInteger(iterations) || iterations <= 0) {
    throw new Error("auxiliary batch iterations must be a positive safe integer");
  }
  const programBody = source
    .replace(/export const benchmark[\s\S]*?};\n/, "")
    .replace(/\bexport\s+function\s+run\b/, "function __benchRun");
  if (!programBody.includes("function __benchRun")) {
    throw new Error("unable to rewrite exported run() for auxiliary runtime wrapper");
  }
  const invocation = `__benchSink = (__benchSink + (__benchRun(${arg}) | 0)) | 0;`;
  const runBody =
    iterations === 1
      ? `  ${invocation}`
      : `  for (let __benchIteration = 0; __benchIteration < ${iterations}; __benchIteration++) {
    ${invocation}
  }`;
  return `${programBody}
let __benchSink = 0;
export function run() {
${runBody}
}
`;
}

export function normalizeBatchedRuntimeSamples(samplesMs, iterations) {
  if (!Array.isArray(samplesMs) || samplesMs.length === 0) {
    throw new Error("batched runtime samples must be a non-empty array");
  }
  if (!Number.isSafeInteger(iterations) || iterations <= 0) {
    throw new Error("batch iterations must be a positive safe integer");
  }
  if (samplesMs.some((sample) => typeof sample !== "number" || !Number.isFinite(sample) || sample <= 0)) {
    throw new Error("batched runtime samples must contain positive finite numbers");
  }
  return samplesMs.map((sample) => sample / iterations);
}

export function landingVmScriptSource(sourcePath) {
  const source = readFileSync(sourcePath, "utf8");
  const programBody = source
    .replace(/export const benchmark[\s\S]*?};\n/, "")
    .replace(/\bexport\s+function\s+run\b/, "function run");
  return `${programBody}\nrun(globalThis.__runtimeArg__);\n`;
}

/** Existing #1764 warm-V8 / fresh-context+compile cold methodology. */
export function landingNodeVmFreshCompileSample(sourcePath, arg) {
  const scriptSource = landingVmScriptSource(sourcePath);
  const started = performance.now();
  const context = createContext({ __runtimeArg__: arg });
  const script = new Script(scriptSource, { filename: sourcePath });
  const output = script.runInContext(context);
  return { wallMs: performance.now() - started, output };
}

/** Existing #1760 warmed-V8 child methodology. */
export function landingNodeWarmSample(childPath, sourcePath, arg) {
  const command = [process.execPath, childPath, "--mode=warm", sourcePath, String(arg)];
  const result = spawnSync(command[0], command.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Node warm child failed (exit ${result.status}): ${(result.stderr ?? "").slice(0, 800)}`);
  }
  const parsed = JSON.parse(lastLine(result.stdout));
  if (
    typeof parsed?.medianMs !== "number" ||
    parsed.medianMs <= 0 ||
    !Array.isArray(parsed.samplesMs) ||
    parsed.samplesMs.some((sample) => typeof sample !== "number" || sample <= 0)
  ) {
    throw new Error(`Node warm child returned invalid samples: ${JSON.stringify(parsed)}`);
  }
  return { ...parsed, command };
}

/** Existing #1764 warm-engine / fresh-store+instance Wasmtime methodology. */
export function landingWasmtimeFreshInstanceSamples(hostPath, wasmPath, arg, runs, options = {}) {
  return landingWasmtimeHostSamples(hostPath, wasmPath, arg, runs, options);
}

function landingWasmtimeHostSamples(hostPath, wasmPath, arg, runs, options) {
  const args = [];
  if (options.component) args.push("--component");
  for (const preload of options.preloads ?? []) args.push("--preload", `${preload.name}=${preload.path}`);
  args.push(wasmPath, String(arg), String(runs));
  const command = [hostPath, ...args];
  const result = spawnSync(command[0], command.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Wasmtime benchmark host failed (exit ${result.status}): ${(result.stderr ?? "").slice(0, 800)}`);
  }
  const parsed = parseLandingWasmtimeColdHostOutput(result.stdout, runs);
  return { ...parsed, command };
}

export function parseLandingWasmtimeColdHostOutput(stdout, runs) {
  const parsed = JSON.parse(lastLine(stdout));
  if (
    !Array.isArray(parsed?.samplesMs) ||
    parsed.samplesMs.length !== runs ||
    parsed.samplesMs.some((sample) => typeof sample !== "number" || sample <= 0) ||
    !Array.isArray(parsed.outputs) ||
    parsed.outputs.length !== runs ||
    parsed.outputs.some((output) => output !== null && (typeof output !== "number" || !Number.isFinite(output)))
  ) {
    throw new Error(
      `Wasmtime cold host did not return ${runs} positive samples and outputs: ${JSON.stringify(parsed)}`,
    );
  }
  return { samplesMs: parsed.samplesMs, outputs: parsed.outputs };
}

/** Existing #1760 appended in-module warm-driver methodology. */
export function landingWasmtimeWarmSample(cwasmPath, arg) {
  const args = landingWasmtimeRunArgs(cwasmPath, "warm", arg);
  const command = ["wasmtime", ...args];
  const result = spawnSync(command[0], command.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Wasmtime warm failed (exit ${result.status}): ${(result.stderr ?? "").slice(0, 800)}`);
  }
  const perCallMs = Number(lastLine(result.stdout));
  if (!Number.isFinite(perCallMs) || perCallMs <= 0) {
    throw new Error(`Wasmtime warm did not return a positive per-call time: ${JSON.stringify(result.stdout)}`);
  }
  return { perCallMs, command };
}

function lastLine(value) {
  const line = String(value).trim().split("\n").filter(Boolean).at(-1);
  if (!line) throw new Error("timing command produced no output");
  return line;
}
