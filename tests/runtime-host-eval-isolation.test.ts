// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Eval-only Worker isolation while the AOT Wasm instance stays in the host. */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type CompileResult, compile } from "../src/index.js";
import { type NodeEvalWorkerEvaluator, connectNodeEvalWorker } from "../src/runtime-node-eval-worker.js";
import { buildImports, instantiateWasm, wrapExports } from "../src/runtime.js";

const MAIN_ONLY = "__js2wasm_eval_main_only__";
const WORKER_ONLY = "__js2wasm_eval_worker_only__";

let workerBuildDir: string;
let workerEntryUrl: URL;
let compiled: CompileResult;
let activeEvaluator: NodeEvalWorkerEvaluator | undefined;

beforeAll(async () => {
  const temporaryRoot = join(process.cwd(), ".tmp");
  await mkdir(temporaryRoot, { recursive: true });
  workerBuildDir = await mkdtemp(join(temporaryRoot, "eval-worker-"));
  const outfile = join(workerBuildDir, "worker.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/node-eval-worker.mjs", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile,
  });
  workerEntryUrl = pathToFileURL(outfile);

  compiled = await compile(
    `
      export function evalSource(source: any): any {
        return (0, eval)(source);
      }

      export function evalObjectProperty(source: any): any {
        const object: any = (0, eval)(source);
        return object.answer;
      }

      export function evalAndCall(source: any, value: any): any {
        const fn: any = (0, eval)(source);
        return fn(value);
      }

      export function makeFunction(body: any): any {
        const fn: any = new Function("value", body);
        return fn(41);
      }

      export function directEvalLocal(source: any): any {
        let value: any = 40;
        const result: any = eval(source);
        return value * 100 + result;
      }

      export function directEvalClosure(source: any): any {
        let value: any = 40;
        const fn: any = eval(source);
        value = 41;
        return fn();
      }

      export function directEvalWriteBeforeThrow(source: any): any {
        let value: any = 40;
        try {
          eval(source);
        } catch {}
        return value;
      }

      export function directEvalMissing(source: any): any {
        return eval(source);
      }

      export function catchesSyntaxError(source: any): number {
        try {
          (0, eval)(source);
          return 0;
        } catch (error: any) {
          return error instanceof SyntaxError ? 1 : 2;
        }
      }
    `,
    { skipSemanticDiagnostics: true, directEval: "reified-host" },
  );
  expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(compiled.imports.some((descriptor) => descriptor.name === "__extern_eval")).toBe(true);
  expect(compiled.imports.some((descriptor) => descriptor.name === "__extern_direct_eval")).toBe(true);
  expect(compiled.imports.some((descriptor) => descriptor.name === "__extern_new_function")).toBe(true);
});

afterEach(async () => {
  await activeEvaluator?.terminate();
  activeEvaluator = undefined;
  delete (globalThis as Record<string, unknown>)[MAIN_ONLY];
  delete (globalThis as Record<string, unknown>)[WORKER_ONLY];
});

afterAll(async () => {
  await rm(workerBuildDir, { recursive: true, force: true });
});

async function instantiateWithEvalWorker(timeoutMs = 30_000): Promise<Record<string, Function>> {
  activeEvaluator = await connectNodeEvalWorker(new Worker(workerEntryUrl), {
    timeoutMs,
  });
  const imports = buildImports(compiled.imports, undefined, compiled.stringPool, {
    dynamicCode: "evaluator",
    dynamicCodeEvaluator: activeEvaluator,
  });
  const { instance } = await instantiateWasm(
    compiled.binary,
    imports.env,
    imports.string_constants,
    imports.string_constants16,
  );
  imports.setInstance?.(instance);
  return wrapExports(instance, { signatures: compiled.exportSignatures });
}

describe("isolated JS-host evaluator", () => {
  it("keeps the legacy direct-eval lowering byte-identical by default", async () => {
    const source = `export function run(source: any): any { let value: any = 1; return eval(source); }`;
    const implicit = await compile(source, { skipSemanticDiagnostics: true });
    const explicit = await compile(source, {
      skipSemanticDiagnostics: true,
      directEval: "legacy",
    });

    expect(implicit.success).toBe(true);
    expect(explicit.success).toBe(true);
    expect(Buffer.from(explicit.binary)).toEqual(Buffer.from(implicit.binary));
    expect(implicit.imports.some((descriptor) => descriptor.name === "__extern_direct_eval")).toBe(false);
  });

  it("keeps the AOT module in the host and eval globals in the Worker realm", async () => {
    (globalThis as Record<string, unknown>)[MAIN_ONLY] = 91;
    const exports = await instantiateWithEvalWorker();

    expect(exports.evalSource(`typeof globalThis.${MAIN_ONLY}`)).toBe("undefined");
    expect(exports.evalSource(`globalThis.${WORKER_ONLY} = 41; globalThis.${WORKER_ONLY}`)).toBe(41);
    expect(exports.evalSource(`globalThis.${WORKER_ONLY} + 1`)).toBe(42);
    expect((globalThis as Record<string, unknown>)[MAIN_ONLY]).toBe(91);
    expect((globalThis as Record<string, unknown>)[WORKER_ONLY]).toBeUndefined();
  });

  it("keeps Worker objects and functions remote while compiled code uses them synchronously", async () => {
    const exports = await instantiateWithEvalWorker();

    expect(exports.evalObjectProperty("({ answer: 42 })")).toBe(42);
    expect(exports.evalAndCall("(value) => value + 1", 41)).toBe(42);
    exports.evalSource(`globalThis.${WORKER_ONLY} = 1`);
    expect(exports.makeFunction(`return value + globalThis.${WORKER_ONLY}`)).toBe(42);
  });

  it("keeps reified direct-eval cells live in the main AOT instance", async () => {
    const exports = await instantiateWithEvalWorker();

    expect(exports.directEvalLocal("value = value + 2; value")).toBe(4242);
    expect(exports.directEvalClosure("() => ++value")).toBe(42);
    expect(exports.directEvalWriteBeforeThrow("value = 42; throw new Error('after write')")).toBe(42);
    expect(() => exports.directEvalMissing("missingDirectEvalName")).toThrowError(
      expect.objectContaining({ name: "ReferenceError" }),
    );
  });

  it("reconstructs standard errors for compiled catch and host escape", async () => {
    const exports = await instantiateWithEvalWorker();

    expect(exports.catchesSyntaxError("@")).toBe(1);
    expect(() => exports.evalSource("throw new RangeError('isolated boom')")).toThrowError(
      expect.objectContaining({ name: "RangeError", message: "isolated boom" }),
    );
  });

  it("hard-terminates an eval Worker at the synchronous deadline", async () => {
    const exports = await instantiateWithEvalWorker(250);

    expect(() => exports.evalSource("for (;;) {}")).toThrowError(expect.objectContaining({ name: "TimeoutError" }));
    expect(() => exports.evalSource("1 + 1")).toThrowError(expect.objectContaining({ name: "TimeoutError" }));
  });

  it("supports a fail-closed host without starting an evaluator", async () => {
    const imports = buildImports(compiled.imports, undefined, compiled.stringPool, { dynamicCode: "deny" });
    const { instance } = await instantiateWasm(
      compiled.binary,
      imports.env,
      imports.string_constants,
      imports.string_constants16,
    );
    imports.setInstance?.(instance);
    const exports = wrapExports(instance);

    expect(exports.evalSource(41)).toBe(41);
    expect(() => exports.evalSource("1 + 1")).toThrow(/dynamic code generation is disabled/);
    expect(() => exports.makeFunction("return value + 1")).toThrow(/dynamic code generation is disabled/);
  });
});
