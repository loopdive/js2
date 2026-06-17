import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #2130 — `in` / `hasOwnProperty` must consult the runtime delete tombstone, not
// just the static struct shape. Stage A (this PR) fixes the presence-predicate
// half: `in` and `Object.prototype.hasOwnProperty` now route through a single
// tombstone-aware own-property predicate (`_wasmStructHasOwn`), and the buggy
// module-global `__sget_<key>` existence probe in `__extern_has` is removed.
//
// The read half (`delete o.a; o.a === undefined` for a statically-resolvable
// struct receiver) is the architect's deferred A6/A7 follow-up — that read uses
// an inline `struct.get` fast-path which bypasses the tombstone, and the fix
// requires representation steering to stay sound in standalone mode.

async function run(source: string, fn: string): Promise<unknown> {
  const result = await compile(source, {});
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
  return (instance.exports as any)[fn]();
}

describe("#2130 — `in` / hasOwnProperty consult the delete tombstone", () => {
  it("`in` returns false after delete o.prop", async () => {
    expect(
      await run(
        `export function test(): number {
          const o: any = { a: 1, b: 2 };
          delete o.a;
          return ("a" in o) ? 0 : 1;
        }`,
        "test",
      ),
    ).toBe(1);
  });

  it("`in` stays true for a sibling property after delete", async () => {
    expect(
      await run(
        `export function test(): number {
          const o: any = { a: 1, b: 2 };
          delete o.a;
          return ("b" in o) ? 1 : 0;
        }`,
        "test",
      ),
    ).toBe(1);
  });

  it("dynamic-key `in` returns false after delete o[k]", async () => {
    expect(
      await run(
        `export function test(): number {
          const o: any = { a: 1, b: 2 };
          const k = "a";
          delete o[k];
          return ("a" in o) ? 0 : 1;
        }`,
        "test",
      ),
    ).toBe(1);
  });

  it("object-rest: `in` answers against the rest object's own shape, not the source", async () => {
    expect(
      await run(
        `export function test(): number {
          const { e, ...rest } = { e: 3, f: 4 };
          const r = rest as any;
          const hasE = ("e" in r) ? 1 : 0;
          const hasF = ("f" in r) ? 1 : 0;
          return (hasE === 0 && hasF === 1) ? 1 : 0;
        }`,
        "test",
      ),
    ).toBe(1);
  });

  it("hasOwnProperty returns false after delete (shares the predicate with `in`)", async () => {
    expect(
      await run(
        `export function test(): number {
          const o: any = { a: 1, b: 2 };
          delete o.a;
          const oo = o as any;
          return oo.hasOwnProperty("a") ? 0 : 1;
        }`,
        "test",
      ),
    ).toBe(1);
  });

  it("delete then re-add makes `in` true again", async () => {
    expect(
      await run(
        `export function test(): number {
          const o: any = { a: 1 };
          delete o.a;
          o.a = 5;
          return ("a" in o) ? 1 : 0;
        }`,
        "test",
      ),
    ).toBe(1);
  });

  it('HasProperty is value-independent: `o.x = undefined; "x" in o` is true', async () => {
    expect(
      await run(
        `export function test(): number {
          const o: any = {};
          o.x = undefined;
          return ("x" in o) ? 1 : 0;
        }`,
        "test",
      ),
    ).toBe(1);
  });
});
