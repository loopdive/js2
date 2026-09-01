// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5255 — a generator declaration stored as an object property crosses two
 * standalone-only boundaries: its concrete `$GenState` must survive the erased
 * callable-property result, and the property-call receiver must survive until
 * the later `.next()` resumes the body.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<Record<string, Function>> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-5255.js",
    target: "standalone",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("; ")).toBe(true);
  if (!result.success) return {};

  const module = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(module).map((entry) => `${entry.module}::${entry.name}`);
  expect(imports, "native generator receiver transport must remain host-free").toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as Record<string, Function>;
  exports.__module_init?.();
  return exports;
}

async function runHost(source: string): Promise<Record<string, Function>> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-5255-host.js",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("; ")).toBe(true);
  if (!result.success) return {};

  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  const exports = instance.exports as Record<string, Function>;
  exports.__module_init?.();
  return exports;
}

describe("#5255 native generator declaration property receiver", () => {
  it("matches GeneratorPrototype/next/context-method-invocation and stays deferred", async () => {
    const exports = await runStandalone(`
      var context;
      var calls = 0;
      function* g() { context = this; calls += 1; yield 1; }
      var obj = { g: g };
      export function test() {
        var iter = obj.g();
        var before = calls === 0 ? 100 : 0;
        iter.next();
        return before + (context === obj ? 1 : 0);
      }
    `);
    expect(exports.test!()).toBe(101);
  });

  it("captures the receiver once and exposes it to a lexical arrow on resume", async () => {
    const exports = await runStandalone(`
      var receiverReads = 0;
      function* g() {
        var read = () => this;
        yield read().marker;
      }
      var obj = { marker: 1, g: g };
      function base() { receiverReads += 1; return obj; }
      export function test() {
        var iter = base().g();
        return receiverReads * 10 + iter.next().value;
      }
    `);
    expect(exports.test!()).toBe(11);
  });

  it("evaluates a computed property key once before resuming with its receiver", async () => {
    const exports = await runStandalone(`
      var keyReads = 0;
      function* g() { yield this.marker; }
      var obj = { marker: 1, g: g };
      function key() { keyReads += 1; return "g"; }
      export function test() {
        var iter = obj[key()]();
        return keyReads * 10 + iter.next().value;
      }
    `);
    expect(exports.test!()).toBe(11);
  });

  it("also carries the deferred receiver through the host-runtime lane", async () => {
    const exports = await runHost(`
      var context;
      function* g() { context = this; yield 1; }
      var obj = { marker: 7, g: g };
      export function test() {
        var iter = obj.g();
        iter.next();
        return context.marker;
      }
    `);
    expect(exports.test!()).toBe(7);
  });
});
