// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Independent initializer with acknowledged, parent-controlled filesystem barriers.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const config = JSON.parse(process.argv[2]);
if (config.sourceFile) config.polyfillSource = fs.readFileSync(config.sourceFile, "utf8");
const events = [];
const reads = [];
const consumed = [];
let stage;
let paused = false;
let injected = false;
let compiling = false;
const send = (value) => fs.writeSync(1, `${JSON.stringify(value)}\n`);
function barrier(label) {
  if (paused || config.barrier !== label) return;
  paused = true;
  send({ barrier: label, stage });
  process.stdin._handle.setBlocking(true);
  const byte = Buffer.alloc(1);
  if (fs.readSync(0, byte, 0, 1, null) !== 1) throw new Error("Barrier was not released");
}
function encodedError(error) {
  return {
    message: error?.message,
    code: error?.code,
    cause: error?.cause ? encodedError(error.cause) : undefined,
    errors: error?.errors?.map(encodedError),
  };
}
const module = await import(pathToFileURL(config.bundle).href);
const key = module.temporalProviderCacheKey(config);
const finalRoot = path.join(
  config.cacheDir,
  config.legacy ? `temporal-project-${key.slice(0, 16)}` : `temporal-project-v2-${key}`,
);
const adapter = new Proxy(fs, {
  get(target, property) {
    const original = target[property];
    if (typeof original !== "function") return original;
    return (...args) => {
      const file = typeof args[0] === "string" ? args[0] : "";
      const local = file.startsWith(config.cacheDir);
      if (local)
        events.push({ op: property, path: file, destination: property === "renameSync" ? args[1] : undefined });
      if (property === "renameSync") barrier("rename");
      if (
        property === "readFileSync" &&
        file.startsWith(finalRoot) &&
        (!config.compilerRead || compiling || new Error().stack?.includes("resolveAllImports"))
      ) {
        barrier(`read:${path.basename(file)}`);
      }
      const fault = config.fault;
      if (
        fault &&
        property === fault.op &&
        (!fault.where || file.includes(fault.where)) &&
        (!injected || property === "rmSync")
      ) {
        injected = true;
        throw Object.assign(new Error(`injected ${property}`), { code: fault.code ?? "EACCES" });
      }
      if (property === "rmSync" && config.cleanupFailure) {
        throw Object.assign(new Error("injected cleanup"), { code: "EACCES" });
      }
      const result = original.apply(target, args);
      if (property === "mkdtempSync") stage = result;
      if (property === "readFileSync" && (file.startsWith(finalRoot) || file.includes(".staging-")))
        reads.push({ path: file, hex: Buffer.from(result).toString("hex") });
      if (property === "writeFileSync" && file.includes(".staging-")) {
        if (config.abandonStage) {
          send({ ok: false, abandoned: true, stage, consumed, events, finalRoot });
          process.exit(0); // Simulate death: no stack unwinding or materializer cleanup.
        }
        barrier(`write:${path.basename(file)}`);
      }
      return result;
    };
  },
});
module.setDefaultEnvironment({ ...module.getDefaultEnvironment(), fs: adapter });
globalThis.__issue5382Compile = async (entry, options) => {
  compiling = true;
  const root = path.dirname(entry);
  const files = Object.fromEntries(
    [
      "__js2wasm_temporal_entry.js",
      "node_modules/@js-temporal/polyfill/package.json",
      "node_modules/@js-temporal/polyfill/index.js",
    ].map((relative) => [relative, adapter.readFileSync(path.join(root, relative)).toString("hex")]),
  );
  consumed.push({ entry, files, options });
  if (config.compileFailure) throw new Error("injected compile failure");
  return {
    success: true,
    linkPlan: { mode: "separate" },
    linkedModules: [
      {
        packageName: "@js-temporal/polyfill",
        namespace: "test:provider",
        cacheHit: false,
        exportBoundaries: { Temporal: { kind: "getter", field: "getTemporal" } },
      },
    ],
  };
};
try {
  if (config.retryCompile) {
    config.compileFailure = true;
    try {
      await module.buildTemporalProvider(config);
      throw new Error("Expected first compile to fail");
    } catch (error) {
      if (error.message !== "injected compile failure") throw error;
    }
    config.compileFailure = false;
  }
  const provider = await module.buildTemporalProvider(config);
  if (config.real) {
    const artifact = provider.artifact;
    const binary = Buffer.from(artifact.binary);
    const wasm = new WebAssembly.Module(binary);
    const exports = WebAssembly.Module.exports(wasm).map((item) => item.name);
    if (!binary.length || !exports.includes(provider.getterField))
      throw new Error("Real provider getter missing from binary");
    send({
      ok: true,
      key,
      finalRoot,
      stage,
      events,
      reads,
      paused,
      provider: {
        cacheHit: provider.cacheHit,
        namespace: provider.namespace,
        getterField: provider.getterField,
        cacheKey: artifact.cacheKey,
        exportBoundaries: artifact.exportBoundaries,
        bytes: binary.length,
        sha256: createHash("sha256").update(binary).digest("hex"),
        exports,
      },
    });
    process.exit(0);
  }
  const count = events.length;
  const memory = config.memory ? await module.buildTemporalProvider(config) : undefined;
  send({
    ok: true,
    provider,
    memory,
    memoryEvents: events.length - count,
    finalRoot,
    stage,
    events,
    reads,
    consumed,
    paused,
  });
} catch (error) {
  send({ ok: false, error: encodedError(error), finalRoot, stage, events, reads, consumed, paused });
}
