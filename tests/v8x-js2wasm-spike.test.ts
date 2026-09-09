// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const compiler = join(root, "examples/v8x-js2wasm-spike/compile-graph.ts");
const denoWrapper = join(root, "examples/v8x-js2wasm-spike/deno.ts");
const wasmtime = process.env.WASMTIME ?? "wasmtime";

async function writeContext(contextPath: string): Promise<void> {
  // compile-graph imports both the realm and its shared Symbol state.
  const context = await compile(
    `
      const realm: any = globalThis;
      export function __v8x_context_global_this(): any { return realm; }
      export function __v8x_context_call(callable: any, receiver: any, args: any): any {
        if (args.length === 0) return callable.call(receiver);
        if (args.length === 1) return callable.call(receiver, args[0]);
        throw new RangeError("test context supports at most one argument");
      }
    `,
    { target: "standalone", hostBridge: "always", standaloneSymbolState: "export" },
  );
  expect(context.success, context.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.Module.imports(new WebAssembly.Module(context.binary))).toEqual([]);
  writeFileSync(contextPath, context.binary);
}

describe("v8x js2wasm module-backend spike", () => {
  it("executes an externref-returning trampoline in Wasmtime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v8x-js2wasm-externref-tail-"));
    const mainPath = join(dir, "main.ts");
    const manifestPath = join(dir, "modules.tsv");
    const wasmPath = join(dir, "module.wasm");
    const contextPath = join(dir, "context.wasm");
    await writeContext(contextPath);
    writeFileSync(
      mainPath,
      `function makeObject(depth: number): any {\n` +
        `  if (depth <= 0) return { value: 42 };\n` +
        `  return makeObject(depth - 1);\n` +
        `}\n` +
        `function objectTrampoline(depth: number): any { return makeObject(depth); }\n` +
        `if (objectTrampoline(1).value !== 42) throw new Error("externref tail result corrupted");\n`,
    );
    writeFileSync(manifestPath, `${pathToFileURL(mainPath)}\t${mainPath}\n`);

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

    const evaluated = spawnSync(
      wasmtime,
      [
        "run",
        "-W",
        "gc=y,function-references=y,tail-call=y,exceptions=y",
        "--preload",
        `v8x:context=${contextPath}`,
        "--invoke",
        "__module_init",
        wasmPath,
      ],
      { encoding: "utf8" },
    );
    if (evaluated.error && "code" in evaluated.error && evaluated.error.code === "ENOENT") return;
    expect(evaluated.status, evaluated.stderr).toBe(0);
  }, 30_000);

  it.each([42, 43])(
    "executes a linked TypeScript graph with a shared context and expected answer %s",
    async (expectedAnswer) => {
      const dir = mkdtempSync(join(tmpdir(), "v8x-js2wasm-"));
      const mainPath = join(dir, "main.ts");
      const mathPath = join(dir, "math.ts");
      const bootstrapPath = join(dir, "bootstrap.js");
      const manifestPath = join(dir, "modules.tsv");
      const wasmPath = join(dir, "module.wasm");
      const contextPath = join(dir, "context.wasm");
      await writeContext(contextPath);

      // compile-graph defers source execution to __module_init and imports the
      // context owned by v8x. Supply the same Wasm context ABI to the CLI and
      // explicitly invoke initialization. The 43 case proves the assertion ran.

      writeFileSync(mathPath, `export function add(left: number, right: number): number { return left + right; }\n`);
      writeFileSync(bootstrapPath, `globalThis.__v8xBootstrapValue = 21;\n`);
      writeFileSync(
        mainPath,
        `import "./bootstrap.js";\n` +
          `import { add } from "./math.ts";\n` +
          `const answer: number = add((globalThis as any).__v8xBootstrapValue, 21);\n` +
          `if (answer !== ${expectedAnswer}) throw new Error("wrong result");\n`,
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
        [
          "run",
          "-W",
          "gc=y,function-references=y,tail-call=y,exceptions=y",
          "--preload",
          `v8x:context=${contextPath}`,
          "--invoke",
          "__module_init",
          wasmPath,
        ],
        { encoding: "utf8" },
      );
      if (evaluated.error && "code" in evaluated.error && evaluated.error.code === "ENOENT") return;
      if (expectedAnswer === 42) expect(evaluated.status, evaluated.stderr).toBe(0);
      else {
        expect(evaluated.status, evaluated.stderr).toBe(1);
        expect(evaluated.stderr).toContain("failed to invoke `__module_init`");
        expect(evaluated.stderr).toContain("thrown Wasm exception");
      }
    },
    30_000,
  );

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
      { kind: "global", module: "v8x:context", name: "__symbol_counter" },
      { kind: "global", module: "v8x:context", name: "__symbol_desc_table" },
      { kind: "global", module: "v8x:context", name: "__symbol_intern_table" },
      { kind: "global", module: "v8x:context", name: "__symbol_reg_keys" },
      { kind: "global", module: "v8x:context", name: "__symbol_reg_ids" },
      { kind: "global", module: "v8x:context", name: "__symbol_reg_count" },
      { kind: "function", module: "v8x:deno", name: "__v8x_op_cwd_utf16_length" },
      { kind: "function", module: "v8x:deno", name: "__v8x_op_cwd_utf16_code_unit" },
    ]);
  }, 30_000);
});
