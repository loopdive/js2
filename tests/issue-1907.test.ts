import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1907 / #1888 S6-b — standalone reads of selected built-in static methods as
 * values lower to Wasm closure structs instead of `__get_builtin`.
 *
 * Spec basis:
 * - ECMA-262 §23.1.2.3 Array.isArray delegates to IsArray.
 * - ECMA-262 §20.1.2.19 Object.keys performs ToObject, EnumerableOwnProperties
 *   with kind=key, then CreateArrayFromList.
 */

const BANNED = [/^env::__get_builtin$/, /^env::__extern_is_array$/, /^env::__object_keys$/];

function assertNoBannedImports(imports: ReadonlyArray<{ module: string; name: string }>): void {
  const labels = imports.map((i) => `${i.module}::${i.name}`);
  for (const re of BANNED) {
    const hits = labels.filter((label) => re.test(label));
    expect(hits, `standalone leaked ${re}: ${hits.join(", ")}`).toEqual([]);
  }
}

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, { target: "standalone" });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  assertNoBannedImports(result.imports);
  expect(WebAssembly.validate(result.binary), "module must validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { run: () => number }).run();
}

describe("#1907 standalone built-in static method value reads", () => {
  it("reads Array.isArray as a callable value without __get_builtin", async () => {
    const value = await runStandalone(`
      export function run(): number {
        const isArray = Array.isArray;
        return isArray([1, 2, 3]) ? 1 : 0;
      }
    `);
    expect(value).toBe(1);
  });

  it("Array.isArray method value returns false for non-arrays", async () => {
    const value = await runStandalone(`
      export function run(): number {
        const isArray = Array.isArray;
        const obj: any = { a: 1 };
        return isArray(obj) ? 1 : 0;
      }
    `);
    expect(value).toBe(0);
  });

  it("reads Object.keys as a callable value without __get_builtin", async () => {
    const value = await runStandalone(`
      export function run(): number {
        const keys: any = Object.keys;
        const obj: any = {};
        const ka = "a";
        const kb = "b";
        obj[ka] = 1;
        obj[kb] = 2;
        const ks: any = keys(obj);
        return ks.length;
      }
    `);
    expect(value).toBe(2);
  });

  // #2984 moved the "fail loud" boundary: an unsupported built-in static method
  // value read no longer hard-refuses at COMPILE time — it reifies as a
  // runtime-refusal closure that fails loud (a catchable throw) only when CALLED,
  // and never leaks `__get_builtin`. (This test previously used `Math.max`, which
  // #2933 later implemented natively; `Object.seal` has no standalone native body
  // yet, so it exercises the generic-throw-body path.)
  it("unsupported built-in static method value reads reify host-free and fail loud when called (#1907 / #2984)", async () => {
    const result = await compile(
      `export function run(): number { const seal: any = Object.seal; seal({}); return 1; }`,
      {
        target: "standalone",
      },
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoBannedImports(result.imports);
    expect(WebAssembly.validate(result.binary), "module must validate").toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect(() => (instance.exports as { run: () => number }).run()).toThrow();
  });

  // #1907 reopened (2026-07-20): after #838 landed BigInt64Array / BigUint64Array
  // as typed arrays, their `<View>.prototype` VALUE read still refused-loud
  // (`#1907 / #1888 S6-b`) — the two bigint views were excluded from the wired
  // `<View>.prototype` glue. They inherit the same `%TypedArray%.prototype` member
  // set (ECMA-262 §23.2), so the value read now resolves host-free like the 9
  // non-bigint views.
  it.each(["BigInt64Array", "BigUint64Array"])(
    "reads %s.prototype as a value without __get_builtin (#1907 reopened)",
    async (view) => {
      const value = await runStandalone(`
        export function run(): number {
          const p: any = ${view}.prototype;
          return p ? 1 : 0;
        }
      `);
      expect(value).toBe(1);
    },
  );

  it.each(["BigInt64Array", "BigUint64Array"])(
    "%s.prototype method value read folds arity like the non-bigint views",
    async (view) => {
      const value = await runStandalone(`
        export function run(): number {
          const n: any = ${view}.prototype.map.length;
          return n;
        }
      `);
      expect(value).toBe(1);
    },
  );
});
