// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

describe("#3520 binding-aware callable preregistration", () => {
  it("does not treat source-unit lookalikes as intrinsic or runtime providers", async () => {
    const result = await compile(
      `
        export function __ir_str_compare(value: number): number { return value + 1; }
        export function __jsstr_charCodeAt(value: number): number { return value + 2; }
        export function __box_number(value: number): number { return value + 3; }
        export function __extern_is_undefined(value: number): number { return value + 4; }

        export function run(value: number): number {
          return __ir_str_compare(value) + __jsstr_charCodeAt(value) +
            __box_number(value) + __extern_is_undefined(value);
        }
      `,
      { experimentalIR: true, trackIrOutcomes: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(new Set(result.irCompiledFuncs)).toEqual(
      new Set(["__ir_str_compare", "__jsstr_charCodeAt", "__box_number", "__extern_is_undefined", "run"]),
    );
    expect(
      result.imports.filter((entry) =>
        ["__box_number", "__extern_is_undefined", "concat", "equals", "length", "string_compare"].includes(entry.name),
      ),
    ).toEqual([]);

    const { instance } = await WebAssembly.instantiate(
      result.binary,
      buildImports(result.imports, undefined, result.stringPool),
    );
    expect((instance.exports.run as (value: number) => number)(5)).toBe(30);
  });
});
