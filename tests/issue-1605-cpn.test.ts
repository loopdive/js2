import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * Issue #1605-cpn — a `call`-arg fixup walked backwards from a `call`
 * matching params to preceding instructions but did not treat `local.tee`
 * (stack-neutral) as transparent. For `c[null] = null` lowered as a setter
 * call `C_set_null(self, value)`, the externref `value` (`ref.null.extern`)
 * was tee'd into a temp; the backward walk mis-mapped that `ref.null.extern`
 * to param 0 (the struct receiver) and rewrote it to `ref.null <struct>`,
 * producing `local.tee[N] expected externref, found ref.null of <struct>`
 * invalid wasm.
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

async function compileAndRun(code: string): Promise<number> {
  const result = await compile(code);
  expect(result.success).toBe(true);
  const wasmModule = new WebAssembly.Module(result.binary);
  const instance = new WebAssembly.Instance(wasmModule, buildImports(wasmModule));
  return (instance.exports as any).test();
}

describe("class computed-accessor setter call-arg fixup (#1605-cpn)", () => {
  it("c[null] = null on an accessor-only class compiles to valid wasm and calls the setter", async () => {
    expect(
      await compileAndRun(`
        let calls = 0;
        class C {
          get [null]() { return null; }
          set [null](v: any) { calls = calls + 1; }
        }
        export function test(): number {
          let c = new C();
          c[null] = null;
          return calls;
        }
      `),
    ).toBe(1);
  });

  it("does not regress a normal string-key setter on a class", async () => {
    expect(
      await compileAndRun(`
        let calls = 0;
        class C {
          set ['x'](v: any) { calls = calls + 1; }
        }
        export function test(): number {
          let c = new C();
          c['x'] = 5 as any;
          return calls;
        }
      `),
    ).toBe(1);
  });
});
