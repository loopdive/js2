// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

describe("#2856 — inline-small nested-buffer caller containment", () => {
  it("keeps an inlinable result live through for/while nested buffers", async () => {
    const result = await compile(
      `
        function leaf(n: number): number { return n + 1; }

        export function run(n: number): number {
          const scale = leaf(n);
          let total = 0;
          for (let i = 0; i < scale * 3; i += scale) {
            if (i < scale * 2) {
              total += scale;
            }
          }
          let j = 0;
          while (j < scale * 2) {
            total += scale;
            j += scale;
          }
          return total;
        }
      `,
      {
        fileName: "issue-2856-inline-small-buffer-caller.ts",
        experimentalIR: true,
        trackFallbacks: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["leaf", "run"]));
    expect(result.irPostClaimErrors ?? []).toEqual([]);

    const runStart = result.wat.indexOf("  (func $run");
    const nextFunction = result.wat.indexOf("\n  (func $", runStart + 1);
    const runBody = result.wat.slice(runStart, nextFunction < 0 ? result.wat.length : nextFunction);
    // WAT emission uses numeric function indices. The retained direct call is
    // the proof that the nested-buffer caller hit the conservative barrier.
    expect(runBody).toMatch(/\bcall \d+/);

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    const run = instance.exports.run as (n: number) => number;
    for (const n of [0, 2, 5]) expect(run(n)).toBe(4 * (n + 1));
  });
});
