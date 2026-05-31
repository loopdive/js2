// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1533 — Node API host import unit tests.
//
// Covers the JS host imports the compiler resolves through the `node_builtin`
// import intent (see `src/runtime.ts::resolveImport` case "node_builtin") and
// the WASI-or-not `console_log` variants (case "console_log"):
//
//   * `import * as fs from "node:fs"` — fs.readFileSync / fs.writeFileSync
//     (gated behind { allowFs: true })
//   * `import process from "node:process"` — process.argv / process.env /
//     process.exit
//   * `import crypto from "node:crypto"` — crypto.randomBytes
//   * `console.error("msg")` / `console.warn("msg")` route through the
//     console_log variants `error_string` / `warn_string`
//
// These have no test262 coverage. Tests here compile a small TS snippet,
// instantiate via `buildImports` with no extra deps (which makes the resolver
// fall back to `_getNodeRequire()` for node:builtins), call the exported
// function, and assert against real Node behavior.
//
// `__dirname` and `import.meta.url` are intentionally NOT exercised: the
// compiler does not synthesize host imports for them today — they fall
// through to `__throw_reference_error` / null externref. A spec gap test
// belongs in a separate issue once that path is wired up.

import { mkdtempSync, readFileSync as nodeReadFileSync, writeFileSync as nodeWriteFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const tmpDir = mkdtempSync(join(tmpdir(), "js2wasm-1533-"));
const fixturePath = join(tmpDir, "fixture.txt");
const FIXTURE = "node-api-host-import-fixture";

beforeAll(() => {
  nodeWriteFileSync(fixturePath, FIXTURE, "utf-8");
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function compileAndInstantiate(source: string, opts: { allowFs?: boolean } = {}) {
  const r = await compile(source, {
    allowFs: opts.allowFs ?? false,
    fileName: "input.ts",
  });
  expect(r.errors.filter((e) => e.severity === "error")).toEqual([]);
  expect(r.success).toBe(true);
  const built = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, built);
  if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
  return { result: r, instance };
}

describe("#1533 — Node API host imports", () => {
  describe("process via node:process node_builtin import", () => {
    it("process.argv[i] reads from the live Node argv", async () => {
      const { result, instance } = await compileAndInstantiate(`
        import process from "node:process";
        export function getArgv(i: number): any { return process.argv[i]; }
      `);
      // sanity: a node_builtin import for the "process" module is registered
      const procImp = result.imports.find(
        (imp) => imp.intent.type === "node_builtin" && imp.intent.moduleName === "process",
      );
      expect(procImp).toBeDefined();
      const getArgv = instance.exports.getArgv as (i: number) => unknown;
      expect(getArgv(0)).toBe(process.argv[0]);
      expect(getArgv(1)).toBe(process.argv[1]);
    });

    it("process.env reads live environment variables", async () => {
      const { instance } = await compileAndInstantiate(`
        import process from "node:process";
        export function getEnv(k: string): any { return process.env[k]; }
      `);
      const SENTINEL = "issue-1533-env-sentinel";
      process.env.JS2WASM_1533_TEST = SENTINEL;
      try {
        const getEnv = instance.exports.getEnv as (k: string) => unknown;
        expect(getEnv("JS2WASM_1533_TEST")).toBe(SENTINEL);
      } finally {
        process.env.JS2WASM_1533_TEST = undefined;
      }
    });

    it("process.exit(code) calls into Node's real process.exit", async () => {
      const { instance } = await compileAndInstantiate(`
        import process from "node:process";
        export function doExit(): void { process.exit(42); }
      `);
      // We cannot let the real `process.exit` run — it would terminate the
      // vitest worker. Stub it to throw, then assert the call shape.
      const origExit = process.exit.bind(process) as typeof process.exit;
      const exitSpy = vi.fn((code?: number | string | null): never => {
        throw new Error(`__exit_called_with:${code}`);
      }) as unknown as typeof process.exit;
      process.exit = exitSpy;
      try {
        const doExit = instance.exports.doExit as () => void;
        expect(() => doExit()).toThrow(/__exit_called_with:42/);
        expect(exitSpy).toHaveBeenCalledWith(42);
      } finally {
        process.exit = origExit;
      }
    });
  });

  describe("crypto via node:crypto node_builtin import", () => {
    it("crypto.randomBytes(n) returns a Buffer of length n", async () => {
      const { result, instance } = await compileAndInstantiate(`
        import crypto from "node:crypto";
        export function getRand(n: number): any { return crypto.randomBytes(n); }
      `);
      const cryptoImp = result.imports.find(
        (imp) => imp.intent.type === "node_builtin" && imp.intent.moduleName === "crypto",
      );
      expect(cryptoImp).toBeDefined();
      const getRand = instance.exports.getRand as (n: number) => unknown;
      const buf = getRand(16) as Buffer;
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.length).toBe(16);
      // two consecutive 16-byte draws should differ (entropy sanity)
      const buf2 = getRand(16) as Buffer;
      expect(buf.equals(buf2)).toBe(false);
    });
  });

  describe("node:fs via node_builtin_fn import (allowFs)", () => {
    it("readFileSync round-trips a real file", async () => {
      const { instance } = await compileAndInstantiate(
        `
          import { readFileSync } from "node:fs";
          export function readFixture(path: string): string {
            return readFileSync(path, "utf-8");
          }
        `,
        { allowFs: true },
      );
      const readFixture = instance.exports.readFixture as (p: string) => string;
      expect(readFixture(fixturePath)).toBe(FIXTURE);
    });

    it("writeFileSync writes a real file via the host import", async () => {
      const { instance } = await compileAndInstantiate(
        `
          import { writeFileSync } from "node:fs";
          export function writeAt(path: string, data: string): void {
            writeFileSync(path, data);
          }
        `,
        { allowFs: true },
      );
      const outPath = join(tmpDir, "issue-1533-write.txt");
      const writeAt = instance.exports.writeAt as (p: string, d: string) => void;
      writeAt(outPath, "WROTE-FROM-1533");
      expect(nodeReadFileSync(outPath, "utf-8")).toBe("WROTE-FROM-1533");
    });

    it("without allowFs the compiler refuses the import (capability gate)", async () => {
      const r = await compile(
        `
          import { readFileSync } from "node:fs";
          export function readFixture(path: string): string {
            return readFileSync(path, "utf-8");
          }
        `,
        { allowFs: false, fileName: "input.ts" },
      );
      const hardErrors = r.errors.filter((e) => e.severity === "error");
      expect(hardErrors.length).toBeGreaterThan(0);
      expect(hardErrors.some((e) => /--allow-fs|allowFs/.test(e.message))).toBe(true);
    });
  });

  describe("console.error / console.warn route through console_log import variants", () => {
    // resolveImport's "console_log" case closure-captures `console.error` /
    // `console.warn` at buildImports() time (see src/runtime.ts). So the spy
    // must be installed BEFORE compileAndInstantiate is called — otherwise
    // the resolver captures the un-spied original and the assertion fires 0
    // calls.
    it("console.error('msg') invokes console.error (stderr) on the JS host", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const { result, instance } = await compileAndInstantiate(`
          export function logErr(): void { console.error("error-routed-to-stderr"); }
        `);
        // The compiler should have registered a console_log import with the
        // "error_string" variant. (Distinct from "log_string"/"warn_string".)
        const errImp = result.imports.find(
          (imp) => imp.intent.type === "console_log" && (imp.intent as { variant: string }).variant === "error_string",
        );
        expect(errImp).toBeDefined();
        (instance.exports.logErr as () => void)();
        expect(errSpy).toHaveBeenCalledWith("error-routed-to-stderr");
      } finally {
        errSpy.mockRestore();
      }
    });

    it("console.warn('msg') invokes console.warn on the JS host", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { instance } = await compileAndInstantiate(`
          export function logWarn(): void { console.warn("warn-message"); }
        `);
        (instance.exports.logWarn as () => void)();
        expect(warnSpy).toHaveBeenCalledWith("warn-message");
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  // NOTE: __dirname and import.meta.url do not currently emit a dedicated
  // host import — they resolve to `undefined` / null externref or trigger a
  // ReferenceError. A separate spec-gap issue tracks adding them; this test
  // file documents the current state as a regression guard.
  describe("known gaps (#1533 scope)", () => {
    it("bare `__dirname` reference is treated as an undeclared identifier (warning, not host import)", async () => {
      const r = await compile(
        `
          export function dir(): any { return __dirname; }
        `,
        { fileName: "input.ts" },
      );
      // No node_builtin import for `__dirname` today.
      const dirImp = r.imports.find(
        (imp) => imp.intent.type === "node_builtin" && imp.intent.moduleName === "__dirname",
      );
      expect(dirImp).toBeUndefined();
    });
  });
});
