import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const BANNED_STANDALONE_IMPORTS = [
  /^env::__get_builtin$/,
  /^env::__extern_/,
  /^env::__object_/,
  /^env::__new_plain_object$/,
  /^env::global_/,
];

function assertNoStandaloneObjectImports(imports: ReadonlyArray<{ module: string; name: string }>): void {
  const labels = imports.map((i) => `${i.module}::${i.name}`);
  for (const re of BANNED_STANDALONE_IMPORTS) {
    const hits = labels.filter((label) => re.test(label));
    expect(hits, `standalone leaked ${re}: ${hits.join(", ")}`).toEqual([]);
  }
}

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  assertNoStandaloneObjectImports(r.imports);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

describe("#1888 standalone open-any method dispatch", () => {
  it("passes boxed any arguments through 2-4 arg method closures", async () => {
    const value = await runStandalone(`
      export function run(): number {
        const o: any = {};
        o["two"] = (a: any, b: any) => a + b;
        o["three"] = (a: any, b: any, c: any) => a + b + c;
        o["four"] = (a: any, b: any, c: any, d: any) => a + b + c + d;
        return o.two(2, 3) + o.three(1, 2, 4) + o.four(1, 2, 3, 4);
      }
    `);
    expect(value).toBe(22);
  });
});

describe("#1888 S6 — standalone built-in static globals", () => {
  it("Array.isArray read as a function value stays host-free", async () => {
    const value = await runStandalone(`
      export function run(): number {
        const f = Array.isArray;
        return f([1]) ? 1 : 0;
      }
    `);
    expect(value).toBe(1);
  });

  it("Array namespace read as a value exposes isArray through the open-object vtable", async () => {
    const value = await runStandalone(`
      export function run(): number {
        const C = Array;
        return C.isArray([1]) ? 1 : 0;
      }
    `);
    expect(value).toBe(1);
  });

  it("Object.keys read as an any function value applies to an open object", async () => {
    const value = await runStandalone(`
      export function run(): number {
        const keys: any = Object.keys;
        const o: any = {};
        o["a"] = 1;
        o["b"] = 2;
        return keys(o).length;
      }
    `);
    expect(value).toBe(2);
  });

  it("Object namespace read as a value exposes keys through the open-object vtable", async () => {
    const value = await runStandalone(`
      export function run(): number {
        const O: any = Object;
        const o: any = {};
        o["x"] = 1;
        return O.keys(o).length;
      }
    `);
    expect(value).toBe(1);
  });

  it("unsupported built-in static value reads refuse loud with a #1888 cite", async () => {
    const r = await compile(
      `
        export function run(): number {
          const f: any = Array.from;
          return f([1]).length;
        }
      `,
      { target: "standalone" },
    );
    expect(r.success).toBe(false);
    expect(r.errors.map((e) => e.message).join("\n")).toMatch(/#1888 S6/);
    assertNoStandaloneObjectImports(r.imports);
  });
});
