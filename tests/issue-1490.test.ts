// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1490 — Node.js process.* runtime access (non-WASI host mode).
//
// Verifies that compiled TS programs can read live values from the host
// `process` object: `process.argv`, `process.env.KEY`, `process.cwd()`,
// `process.platform`, and that `process.exit(code)` routes to the
// `__process_exit` host import.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function instantiate(source: string, deps?: Record<string, any>) {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const built = buildImports(r.imports, deps, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, built);
  if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, Function>;
}

describe("#1490 — Node.js process.* host imports (non-WASI)", () => {
  it("process.argv returns the host process argv array", async () => {
    const source = `
      declare const process: any;
      export function getArgv(): any { return process.argv; }
    `;
    const exp = await instantiate(source);
    const argv = exp.getArgv();
    expect(Array.isArray(argv)).toBe(true);
    expect(argv).toBe(process.argv);
  });

  it("process.argv.length matches the host", async () => {
    const source = `
      declare const process: any;
      export function getArgvLen(): number { return process.argv.length; }
    `;
    const exp = await instantiate(source);
    const len = exp.getArgvLen();
    expect(len).toBe(process.argv.length);
  });

  it("process.argv[i] returns string by index", async () => {
    const source = `
      declare const process: any;
      export function firstArg(): any { return process.argv[0]; }
    `;
    const exp = await instantiate(source);
    const first = exp.firstArg();
    expect(first).toBe(process.argv[0]);
  });

  it("process.env.KEY round-trips a set environment variable", async () => {
    const KEY = "JS2WASM_TEST_1490";
    const prevValue = process.env[KEY];
    process.env[KEY] = "hello-1490";
    try {
      const source = `
        declare const process: any;
        export function getKey(): any { return process.env.JS2WASM_TEST_1490; }
      `;
      const exp = await instantiate(source);
      const v = exp.getKey();
      expect(v).toBe("hello-1490");
    } finally {
      if (prevValue === undefined) Reflect.deleteProperty(process.env, KEY);
      else process.env[KEY] = prevValue;
    }
  });

  it("process.env returns the live env object", async () => {
    const source = `
      declare const process: any;
      export function getEnv(): any { return process.env; }
    `;
    const exp = await instantiate(source);
    const envObj = exp.getEnv();
    expect(envObj).toBe(process.env);
  });

  it("process.cwd() returns the working directory string", async () => {
    const source = `
      declare const process: any;
      export function cwd(): any { return process.cwd(); }
    `;
    const exp = await instantiate(source);
    const wd = exp.cwd();
    expect(typeof wd).toBe("string");
    expect(wd).toBe(process.cwd());
  });

  it("process.platform returns a platform string", async () => {
    const source = `
      declare const process: any;
      export function plat(): any { return process.platform; }
    `;
    const exp = await instantiate(source);
    const p = exp.plat();
    expect(typeof p).toBe("string");
    expect(p).toBe(process.platform);
  });

  it("process.exit(code) routes to host process.exit (mockable)", async () => {
    // We can't actually exit the test process. Replace process.exit with a
    // spy for the duration of this test and verify the compiled wasm calls it
    // with the right code.
    const originalExit = process.exit;
    let exitCode: number | undefined;
    (process as any).exit = (code: number) => {
      exitCode = code;
    };
    try {
      const source = `
        declare const process: any;
        export function doExit(): number {
          process.exit(7);
          return 99;
        }
      `;
      const exp = await instantiate(source);
      const result = exp.doExit();
      // The mocked process.exit returns normally, so wasm continues and
      // returns 99. The exit code captured by the spy should be 7.
      expect(exitCode).toBe(7);
      expect(result).toBe(99);
    } finally {
      process.exit = originalExit;
    }
  });
});
