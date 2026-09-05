// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";

const TARGET = "bench_string";

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function currentLoad() {
  const oneMinute = loadavg()[0];
  const logicalCores = cpus().length;
  if (!Number.isFinite(oneMinute) || oneMinute < 0) {
    throw Object.assign(new Error(`one-minute load must be finite and nonnegative, received ${oneMinute}`), {
      kind: "load-gate",
    });
  }
  if (!Number.isSafeInteger(logicalCores) || logicalCores < 3) {
    throw Object.assign(
      new Error(`logical core count must be a safe integer of at least three, received ${logicalCores}`),
      { kind: "load-gate" },
    );
  }
  const load = { oneMinute, logicalCores, threshold: logicalCores - 2 };
  if (oneMinute >= load.threshold) {
    throw Object.assign(
      new Error(
        `one-minute load ${oneMinute.toFixed(2)} must be strictly below ${load.threshold} ` +
          `(logical cores ${logicalCores} minus two)`,
      ),
      { kind: "load-gate", load },
    );
  }
  return load;
}

function rejectingImports(module) {
  const imports = Object.create(null);
  for (const descriptor of WebAssembly.Module.imports(module)) {
    if (descriptor.kind !== "function") {
      throw new Error(
        `benchmark worker accepts only function imports; received ${descriptor.kind} ` +
          `${descriptor.module}.${descriptor.name}`,
      );
    }
    const namespace = (imports[descriptor.module] ??= Object.create(null));
    namespace[descriptor.name] = () => {
      throw new Error(`benchmark unexpectedly called host import ${descriptor.module}.${descriptor.name}`);
    };
  }
  return imports;
}

function run(manifestPath, calls, warmupCalls) {
  const load = currentLoad();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const binary = Uint8Array.from(readFileSync(manifest.binaryPath));
  const sha256 = createHash("sha256").update(binary).digest("hex");
  if (binary.length !== manifest.binaryBytes || sha256 !== manifest.sha256) {
    throw new Error(`${manifest.lane} artifact identity mismatch`);
  }
  const module = new WebAssembly.Module(binary);
  const instance = new WebAssembly.Instance(module, rejectingImports(module));
  const bench = instance.exports[TARGET];
  if (typeof bench !== "function") throw new Error(`${TARGET} export is missing`);

  for (let index = 0; index < warmupCalls; index++) {
    if (bench() !== 5_000) throw new Error(`${manifest.lane} warmup checksum failed`);
  }
  if (typeof globalThis.gc !== "function") throw new Error("worker requires --expose-gc");
  globalThis.gc();
  let checksum = 0;
  const started = process.hrtime.bigint();
  for (let index = 0; index < calls; index++) checksum += Number(bench());
  const elapsed = process.hrtime.bigint() - started;
  if (checksum !== calls * 5_000) throw new Error(`${manifest.lane} measured checksum failed: ${checksum}`);
  const nsPerCall = Number(elapsed) / calls;
  if (!Number.isFinite(nsPerCall) || nsPerCall <= 0) throw new Error(`${manifest.lane} nsPerCall must be positive`);
  const memory = process.memoryUsage();
  return {
    lane: manifest.lane,
    nsPerCall,
    calls,
    warmupCalls,
    checksum,
    load,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
  };
}

const manifestPath = process.argv[2];
const calls = Number(process.argv[3]);
const warmupCalls = Number(process.argv[4]);
try {
  if (!manifestPath) throw new Error("worker manifest path is required");
  positiveInteger(calls, "worker calls");
  positiveInteger(warmupCalls, "worker warmup calls");
  console.log(JSON.stringify({ ok: true, result: run(manifestPath, calls, warmupCalls) }));
} catch (error) {
  const kind = error?.kind === "load-gate" ? "load-gate" : "worker";
  console.log(
    JSON.stringify({
      ok: false,
      error: {
        kind,
        message: error instanceof Error ? error.message : String(error),
        ...(error?.load ? { load: error.load } : {}),
      },
    }),
  );
  process.exitCode = kind === "load-gate" ? 75 : 1;
}
