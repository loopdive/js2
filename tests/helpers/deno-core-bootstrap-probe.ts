// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileMulti } from "../../src/index.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/deno-core-0.407.0");

const upstreamFiles = [
  ["00_primordials.js", "5a2dfbdc4bb81412575d035901a11788001c7e0110e3f736d16289891af44a52"],
  ["00_infra.js", "33984000be930f3b02a2d1149ac0319724e8d95891623c8cc74699da4ce97287"],
  ["01_core.js", "6e67972322cc5385a2b642a4f7e941fccb6f992c9de662a5111d11fd0aaf1a3a"],
] as const;

const runtimeSeed = `
  const extrasBinding = {
    getContinuationPreservedEmbedderData() { return undefined; },
    setContinuationPreservedEmbedderData(_value: any) {},
  };
  const importMetaPrototype: any = {};
  const ops: any = {
    op_get_extras_binding_object() {
      return extrasBinding;
    },
    op_get_ext_import_meta_proto() {
      return importMetaPrototype;
    },
    op_set_captured_bootstrap(bootstrap: any) {
      (globalThis as any).__capturedBootstrap = bootstrap;
    },
  };
  const core: any = {
    ops,
    callConsole(_v8Method: any, denoMethod: any, ...args: any[]) {
      return denoMethod(...args);
    },
  };
  const noTimer = () => {};
  (globalThis as any).Deno = { core };
  (globalThis as any).__timers = {
    createTimer: noTimer,
    cancelTimer: noTimer,
    refreshTimer: noTimer,
    refTimer: noTimer,
    unrefTimer: noTimer,
    setRunNextTicks: noTimer,
    setReportException: noTimer,
    processTimers: noTimer,
  };
`;

const entrySource = `
  import "./runtime-seed.ts";
  import "./00_primordials.js";
  import "./00_infra.js";
  import "./01_core.js";

  export function __v8x_probe_deno_core_bootstrap(): number {
    const global: any = globalThis;
    const bootstrap: any = global.__bootstrap;
    if (bootstrap == null) return 0;
    const core: any = bootstrap.core;
    const captured: any = global.__capturedBootstrap;
    return core != null &&
      global.Deno.core === core &&
      typeof core.queueNextTick === "function" &&
      typeof core.setAsyncHooksEmit === "function" &&
      typeof core.registerErrorClass === "function" &&
      typeof global.queueMicrotask === "function" &&
      bootstrap.internals != null &&
      captured != null &&
      typeof captured.core.queueNextTick === "function" &&
      captured.internals === bootstrap.internals ? 42 : 0;
  }
`;

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

const files: Record<string, string> = {
  "/deno-bootstrap/entry.ts": entrySource,
  "/deno-bootstrap/runtime-seed.ts": runtimeSeed,
};
const hashes: Record<string, string> = {};
for (const [fileName, expectedHash] of upstreamFiles) {
  const source = readFileSync(join(fixtureDir, fileName), "utf8");
  const actualHash = sha256(source);
  if (actualHash !== expectedHash) {
    throw new Error(`${fileName} changed: expected ${expectedHash}, received ${actualHash}`);
  }
  hashes[fileName] = actualHash;
  files[`/deno-bootstrap/${fileName}`] = source;
}

const result = await compileMulti(files, "/deno-bootstrap/entry.ts", {
  target: "standalone",
  platform: "deno",
  allowJs: true,
  skipSemanticDiagnostics: true,
  deferTopLevelInit: true,
});
if (!result.success) {
  throw new Error(result.errors.map((error) => error.message).join("\n"));
}

const module = new WebAssembly.Module(result.binary);
const artifactOutput = process.env.DENO_CORE_BOOTSTRAP_WASM_OUTPUT;
if (artifactOutput) writeFileSync(artifactOutput, result.binary);
const moduleImports = WebAssembly.Module.imports(module);
const imports = moduleImports.map(({ module, name }) => `${module}::${name}`).sort();
const calls: string[] = [];
const probes: number[] = [];
for (let instanceIndex = 0; instanceIndex < 2; instanceIndex++) {
  const importObject: Record<string, Record<string, Function>> = {};
  for (const descriptor of moduleImports) {
    importObject[descriptor.module] ??= {};
    importObject[descriptor.module]![descriptor.name] = () => {
      calls.push(`${descriptor.module}::${descriptor.name}`);
      throw new Error(`bootstrap called unresolved import ${descriptor.module}::${descriptor.name}`);
    };
  }
  const instance = await WebAssembly.instantiate(module, importObject);
  (instance.exports.__module_init as () => void)();
  probes.push((instance.exports.__v8x_probe_deno_core_bootstrap as () => number)());
}

process.stdout.write(`${JSON.stringify({ bytes: result.binary.byteLength, calls, hashes, imports, probes })}\n`);
