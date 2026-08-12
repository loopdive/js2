// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const compiler = join(root, "examples/v8x-js2wasm-spike/compile-graph.ts");
const denoWrapper = join(root, "examples/v8x-js2wasm-spike/deno.ts");
const wasmtime = process.env.WASMTIME ?? "wasmtime";

describe("v8x js2wasm module-backend spike", () => {
  it("compiles an untouched multi-file TypeScript graph and evaluates it in Wasmtime", () => {
    const dir = mkdtempSync(join(tmpdir(), "v8x-js2wasm-"));
    const mainPath = join(dir, "main.ts");
    const mathPath = join(dir, "math.ts");
    const bootstrapPath = join(dir, "bootstrap.js");
    const manifestPath = join(dir, "modules.tsv");
    const wasmPath = join(dir, "module.wasm");

    writeFileSync(mathPath, `export function add(left: number, right: number): number { return left + right; }\n`);
    writeFileSync(bootstrapPath, `globalThis.__v8xBootstrapValue = 21;\n`);
    writeFileSync(
      mainPath,
      `import "./bootstrap.js";\n` +
        `import { add } from "./math.ts";\n` +
        `const answer: number = add((globalThis as any).__v8xBootstrapValue, 21);\n` +
        `if (answer !== 42) throw new Error("wrong result");\n`,
    );
    writeFileSync(
      manifestPath,
      `${pathToFileURL(mainPath)}\t${mainPath}\n` +
        `${pathToFileURL(mathPath)}\t${mathPath}\n` +
        `${pathToFileURL(bootstrapPath)}\t${bootstrapPath}\n`,
    );

    const compiled = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        compiler,
        "--manifest",
        manifestPath,
        "--entry",
        pathToFileURL(mainPath).href,
        "--output",
        wasmPath,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(compiled.status, compiled.stderr).toBe(0);
    expect(JSON.parse(compiled.stdout)).toMatchObject({ modules: 3 });
    expect(readFileSync(wasmPath).byteLength).toBeGreaterThan(8);

    const evaluated = spawnSync(
      wasmtime,
      ["run", "-W", "gc=y,function-references=y,tail-call=y,exceptions=y", wasmPath],
      { encoding: "utf8" },
    );
    if (evaluated.error && "code" in evaluated.error && evaluated.error.code === "ENOENT") return;
    expect(evaluated.status, evaluated.stderr).toBe(0);
  }, 30_000);

  it("compiles Deno.cwd() to the explicit typed host-op seam", () => {
    const dir = mkdtempSync(join(tmpdir(), "v8x-js2wasm-deno-"));
    const mainPath = join(dir, "main.ts");
    const denoPath = join(dir, "deno.ts");
    const manifestPath = join(dir, "modules.tsv");
    const wasmPath = join(dir, "module.wasm");

    writeFileSync(denoPath, readFileSync(denoWrapper));
    writeFileSync(
      mainPath,
      `import { Deno } from "./deno.ts";\n` +
        `export function __v8x_probe_cwd_utf16_length(): number { return Deno.cwd().length; }\n` +
        `export function __v8x_probe_cwd_utf16_checksum(): number {\n` +
        `  const value = Deno.cwd();\n` +
        `  let checksum = 0;\n` +
        `  for (let index = 0; index < value.length; index++) checksum += (index + 1) * value.charCodeAt(index);\n` +
        `  return checksum;\n` +
        `}\n`,
    );
    writeFileSync(manifestPath, `${pathToFileURL(mainPath)}\t${mainPath}\n${pathToFileURL(denoPath)}\t${denoPath}\n`);

    const compiled = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        compiler,
        "--manifest",
        manifestPath,
        "--entry",
        pathToFileURL(mainPath).href,
        "--output",
        wasmPath,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(compiled.status, compiled.stderr).toBe(0);

    const module = new WebAssembly.Module(readFileSync(wasmPath));
    expect(WebAssembly.Module.imports(module)).toEqual([
      { kind: "function", module: "v8x:deno", name: "__v8x_op_cwd_utf16_length" },
      { kind: "function", module: "v8x:deno", name: "__v8x_op_cwd_utf16_code_unit" },
    ]);
  }, 30_000);
});
