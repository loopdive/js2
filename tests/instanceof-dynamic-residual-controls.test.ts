// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Focused controls for the remaining ES5 dynamic `instanceof` shapes.
 *
 * These cases deliberately keep the RHS behind a mutable binding or a
 * function-expression value.  That prevents the ordinary static folds from
 * hiding the runtime identity question while still checking the independently
 * provable primitive/non-callable TypeError guards.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string): Promise<{ result: number; imports: string[] }> {
  const compiled = await compile(`${source}\nexport function test(): number { return result as number; }\n`, {
    allowJs: true,
    fileName: "instanceof-dynamic-residual-controls.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
    inferModuleStrictArguments: false,
  });
  expect(compiled.success, compiled.errors.map((e) => e.message).join("; ")).toBe(true);
  const imports = (compiled.imports ?? []).map((entry: unknown) =>
    typeof entry === "string" ? entry : `${(entry as { module: string }).module}::${(entry as { name: string }).name}`,
  );
  expect(imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(compiled.binary, {});
  (instance.exports as Record<string, unknown> & { __module_init?: () => void }).__module_init?.();
  return {
    result: (instance.exports as Record<string, () => number>).test(),
    imports,
  };
}

describe("dynamic instanceof residual controls (standalone)", () => {
  it("keeps a reassigned Object constructor identity-stable", async () => {
    const outcome = await run(`
      var result = 0;
      var OBJECT = 0;
      OBJECT = Object;
      result = (({} instanceof OBJECT) === true) ? 1 : 0;
    `);
    expect(outcome.result).toBe(1);
  });

  it("joins a Function() prototype to Object.prototype by identity", async () => {
    const outcome = await run(`
      var result = 0;
      var FACTORY;
      FACTORY = Function();
      var instance;
      instance = {};
      var before = instance instanceof FACTORY;
      FACTORY.prototype = Object.prototype;
      var after = instance instanceof FACTORY;
      result = (!before && after) ? 1 : 0;
    `);
    expect(outcome.result).toBe(1);
  });

  it("preserves joined function-expression identity and Object/Function controls", async () => {
    const outcome = await run(`
      var result = 0;
      var MyFunct = function () {};
      var instance = new MyFunct;
      result = (instance instanceof MyFunct ? 1 : 0) +
        (instance instanceof Function ? 2 : 0) +
        (instance instanceof Object ? 4 : 0);
    `);
    expect(outcome.result).toBe(5);
  });

  it("throws for provably primitive and non-callable RHS values", async () => {
    const outcome = await run(`
      var result = 0;
      var primitive = 0;
      var nonCallable = {};
      var primitiveCaught = false;
      var objectCaught = false;
      try { ({}) instanceof primitive; } catch (error) { primitiveCaught = error instanceof TypeError; }
      try { ({}) instanceof nonCallable; } catch (error) { objectCaught = error instanceof TypeError; }
      result = primitiveCaught && objectCaught ? 1 : 0;
    `);
    expect(outcome.result).toBe(1);
  });
});
