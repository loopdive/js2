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
const wasmtime = process.env.WASMTIME ?? "wasmtime";

describe("v8x js2wasm module-backend spike", () => {
  it("compiles an untouched multi-file TypeScript graph and evaluates it in Wasmtime", () => {
    const dir = mkdtempSync(join(tmpdir(), "v8x-js2wasm-"));
    const mainPath = join(dir, "main.ts");
    const mathPath = join(dir, "math.ts");
    const manifestPath = join(dir, "modules.tsv");
    const wasmPath = join(dir, "module.wasm");

    writeFileSync(mathPath, `export function add(left: number, right: number): number { return left + right; }\n`);
    writeFileSync(
      mainPath,
      `import { add } from "./math.ts";\nconst answer: number = add(20, 22);\nif (answer !== 42) throw new Error("wrong result");\n`,
    );
    writeFileSync(manifestPath, `${pathToFileURL(mainPath)}\t${mainPath}\n${pathToFileURL(mathPath)}\t${mathPath}\n`);

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
    expect(JSON.parse(compiled.stdout)).toMatchObject({ modules: 2 });
    expect(readFileSync(wasmPath).byteLength).toBeGreaterThan(8);

    const evaluated = spawnSync(
      wasmtime,
      ["run", "-W", "gc=y,function-references=y,tail-call=y,exceptions=y", wasmPath],
      { encoding: "utf8" },
    );
    if (evaluated.error && "code" in evaluated.error && evaluated.error.code === "ENOENT") return;
    expect(evaluated.status, evaluated.stderr).toBe(0);
  }, 30_000);
});
