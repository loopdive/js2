// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4206 — closures created inside `with` capture the Object Environment Record.
 *
 * The IR contract captures the receiver reference, not property snapshots. The
 * runtime probes therefore mutate the object after closure creation and require
 * invocation-time reads/writes through the captured environment.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { selectWithEnvironmentClosures } from "../src/ir/with-environment.js";
import { buildImports, wrapExports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";

async function runModule(source: string, target?: "standalone"): Promise<unknown> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4206-with-closure.js",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    ...(target ? { target } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  if (target === "standalone") {
    expect(result.imports.map((entry) => `${entry.module}::${entry.name}`)).toEqual([]);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.__setExports?.(instance.exports);
  if ("setExports" in imports && typeof imports.setExports === "function") {
    imports.setExports(instance.exports);
  }
  const exports = wrapExports(instance.exports, { signatures: result.exportSignatures }) as { test: () => unknown };
  return exports.test();
}

function selectBody(source: string) {
  const sf = ts.createSourceFile("selection.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const withStatement = sf.statements.find(ts.isWithStatement);
  if (!withStatement) throw new Error("probe has no with statement");
  return selectWithEnvironmentClosures(withStatement.statement);
}

describe("#4206 with-environment closure IR contract", () => {
  it("selects, lowers, and executes the closed-object closure slice through IR", async () => {
    const result = await compile(
      `
        export function test(): number {
          let out = 0;
          with ({ value: 42 }) {
            const read = function (): number { return value; };
            out = read();
          }
          return out;
        }
      `,
      {
        allowJs: true,
        fileName: "issue-4206-with-closure-ir.ts",
        skipSemanticDiagnostics: true,
        inferModuleStrictArguments: false,
        target: "standalone",
        trackIrOutcomes: true,
      },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irOutcomes).toEqual([
      expect.objectContaining({ displayName: "test", kind: "emitted", irBodyEmitted: true }),
    ]);
    expect(result.imports.map((entry) => `${entry.module}::${entry.name}`)).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as { test: () => number }).test()).toBe(42);
  });

  it("captures a dynamic object environment by reference after the with exits", async () => {
    const source = `
      export function test() {
        var o = { prop: 1, valueOf: function () { return 0; } };
        var f;
        with (o) { f = function () { return prop; }; }
        o.prop = 8;
        return f();
      }
    `;
    expect(await runModule(source, "standalone")).toBe(8);
  });

  it("writes through the captured environment instead of the outer binding", async () => {
    const source = `
      export function test() {
        var value = 1;
        var o = { value: 2, valueOf: function () { return 0; } };
        var f;
        with (o) { f = function () { value = 9; }; }
        f();
        return o.value * 10 + value;
      }
    `;
    expect(await runModule(source, "standalone")).toBe(91);
  });

  it("preserves outer-to-inner scope order across two captured with environments", async () => {
    const source = `
      export function test() {
        var outer = { a: 4 };
        var inner = { b: 2 };
        var f;
        with (outer) { with (inner) { f = function () { return a * 10 + b; }; } }
        return f();
      }
    `;
    expect(await runModule(source, "standalone")).toBe(42);
  });

  it("resolves a lifted function's own var before the captured object environment", async () => {
    const source = `
      export function test() {
        var o = { value: 2 };
        var f;
        with (o) { f = function () { var value = 9; return value; }; }
        return f() * 10 + o.value;
      }
    `;
    expect(await runModule(source, "standalone")).toBe(92);
  });

  it("keeps the same behavior on the JS-host lane", async () => {
    expect(
      await runModule(`
        export function test() {
          var o = { prop: 7, valueOf: function () { return 0; } };
          var f;
          with (o) { f = function () { return prop; }; }
          return f();
        }
      `),
    ).toBe(7);
  });

  it("carries the environment through the JS-host callback bridge", async () => {
    expect(
      await runModule(`
        export function test() {
          var observed = 0;
          var o = { value: 7 };
          with (o) {
            JSON.parse("0", function (_key, parsed) { observed = value; return parsed; });
          }
          return observed;
        }
      `),
    ).toBe(7);
  });

  it("selects only ordinary synchronous function expressions", () => {
    expect(selectBody(`with (o) { f = function () { return p; }; }`)).toEqual({ ok: true, closureCount: 1 });
    expect(selectBody(`with (o) { f = () => p; }`)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("arrow"),
    });
    expect(selectBody(`with (o) { function f() { return p; } }`)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("hoisting"),
    });
    expect(selectBody(`with (o) { f = async function () { return p; }; }`)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("async"),
    });
    expect(selectBody(`with (o) { f = function () { return p; }; new f(); }`)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("constructible"),
    });
    expect(selectBody(`with (o) { class C { m() { return p; } } }`)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("class"),
    });
  });
});
