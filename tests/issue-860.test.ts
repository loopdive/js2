import { describe, expect, it } from "vitest";
import { compile } from "./src/index.js";
import { buildImports } from "./src/runtime.js";

describe("#860 — Wasm closure stored as host-object property value", () => {
  async function run(src: string): Promise<{ ret?: unknown; error?: string }> {
    const result = await compile(src, { skipSemanticDiagnostics: true });
    if (!result.success) return { error: result.error };
    const importObj = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, importObj as any);
    if (typeof (importObj as any).setExports === "function") {
      (importObj as any).setExports(instance.exports);
    }
    try {
      const ret = (instance.exports as any).test();
      return { ret };
    } catch (e: any) {
      return { error: String(e).slice(0, 300) };
    }
  }

  it("Promise.race invokes user-installed .then property", async () => {
    const src = `
      export function test(): number {
        let callCount = 0;
        const p1 = new Promise(function(resolve: any, reject: any) { resolve(1); });
        (p1 as any).then = function(a: any, b: any): number {
          callCount += 1;
          return 0;
        };
        Promise.race([p1]);
        return callCount === 1 ? 1 : 100 + callCount;
      }
    `;
    const { ret, error } = await run(src);
    expect(error).toBeUndefined();
    expect(ret).toBe(1);
  });

  it("function assigned to extern object property reports typeof function", async () => {
    const src = `
      export function test(): number {
        const arr: any = [1, 2, 3];
        arr.myFn = function(): number { return 42; };
        const fn: any = arr.myFn;
        if (typeof fn === "function") return 1;
        return 2;
      }
    `;
    const { ret, error } = await run(src);
    expect(error).toBeUndefined();
    expect(ret).toBe(1);
  });

  it("Wasm closure passed via bracket-then host call is invocable (dynamic-import shape)", async () => {
    // Mirrors test262 `import(spec)['then'](x => x)` — the closure reaches
    // the host as an `__extern_method_call` arg; `_PROTO_CB_SLOTS.then` must
    // route it through `_maybeWrapCallable` so the native engine sees a Function.
    const src = `
      export function test(): number {
        const p = Promise.resolve(42);
        let invoked = 0;
        (p as any)["then"](function(x: any) {
          invoked = 1;
          return x;
        });
        // synchronous: the callback may not have run yet, but if the wrap
        // is missing the host throws "not a function" before we return.
        return invoked === 0 || invoked === 1 ? 1 : 2;
      }
    `;
    const { ret, error } = await run(src);
    expect(error).toBeUndefined();
    expect(ret).toBe(1);
  });
});
