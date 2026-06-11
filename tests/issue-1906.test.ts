// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const DEFINE_PROPERTIES_IMPORTS = /^env::__definePropert/;

function assertNoDefinePropertiesHostImports(imports: ReadonlyArray<{ module: string; name: string }>): void {
  const labels = imports.map((i) => `${i.module}::${i.name}`);
  const hits = labels.filter((label) => DEFINE_PROPERTIES_IMPORTS.test(label));
  expect(hits, `--target standalone leaked ${hits.join(", ")}`).toEqual([]);
}

async function run(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  assertNoDefinePropertiesHostImports(r.imports);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

describe("#1906 — native Object.defineProperties over $Object descriptors", () => {
  it("applies a computed-key $Object data descriptor map without a host import", async () => {
    expect(
      await run(`
        export function run(): number {
          const o: any = {};
          const descriptors: any = {};
          const a: any = {};
          const valueKey = "value";
          const enumerableKey = "enumerable";
          const configurableKey = "configurable";
          const writableKey = "writable";
          a[valueKey] = 40;
          a[enumerableKey] = true;
          a[configurableKey] = true;
          a[writableKey] = true;
          const b: any = {};
          b[valueKey] = 2;
          b[enumerableKey] = true;
          const aKey = "a";
          const bKey = "b";
          descriptors[aKey] = a;
          descriptors[bKey] = b;
          Object.defineProperties(o, descriptors);
          return (o.a as number) + (o.b as number);
        }
      `),
    ).toBe(42);
  });

  it("applies a computed-key $Object accessor descriptor map", async () => {
    expect(
      await run(`
        export function run(): number {
          const o: any = {};
          const descriptors: any = {};
          const p: any = {};
          const getKey = "get";
          const enumerableKey = "enumerable";
          const configurableKey = "configurable";
          p[getKey] = function() { return 42; };
          p[enumerableKey] = true;
          p[configurableKey] = true;
          const propKey = "p";
          descriptors[propKey] = p;
          Object.defineProperties(o, descriptors);
          return o.p as number;
        }
      `),
    ).toBe(42);
  });

  it("validates all descriptors before applying a later primitive descriptor", async () => {
    expect(
      await run(`
        export function run(): number {
          const o: any = {};
          const descriptors: any = {};
          const a: any = {};
          const valueKey = "value";
          const enumerableKey = "enumerable";
          a[valueKey] = 1;
          a[enumerableKey] = true;
          const aKey = "a";
          const badKey = "bad";
          descriptors[aKey] = a;
          descriptors[badKey] = 5;
          try {
            Object.defineProperties(o, descriptors);
            return 100;
          } catch (e) {
            return Object.hasOwn(o, "a") ? 1 : 0;
          }
        }
      `),
    ).toBe(0);
  });

  it("validates all descriptors before applying a data/accessor conflict", async () => {
    expect(
      await run(`
        export function run(): number {
          const o: any = {};
          const descriptors: any = {};
          const p: any = {};
          const valueKey = "value";
          const getKey = "get";
          p[valueKey] = 1;
          p[getKey] = function() { return 2; };
          const propKey = "p";
          descriptors[propKey] = p;
          try {
            Object.defineProperties(o, descriptors);
            return 100;
          } catch (e) {
            return Object.hasOwn(o, "p") ? 1 : 0;
          }
        }
      `),
    ).toBe(0);
  });
});
