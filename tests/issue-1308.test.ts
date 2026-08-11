// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile, compileProject } from "../src/index.js";
import { buildImports, wrapExports } from "../src/runtime.js";

/**
 * #1308 — Wasm closure struct returned to JS host is not JS-callable.
 *
 * Two-part fix:
 *
 * 1. **Codegen** — `generateMultiModule` was missing the `__call_fn_0` /
 *    `__call_fn_1` (and several other) export emit calls that the
 *    single-source `generateModule` had. For multi-source projects (e.g.
 *    lodash via `compileProject`) those exports never reached the binary,
 *    so even runtime helpers that wanted to dispatch via `__call_fn_0`
 *    couldn't. Fixed by adding the same emit calls to `generateMultiModule`.
 *
 * 2. **Runtime** — added `wrapExports(instance.exports)` which returns a
 *    new exports object whose user-visible callable exports auto-wrap
 *    any returned Wasm closure struct in a JS function. The wrapper
 *    dispatches via `__call_fn_0` (0 args) or `__call_fn_1` (1 arg).
 *
 * Variadic closures use the same bridge: positional host arguments are packed
 * into the lifted function's internal rest vec before `call_ref`.
 */

async function runSingle(src: string): Promise<{ exports: Record<string, any> }> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return { exports: wrapExports(instance.exports) };
}

describe("#1308 — wrapExports makes Wasm closure returns JS-callable", () => {
  it("typeof exported closure return is 'function' (was 'object')", async () => {
    const { exports } = await runSingle(`
      export function makeFn(): () => number {
        return () => 42;
      }
    `);
    const fn = exports.makeFn();
    expect(typeof fn).toBe("function");
  });

  it("zero-arg closure dispatches via __call_fn_0", async () => {
    const { exports } = await runSingle(`
      export function makeFn(): () => number {
        return () => 42;
      }
    `);
    const fn = exports.makeFn();
    expect(fn()).toBe(42);
  });

  it("captured-value closure: makeAdder(5)() returns 6", async () => {
    const { exports } = await runSingle(`
      export function makeAdder(x: number): () => number {
        return () => x + 1;
      }
    `);
    const adder = exports.makeAdder(5);
    expect(typeof adder).toBe("function");
    expect(adder()).toBe(6);
  });

  it("1-arg closure dispatches via __call_fn_1", async () => {
    const { exports } = await runSingle(`
      export function makeIdentity(): (n: number) => number {
        return (n) => n + 1;
      }
    `);
    const inc = exports.makeIdentity();
    expect(typeof inc).toBe("function");
    expect(inc(7)).toBe(8);
  });

  it("packs positional host arguments for a returned rest closure", async () => {
    const { exports } = await runSingle(`
      export function makeCollector(seed: number): (...values: number[]) => number {
        return (...values: number[]): number => {
          let total = seed + values.length * 100;
          for (let i = 0; i < values.length; i++) total += values[i] * (i + 1);
          return total;
        };
      }
    `);
    const collect = exports.makeCollector(10);
    expect(collect()).toBe(10);
    expect(collect(2)).toBe(112);
    expect(collect(2, 3, 4)).toBe(330);
  });

  it("decodes standalone boolean closure arguments through the numeric union carrier", async () => {
    const result = await compile(
      `
        export function makePredicate(): (condition: boolean) => number {
          return (condition: boolean): number => condition ? 1 : 0;
        }
      `,
      { fileName: "standalone-boolean-bridge.ts", target: "standalone" },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const wat = result.wat ?? "";
    const start = wat.indexOf("(func $__call_fn_1");
    const end = wat.indexOf("\n  (func ", start + 1);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(wat.slice(start, end >= 0 ? end : undefined)).toContain("i32.trunc_sat_f64_s");
  });

  it("non-callable exports pass through unchanged", async () => {
    const { exports } = await runSingle(`
      export function pure(x: number): number {
        return x * 2;
      }
    `);
    // Number-returning export is not a closure — wrapper just returns the number.
    expect(typeof exports.pure).toBe("function");
    expect(exports.pure(3)).toBe(6);
  });

  it("internal __-prefixed exports stay accessible by name", async () => {
    const { exports } = await runSingle(`
      export function makeFn(): () => number {
        return () => 1;
      }
    `);
    // The wrapper preserves __call_fn_0 (and other internals) so the runtime
    // and the wrapper itself can still reach them.
    expect(typeof exports.__call_fn_0).toBe("function");
  });

  it("lodash negate(jsFn): typeof guard cleared (#1304) + JS-callable (#1308)", async () => {
    const r = await compileProject("node_modules/lodash-es/negate.js", { allowJs: true });
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    const exp = wrapExports(instance.exports);

    const isEven = (n: number) => n % 2 === 0;
    const negated = exp.negate(isEven);

    // Pre-#1304: lodash's `typeof predicate != 'function'` guard threw
    // before reaching this point. Pre-#1308: typeof was "object".
    expect(typeof negated).toBe("function");

    // The returned variadic closure now receives an empty rest vec, calls the
    // predicate with no arguments, and preserves the JavaScript boolean result.
    expect(negated()).toBe(true);
  });
});
