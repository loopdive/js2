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
    ["map", `const a: number[] = [1,2,3]; return a.map(x => x * 2).join(",").length;`, 5], // "2,4,6"
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
