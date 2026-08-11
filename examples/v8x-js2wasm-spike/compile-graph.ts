// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Experimental compiler sidecar for the v8x js2wasm module-backend spike.
// v8x passes canonical module names plus untouched source files. This process
// keeps the TypeScript graph intact and emits one standalone WasmGC module.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileMulti } from "../../src/index.ts";

interface Options {
  entry: string;
  manifest: string;
  output: string;
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("usage: compile-graph.ts --manifest FILE --entry URL --output FILE");
    }
    values.set(key.slice(2), value);
  }
  const manifest = values.get("manifest");
  const entry = values.get("entry");
  const output = values.get("output");
  if (!manifest || !entry || !output) {
    throw new Error("usage: compile-graph.ts --manifest FILE --entry URL --output FILE");
  }
  return { manifest, entry, output };
}

function compilerPath(specifier: string): string {
  if (specifier.startsWith("file:")) return fileURLToPath(specifier);
  if (specifier.startsWith("/")) return specifier;
  throw new Error(`the spike currently supports file: module graphs only: ${specifier}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const files: Record<string, string> = {};

  for (const line of readFileSync(options.manifest, "utf8").split("\n")) {
    if (!line) continue;
    const separator = line.indexOf("\t");
    if (separator < 1) throw new Error(`invalid manifest row: ${line}`);
    const specifier = line.slice(0, separator);
    const sourcePath = line.slice(separator + 1);
    files[compilerPath(specifier)] = readFileSync(sourcePath, "utf8");
  }

  const entry = compilerPath(options.entry);
  const result = await compileMulti(files, entry, {
    target: "standalone",
    platform: "deno",
    emitWat: false,
    moduleName: "v8x-js2wasm-spike",
  });
  if (!result.success) {
    const diagnostics = result.diagnostics
      .map(
        (diagnostic) =>
          `${diagnostic.file ?? entry}:${diagnostic.line ?? 0}:${diagnostic.column ?? 0} ${diagnostic.message}`,
      )
      .join("\n");
    throw new Error(diagnostics || "js2wasm compilation failed without diagnostics");
  }

  writeFileSync(options.output, result.binary);
  process.stdout.write(`${JSON.stringify({ bytes: result.binary.byteLength, modules: Object.keys(files).length })}\n`);
}

await main();
