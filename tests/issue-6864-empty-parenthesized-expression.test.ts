// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compile, compileMulti, compileFiles, type CompileResult } from "../src/index.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { runPreparedIrPipelinePresentation } from "../src/compiler.js";
import { detectEarlyErrors } from "../src/compiler/early-errors/index.js";
import * as gcCodegen from "../src/codegen/index.js";
import * as linearCodegen from "../src/codegen-linear/index.js";

const BROKEN = "export function broken(value: number): number {\n  return (;\n}\n";
const VALID_ARROW =
  "function empty():number{return 23;} export function calculate(value:number):number{const arrow=():number=>2;return (value)+(empty())+arrow();} export function finish():void{return;}";
const TARGETS = ["gc", "linear"] as const;
const MAPS = [false, true] as const;
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function noArtifacts(result: Pick<CompileResult, "binary" | "wat" | "dts" | "importsHelper" | "sourceMap">): void {
  expect(result.binary.byteLength).toBe(0);
  expect(result.wat).toBe("");
  expect(result.dts).toBe("");
  expect(result.importsHelper).toBe("");
  expect(result.sourceMap).toBeUndefined();
}
function missingExpression(result: CompileResult, expectedFile: string): void {
  expect(result.success).toBe(false);
  noArtifacts(result);
  const error = result.errors.find((e) => e.severity === "error" && /parenthesized expression/i.test(e.message));
  expect(error).toBeDefined();
  expect(error!.line).toBe(2);
  expect(error!.column).toBe(10);
  expect(error!.file).toBe(expectedFile);
}
function privateInput(source: string, target: "gc" | "linear", sourceMap: boolean) {
  const ast = analyzeMultiSource({ "./failed.ts": source }, "./failed.ts");
  return {
    userSourceFiles: ast.sourceFiles,
    entryAst: {
      sourceFile: ast.entryFile,
      checker: ast.checker,
      program: ast.program,
      diagnostics: ast.diagnostics,
      syntacticDiagnostics: ast.syntacticDiagnostics,
    },
    multiAst: ast,
    errors: [],
    codegenOptions: { link: [], sourceMap },
    sourcesContent: new Map(ast.sourceFiles.map((f) => [f.fileName, f.text])),
    diagnosticAnchor: ast.entryFile,
    options: { target, sourceMap, optimize: false, moduleName: "failed.ts" },
  };
}
async function execute(result: CompileResult, name: string, ...args: number[]): Promise<unknown> {
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const { instance } = await WebAssembly.instantiate(new Uint8Array(result.binary), result.importObject);
  const exported = instance.exports[name];
  if (typeof exported !== "function") throw new Error(`missing real export ${name}`);
  return exported(...args);
}

describe("parser-recovered empty parenthesized expression", () => {
  it("retains the exact malformed source and authentic TS1109 missing-node evidence", () => {
    expect(createHash("sha256").update(BROKEN).digest("hex")).toBe(
      "52e2153ae3a071386f70358fd68a58208d0a66727786728bed85b3db52f066d5",
    );
    const ast = analyzeMultiSource({ "./failed.ts": BROKEN }, "./failed.ts");
    const diagnostic = ast.syntacticDiagnostics.find((d) => d.code === 1109);
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.start).toBe(58);
    expect(diagnostic!.length).toBe(1);
    expect(ast.entryFile.text).toBe(BROKEN);
  });
  for (const target of TARGETS)
    for (const sourceMap of MAPS) {
      it(`single ${target} maps ${sourceMap}: rejects before successful artifacts`, async () => {
        missingExpression(await compile(BROKEN, { target, moduleName: "failed.ts", sourceMap }), "failed.ts");
      });
      it(`multi ${target} maps ${sourceMap}: rejects the actual entry source before artifacts`, async () => {
        missingExpression(
          await compileMulti({ "./failed.ts": BROKEN }, "./failed.ts", { target, sourceMap }),
          "failed.ts",
        );
      });
      it(`files ${target} maps ${sourceMap}: rejects the original physical source before artifacts`, async () => {
        const directory = mkdtempSync(join(tmpdir(), "js2wasm-6864-"));
        directories.push(directory);
        const path = join(directory, "failed.ts");
        writeFileSync(path, BROKEN);
        missingExpression(await compileFiles(path, { target, sourceMap }), path);
      });
      it(`private ${target} maps ${sourceMap}: source validation fails before either generator`, () => {
        const gc = vi.spyOn(gcCodegen, "generateModule");
        const gcMulti = vi.spyOn(gcCodegen, "generateMultiModule");
        const linear = vi.spyOn(linearCodegen, "generateLinearModule");
        const linearMulti = vi.spyOn(linearCodegen, "generateLinearMultiModule");
        const input = privateInput(BROKEN, target, sourceMap);
        const result = runPreparedIrPipelinePresentation(input);
        expect(result.kind).toBe("output-failed");
        if (result.kind !== "output-failed") throw new Error(`unexpected private result ${result.kind}`);
        noArtifacts(result.artifacts);
        const error = result.errors.find((e) => e.severity === "error" && /parenthesized expression/i.test(e.message));
        expect(error).toMatchObject({ line: 2, column: 10, file: "failed.ts" });
        for (const spy of [gc, gcMulti, linear, linearMulti]) expect(spy).not.toHaveBeenCalled();
      });
    }
  for (const target of TARGETS) {
    it(`valid ${target}: parentheses, empty direct calls and return remain productive`, async () => {
      const source =
        "function empty():number{return 23;} export function calculate(value:number):number{return (value)+(empty())+2;} export function finish():void{return;}";
      const result = await compile(source, { target });
      expect(await execute(result, "calculate", 7)).toBe(32);
      expect(await execute(result, "finish")).toBeUndefined();
    });
    it(`semantic warning ${target}: unknown erased type remains a warning with real output`, async () => {
      const result = await compile(
        "type Broken = MissingType; export function calculate(value:number):number{return (value)+2;}",
        { target },
      );
      expect(result.errors.some((e) => e.code === 2304 && e.severity === "warning")).toBe(true);
      expect(result.errors.some((e) => e.severity === "error")).toBe(false);
      expect(await execute(result, "calculate", 5)).toBe(7);
    });
  }
  it("valid arrow source: genuine early-error visitation does not reject empty arrow parameters", () => {
    const ast = analyzeMultiSource({ "./valid.ts": VALID_ARROW }, "./valid.ts");
    expect(ast.syntacticDiagnostics).toEqual([]);
    expect(detectEarlyErrors(ast.entryFile).filter((e) => e.severity === "error")).toEqual([]);
    // Original public Linear failure is preserved in baseline1: ArrowFunction remains an open migration gap.
  });
  it("valid GC arrow source: original public compilation executes both real exports", async () => {
    const result = await compile(VALID_ARROW, { target: "gc" });
    expect(await execute(result, "calculate", 7)).toBe(32);
    expect(await execute(result, "finish")).toBeUndefined();
  });
  it.each(["switch () {}", "switch (1) {case : break;}"])(
    "retains existing required-expression early error for %s",
    async (source) => {
      const result = await compile(source);
      expect(result.success).toBe(false);
      expect(result.errors.some((e) => e.severity === "error" && /Expression expected/.test(e.message))).toBe(true);
      noArtifacts(result);
    },
  );
});
