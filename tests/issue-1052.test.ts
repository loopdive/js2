import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type ImportInjector = (imports: any) => void;

async function runExprWithHost(src: string, inject?: ImportInjector): Promise<number> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool) as any;
  if (inject) inject(imports);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (typeof imports.setExports === "function") imports.setExports(instance.exports);
  return (instance.exports as any).test();
}

describe("#1052 array destructuring honors Symbol.iterator protocol", () => {
  it("destructures a custom iterable via [Symbol.iterator]", async () => {
    const src = `
      declare function makeIter(): any;
      export function test(): number {
        const arr: any = makeIter();
        const [a, b, c] = arr;
        return (a === 10 && b === 20 && c === 30) ? 1 : 0;
      }
    `;
    const v = await runExprWithHost(src, (imports) => {
      imports.env.makeIter = () => ({
        [Symbol.iterator]() {
          let i = 0;
          return {
            next() {
              i++;
              if (i === 1) return { value: 10, done: false };
              if (i === 2) return { value: 20, done: false };
              if (i === 3) return { value: 30, done: false };
              return { value: undefined, done: true };
            },
          };
        },
      });
    });
    expect(v).toBe(1);
  });

  it("destructures a plain JS array via the iterator protocol", async () => {
    const src = `
      declare function getArr(): any;
      export function test(): number {
        const a: any = getArr();
        const [x, y, z] = a;
        return (x === 1 && y === 2 && z === 3) ? 1 : 0;
      }
    `;
    const v = await runExprWithHost(src, (imports) => {
      imports.env.getArr = () => [1, 2, 3];
    });
    expect(v).toBe(1);
  });

  it("handles default, omitted slot, and rest element on an iterator source", async () => {
    const src = `
      declare function getArr(): any;
      export function test(): number {
        const a: any = getArr();
        const [x, , z = 99, ...rest] = a;
        return (x === 1 && z === 3 && (rest as any).length === 2) ? 1 : 0;
      }
    `;
    const v = await runExprWithHost(src, (imports) => {
      imports.env.getArr = () => [1, 2, 3, 4, 5];
    });
    expect(v).toBe(1);
  });

  it("default fires when iterator yields undefined for that slot", async () => {
    const src = `
      declare function makeIter(): any;
      export function test(): number {
        const arr: any = makeIter();
        const [a = 100, b = 200] = arr;
        return (a === 10 && b === 200) ? 1 : 0;
      }
    `;
    const v = await runExprWithHost(src, (imports) => {
      imports.env.makeIter = () => ({
        [Symbol.iterator]() {
          let i = 0;
          return {
            next() {
              i++;
              if (i === 1) return { value: 10, done: false };
              return { value: undefined, done: true };
            },
          };
        },
      });
    });
    expect(v).toBe(1);
  });
});
