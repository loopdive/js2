import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2074 / #2075 — standalone (native-strings) `Array.prototype.join`.
 *
 * `["x","y"].join(";")` trapped a null deref and numeric/vec receivers leaked
 * `__array_join_any` / `__get_undefined` host imports, so a `--target standalone`
 * module either failed to instantiate (needs `env`) or trapped. The native vec
 * join now concatenates with `__str_concat` + native string literals, so the
 * common shapes run with ZERO imports.
 *
 * These assert behavior: correct value, zero env imports, valid Wasm.
 */
function envImports(imports: ReadonlyArray<{ module: string; name: string }>): string[] {
  return imports.filter((i) => i.module === "env").map((i) => i.name);
}

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const leaked = envImports(r.imports);
  expect(leaked, `--target standalone leaked env imports: ${leaked.join(", ")}`).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

describe("#2074 — standalone string[] join (zero host imports)", () => {
  it('["x","y"].join(";") === "x;y"', async () => {
    // length 3, then verify the separator char and first element char.
    expect(
      await runStandalone(
        `export function run(): number { const a: string[] = ["x","y"]; return a.join(";").length; }`,
      ),
    ).toBe(3);
    expect(
      await runStandalone(
        `export function run(): number { const a: string[] = ["x","y"]; return "x;y".charCodeAt(1); }`,
      ),
    ).toBe(59); // ';'
  });

  it("split(...).join(...) round-trips", async () => {
    expect(await runStandalone(`export function run(): number { return "a,b".split(",").join(";").length; }`)).toBe(3);
  });

  it("number[] join coerces each element", async () => {
    // "1,2,3" → length 5
    expect(
      await runStandalone(`export function run(): number { const a: number[] = [1,2,3]; return a.join(",").length; }`),
    ).toBe(5);
    // first char '1' = 49
    expect(
      await runStandalone(
        `export function run(): number { const a: number[] = [1,2,3]; return a.join(",").charCodeAt(0); }`,
      ),
    ).toBe(49);
  });

  it("default separator is ','", async () => {
    // "a,b,c" → length 5
    expect(
      await runStandalone(
        `export function run(): number { const a: string[] = ["a","b","c"]; return a.join().length; }`,
      ),
    ).toBe(5);
  });

  it("float / -0 / NaN elements stringify per spec", async () => {
    // "1.5,0,NaN" → length 9
    expect(await runStandalone(`export function run(): number { return [1.5, -0, NaN].join(",").length; }`)).toBe(9);
  });
});

describe("#2075 — vec-shaped receivers join with zero imports (collateral probe shapes)", () => {
  const cases: Array<[string, string, number]> = [
    ["slice", `const a: number[] = [1,2,3,4]; return a.slice(1,3).join(",").length;`, 3], // "2,3"
    ["spread", `const a: number[] = [1,2,3]; return [...a].join(",").length;`, 5], // "1,2,3"
    ["push-pop", `const a: number[] = [1,2]; a.push(3); a.pop(); return a.join(",").length;`, 3], // "1,2"
    ["shift", `const a: number[] = [1,2,3]; a.shift(); return a.join(",").length;`, 3], // "2,3"
    ["reverse", `const a: number[] = [1,2,3]; a.reverse(); return a.join(",").length;`, 5], // "3,2,1"
    ["length-trunc", `const a: number[] = [1,2,3,4]; a.length = 2; return a.join(",").length;`, 3], // "1,2"
    ["concat", `const a: number[] = [1,2]; const b: number[] = [3]; return a.concat(b).join(",").length;`, 5], // "1,2,3"
  ];
  for (const [name, body, expected] of cases) {
    it(`${name}().join() runs standalone`, async () => {
      expect(await runStandalone(`export function run(): number { ${body} }`)).toBe(expected);
    });
  }
});

describe("#2074 residual — externref-element (any[] / empty / boxed-any) join is valid + correct", () => {
  // Pre-#2074-residual these emitted an INVALID module:
  //   "local.set[0] expected (ref null 6), found ref.as_non_null of (ref extern)".
  // The else-branch assumed a `(ref null $NativeString)` element and `ref.as_non_null`'d
  // it — but an externref-element vec (untyped `[]`, `any[]`, boxed-any) is not a
  // native string. Now each element is stringified via the native `__extern_toString`
  // (§7.1.17), the SAME ToString `String(x)` uses, so boxed-NUMBER elements recover to
  // their numeric text rather than "[object Object]". These assert validity + correctness.
  const cases: Array<[string, string, number]> = [
    // Empty untyped array → "" (length 0). Was the headline invalid-Wasm case
    // (`new Array()` / `[]` + join, test262 join/S15.4.4.5_A1.1_T1).
    ["empty any[]", `const a: any[] = []; return a.join(",").length;`, 0],
    // any[] numeric elements stringify per ToString — "1,2,3" length 5 (NOT
    // "[object Object]…" which the $AnyValue tag-dispatcher produced for the
    // join-fed boxed-number element).
    ["any[] numeric", `const a: any[] = [1,2,3]; return a.join(",").length;`, 5],
    ["any[] numeric first char", `const a: any[] = [1,2,3]; return a.join(",").charCodeAt(0);`, 49], // '1'
    // any[] string elements still correct.
    ["any[] string", `const a: any[] = ["x","y"]; return a.join(",").length;`, 3], // "x,y"
    ["any[] string first char", `const a: any[] = ["x","y"]; return a.join(",").charCodeAt(0);`, 120], // 'x'
    // Empty-array join with explicit separator is still "".
    ["empty + sep", `const a: any[] = []; return a.join("-").length;`, 0],
    // Array.prototype.toString delegates to join (§23.1.3.36) through the same
    // native fold, so it gets the externref-element fix for free.
    ["any[] numeric toString", `const a: any[] = [1,2,3]; return a.toString().length;`, 5], // "1,2,3"
    ["any[] numeric toString first char", `const a: any[] = [1,2,3]; return a.toString().charCodeAt(0);`, 49], // '1'
    ["empty any[] toString", `const a: any[] = []; return a.toString().length;`, 0],
  ];
  for (const [name, body, expected] of cases) {
    it(`${name}`, async () => {
      expect(await runStandalone(`export function run(): number { ${body} }`)).toBe(expected);
    });
  }
});
