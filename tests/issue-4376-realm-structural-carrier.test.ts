// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.js";

async function instantiate(source: string): Promise<WebAssembly.Exports> {
  const result = await compile(source, { target: "standalone" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return instance.exports;
}

async function instantiateMulti(files: Record<string, string>, entry: string): Promise<WebAssembly.Exports> {
  const result = await compileMulti(files, entry, { target: "standalone" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return instance.exports;
}

describe("#4376 — realm structural-object carrier", () => {
  it("preserves a captured Deno-like object read dynamically from globalThis", async () => {
    const exports = await instantiate(`
      type DenoLike = {
        core: {
          print(message: string): void;
          ops: { op_sum(values: number[]): number };
        };
      };

      let transcript = "";
      const seeded = {
        core: {
          print(message: string): void {
            transcript += message + "|";
          },
          ops: {
            op_sum(values: number[]): number {
              let total = 0;
              for (const value of values) total += value;
              return total;
            },
          },
        },
      };
      (globalThis as any).__denoCarrier = seeded;

      export function test(input: number): number {
        const Deno = (globalThis as any).__denoCarrier as DenoLike;
        function print(value: any): void {
          Deno.core.print(value.toString());
        }
        const values = [input, 2, 3];
        print("The sum of");
        print(values);
        print(Deno.core.ops.op_sum(values));
        return transcript === "The sum of|5,2,3|10|" ? 1 : 0;
      }

      export function closedStructControl(): number {
        const Deno: { core: { value: number } } = { core: { value: 9 } };
        return Deno.core.value;
      }
    `);

    expect((exports.test as (input: number) => number)(5)).toBe(1);
    expect((exports.closedStructControl as () => number)()).toBe(9);
  });

  it("keeps scalar realm reads on their existing unboxing path", async () => {
    const exports = await instantiate(`
      (globalThis as any).__scalarCarrier = 7;
      export function test(): number {
        const value = (globalThis as any).__scalarCarrier as number;
        return value;
      }
    `);
    expect((exports.test as () => number)()).toBe(7);
  });

  it("calls a dynamically installed closure through the asserted structural signature", async () => {
    const exports = await instantiate(`
      type DenoLike = {
        core: {
          print(message: string, isError?: boolean): void;
        };
      };

      let transcript = "";
      function opPrint(message: string, _isError?: boolean): void {
        transcript += message;
      }

      const core: any = {};
      core.print = (message: any, isError: any): void => opPrint(message, isError);
      const deno: any = {};
      deno.core = core;
      (globalThis as any).__dynamicDenoCarrier = deno;

      export function test(input: number): number {
        const Deno = (globalThis as any).__dynamicDenoCarrier as DenoLike;
        Deno.core.print("value=" + input);
        return transcript === "value=7" ? 1 : 0;
      }
    `);

    expect((exports.test as (input: number) => number)(7)).toBe(1);
  });

  it("retains a captured carrier when a nested function shadows globalThis", async () => {
    const exports = await instantiate(`
      type DenoLike = {
        core: {
          value(): number;
        };
      };

      const core: any = {};
      core.value = (...values: any[]): number => values.length === 0 ? 41 : -1;
      const deno: any = {};
      deno.core = core;
      (globalThis as any).__shadowedDenoCarrier = deno;

      export function test(): number {
        const Deno = (globalThis as any).__shadowedDenoCarrier as DenoLike;
        function read(globalThis: DenoLike): number {
          return Deno.core.value();
        }
        return read({ core: { value: (): number => -1 } });
      }
    `);

    expect((exports.test as () => number)()).toBe(41);
  });

  it("preserves the receiver and argument-before-body order for a dynamic carrier method", async () => {
    const exports = await instantiate(`
      type DenoLike = {
        core: {
          base: number;
          combine(value: number): number;
        };
      };

      let order = 0;
      const core: any = {};
      core.base = 40;
      core.combine = function (this: any, value: any): number {
        order = order * 10 + 2;
        return this.base * 100 + value * 10 + order;
      };
      const deno: any = {};
      deno.core = core;
      (globalThis as any).__orderedDenoCarrier = deno;

      function argument(): number {
        order = order * 10 + 1;
        return 3;
      }

      export function test(): number {
        order = 0;
        const Deno = (globalThis as any).__orderedDenoCarrier as DenoLike;
        return Deno.core.combine(argument());
      }
    `);

    // 40 from the original receiver, 3 from the argument, and order 12.
    expect((exports.test as () => number)()).toBe(4042);
  });

  it("reuses the receiver captured by an optional carrier call", async () => {
    const exports = await instantiate(`
      type DenoLike = {
        core?: {
          value(): number;
        };
      };

      let reads = 0;
      const first: any = {};
      first.value = (): number => 10;
      const second: any = {};
      second.value = (): number => 20;
      const deno: any = {};
      Object.defineProperty(deno, "core", {
        get(): any {
          reads++;
          return reads === 1 ? first : second;
        },
      });
      (globalThis as any).__optionalDenoCarrier = deno;

      export function test(): number {
        reads = 0;
        const Deno = (globalThis as any).__optionalDenoCarrier as DenoLike;
        return (Deno.core?.value() ?? -1) * 100 + reads;
      }
    `);

    expect((exports.test as () => number)()).toBe(1001);
  });

  it("keeps nine-argument carrier calls on the typed field route", async () => {
    const exports = await instantiate(`
      type DenoLike = {
        op(
          a: number,
          b: number,
          c: number,
          d: number,
          e: number,
          f: number,
          g: number,
          h: number,
          i: number,
        ): number;
      };

      const deno: any = {};
      deno.op = function (
        a: number,
        b: number,
        c: number,
        d: number,
        e: number,
        f: number,
        g: number,
        h: number,
        i: number,
      ): number {
        return a + b + c + d + e + f + g + h + i;
      };
      (globalThis as any).__wideDenoCarrier = deno;

      export function test(): number {
        const Deno = (globalThis as any).__wideDenoCarrier as DenoLike;
        return Deno.op(1, 2, 3, 4, 5, 6, 7, 8, 9);
      }
    `);

    expect((exports.test as () => number)()).toBe(45);
  });

  it("finalizes Array.isArray over carriers registered by compileMulti", async () => {
    const exports = await instantiateMulti(
      {
        "/entry.ts": `
          import { classify } from "./ops.ts";
          export function test(input: number): number {
            return classify([input, 2, 3]) * 10 + classify(input);
          }
        `,
        "/ops.ts": `
          export function classify(value: unknown): number {
            return Array.isArray(value) ? 1 : 0;
          }
        `,
      },
      "/entry.ts",
    );

    expect((exports.test as (input: number) => number)(7)).toBe(10);
  });
});
