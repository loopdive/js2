import { describe, test, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * Issue #1594B — class name in its own `extends` expression is in the TDZ.
 * Per ECMA-262 §15.7.1 ClassDefinitionEvaluation, the class-name binding is
 * installed in the class's inner scope only AFTER the `extends` clause is
 * evaluated. Referencing the class name inside `extends` must throw
 * ReferenceError: `class x extends x {}`.
 */

function buildImports(wasmModule: WebAssembly.Module): Record<string, Record<string, any>> {
  const importObj: Record<string, Record<string, any>> = {};
  for (const imp of WebAssembly.Module.imports(wasmModule)) {
    if (!importObj[imp.module]) importObj[imp.module] = {};
    if (imp.kind === "function") {
      importObj[imp.module]![imp.name] = (...args: any[]) => args[0];
    } else if (imp.kind === "global") {
      importObj[imp.module]![imp.name] = imp.name;
    } else if (imp.kind === "tag") {
      importObj[imp.module]![imp.name] = new WebAssembly.Tag({ parameters: ["externref"] });
    }
  }
  return importObj;
}

function compileAndRun(code: string): number {
  const result = compile(code);
  expect(result.success).toBe(true);
  const wasmModule = new WebAssembly.Module(result.binary);
  const instance = new WebAssembly.Instance(wasmModule, buildImports(wasmModule));
  const exports = instance.exports as any;
  return exports.getResult();
}

describe("class name in own extends expression is TDZ (#1594B)", () => {
  test("class x extends x {} throws ReferenceError", { timeout: 15000 }, () => {
    const val = compileAndRun(`
      export function getResult(): number {
        let caught = 0;
        try {
          class x extends x {}
        } catch (e) {
          caught = 1;
        }
        return caught;
      }
    `);
    expect(val).toBe(1);
  });

  test("grouped: class x extends (x) {} throws ReferenceError", { timeout: 15000 }, () => {
    const val = compileAndRun(`
      export function getResult(): number {
        let caught = 0;
        try {
          class x extends (x) {}
        } catch (e) {
          caught = 1;
        }
        return caught;
      }
    `);
    expect(val).toBe(1);
  });

  test("class referencing its own name in a member-access extends throws", { timeout: 15000 }, () => {
    const val = compileAndRun(`
      export function getResult(): number {
        let caught = 0;
        try {
          class x extends x.foo {}
        } catch (e) {
          caught = 1;
        }
        return caught;
      }
    `);
    expect(val).toBe(1);
  });

  test("class expression: (class x extends x {}) throws ReferenceError", { timeout: 15000 }, () => {
    const val = compileAndRun(`
      export function getResult(): number {
        let caught = 0;
        try {
          const C = (class x extends x {});
        } catch (e) {
          caught = 1;
        }
        return caught;
      }
    `);
    expect(val).toBe(1);
  });

  test("extends an unrelated identifier still compiles (no false positive)", { timeout: 15000 }, () => {
    const val = compileAndRun(`
      class Base { getV(): number { return 7; } }
      export function getResult(): number {
        class Derived extends Base {}
        const d = new Derived();
        return d.getV();
      }
    `);
    expect(val).toBe(7);
  });
});
