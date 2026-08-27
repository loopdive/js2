// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4771 — JS-HOST lane `%Function.prototype%[@@hasInstance]`. The standalone
// twin is tests/issue-4676-function-prototype-hasinstance.test.ts; before this
// fix every case here trapped with "dereferencing a null pointer", because the
// inherited method resolved to a null callee on a WasmGC-struct closure.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runHost(source: string, exportName: string): Promise<number> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4771-host-function-hasinstance.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { setExports?: (e: object) => void }).setExports?.(instance.exports as object);
  return (instance.exports as Record<string, () => number>)[exportName]!();
}

describe("#4771 host-lane Function.prototype @@hasInstance", () => {
  it("answers the method call for direct, inherited, negative and primitive operands", async () => {
    const source = `
      var F = function() {};
      var direct = new F();
      var inherited = Object.create(direct);
      export function positive(): number { return F[Symbol.hasInstance](direct) ? 1 : 0; }
      export function inheritedCase(): number { return F[Symbol.hasInstance](inherited) ? 1 : 0; }
      export function negative(): number { return F[Symbol.hasInstance](Object.create(null)) ? 1 : 0; }
      export function primitive(): number { return F[Symbol.hasInstance](86) ? 1 : 0; }
      export function noArgument(): number { return F[Symbol.hasInstance]() ? 1 : 0; }
    `;
    expect(await runHost(source, "positive")).toBe(1);
    expect(await runHost(source, "inheritedCase")).toBe(1);
    expect(await runHost(source, "negative")).toBe(0);
    expect(await runHost(source, "primitive")).toBe(0);
    expect(await runHost(source, "noArgument")).toBe(0);
  });

  it("forwards a bound function to its [[BoundTargetFunction]] (§7.3.20 step 2)", async () => {
    const source = `
      var BC = function() {};
      var bc = new BC();
      var bound = BC.bind();
      export function viaMethod(): number { return bound[Symbol.hasInstance](bc) ? 1 : 0; }
      export function viaOperator(): number { return (bc instanceof bound) ? 1 : 0; }
    `;
    expect(await runHost(source, "viaMethod")).toBe(1);
    expect(await runHost(source, "viaOperator")).toBe(1);
  });

  it("throws a catchable TypeError for a non-object prototype (§7.3.20 step 5)", async () => {
    const source = `
      var F = function() {};
      export function undefinedPrototype(): number {
        F.prototype = undefined;
        try { F[Symbol.hasInstance]({}); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; }
      }
      export function stringPrototype(): number {
        F.prototype = "not an object";
        try { F[Symbol.hasInstance]({}); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; }
      }
    `;
    expect(await runHost(source, "undefinedPrototype")).toBe(1);
    expect(await runHost(source, "stringPrototype")).toBe(1);
  });

  it("keeps `instanceof` on the DEFAULT branch — the method must not recurse", async () => {
    // §20.2.3.6 gives every function ONE shared inherited method, and
    // `_instanceofResult` step 2 recognises it as the default rather than as a
    // custom handler. If it were classified as custom, `x instanceof F` would
    // call it and recurse without bound.
    const source = `
      var F = function() {};
      var instance = new F();
      export function operatorStillWorks(): number { return (instance instanceof F) ? 1 : 0; }
      export function agreesWithMethod(): number {
        return ((instance instanceof F) === !!F[Symbol.hasInstance](instance)) ? 1 : 0;
      }
    `;
    expect(await runHost(source, "operatorStillWorks")).toBe(1);
    expect(await runHost(source, "agreesWithMethod")).toBe(1);
  });
});
