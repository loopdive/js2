// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

describe("#1058 reserved sibling capture ABI", () => {
  it("keeps a Phase-0 capture layout after an earlier sibling promotes part of it", async () => {
    const result = await compile(
      `
        export function repro(keep: number, a: number, b: number, c: number): number {
          function early(): number {
            [1].map(target);
            return keep;
          }

          function target(value: number): number {
            return value + keep + a + b + c;
          }

          return [5].map(target)[0];
        }
      `,
      { target: "standalone", fileName: "issue-1058-reserved-sibling-capture-abi.ts" },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.repro as (keep: number, a: number, b: number, c: number) => number)(1, 2, 3, 4)).toBe(15);
  });

  it("keeps one live cell and TDZ flag across direct and first-class calls", async () => {
    const result = await compile(
      `
        export function reproMutable(keep: number): number {
          let a = 3;

          function early(): number {
            [1].map(target);
            return keep;
          }

          function target(value: number): number {
            a += value;
            return keep + a;
          }

          const before = early();
          const direct = target(2);
          const firstClass = [3].map(target)[0];
          return before * 1000 + direct * 100 + firstClass * 10 + a;
        }
      `,
      { target: "standalone", fileName: "issue-1058-reserved-sibling-capture-abi-mutable.ts" },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.reproMutable as (keep: number) => number)(1)).toBe(1809);
  });

  it("accepts a branded boolean in a physically shared i32 ref cell", async () => {
    const result = await compile(
      `
        export function reproBooleanCell(keep: number): number {
          let seedValue = 1;
          let flag = true;

          function seed(): number {
            return seedValue;
          }

          function early(): number {
            [true].map(target);
            return keep + seed();
          }

          function target(_value: boolean): number {
            flag = !flag;
            return flag ? keep : 0;
          }

          early();
          return target(true) ? 1 : 0;
        }
      `,
      { target: "standalone", fileName: "issue-1058-reserved-sibling-capture-abi-boolean.ts" },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.reproBooleanCell as (keep: number) => number)(1)).toBe(1);
  });
});
