// #4725 — native Map.forEach forwards thisArg to function-valued locals.
//
// The callback is intentionally assigned before forEach is compiled. Such
// values live in an externref local and must be recovered through the same
// canonical closure wrapper used by the array HOF lowering.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

async function runWasi(source: string): Promise<number> {
  const result = await compile(source, { fileName: "test.ts", target: "wasi" });
  if (!result.success) throw new Error(result.errors[0]?.message ?? "compile failed");
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module).filter((entry) => /^Map_/.test(entry.name))).toHaveLength(0);
  const wasi = buildWasiPolyfill();
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
  const exports = instance.exports as Record<string, unknown>;
  if (exports.memory) wasi.setMemory(exports.memory as WebAssembly.Memory);
  return (exports.test as () => number)();
}

describe("#4725 native Map.forEach thisArg", () => {
  it("binds a pre-bound function callback and preserves argument evaluation order", async () => {
    const value = await runWasi(`
      export function test(): number {
        const map = new Map<number, number>();
        map.set(1, 10); map.set(2, 20);
        let order = 0;
        const context = {};
        const callback = function (value: number, key: number) {
          order = order * 10 + key;
          if (key === 1) { map.delete(2); map.set(2, 22); }
        };
        map.forEach(callback, (order = order * 10 + 9, context));
        return order;
      }
    `);
    expect(value).toBe(912);
  });

  it("restores the receiver across nested native forEach calls", async () => {
    const value = await runWasi(`
      export function test(): number {
        const map = new Map<number, number>();
        map.set(1, 10);
        const outerThis = {};
        const innerThis = {};
        let seen = 0;
        const inner = function () { seen += this === innerThis ? 1 : 100; };
        const outer = function () {
          seen += this === outerThis ? 10 : 1000;
          map.forEach(inner, innerThis);
          seen += this === outerThis ? 100 : 1000;
        };
        map.forEach(outer, outerThis);
        return seen;
      }
    `);
    expect(value).toBe(111);
  });
});
