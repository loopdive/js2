// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it, vi } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

import * as pass from "../src/ir/passes/inline-small.js";
import { forEachNestedBuffer, type IrModule } from "../src/ir/core/nodes.js";
afterEach(() => vi.restoreAllMocks());

describe("#2856 — inline-small nested-buffer caller containment", () => {
  it("keeps an inlinable result live through for/while nested buffers", async () => {
    const observed: { before: IrModule; after: IrModule }[] = [];
    const original = pass.inlineSmall;
    const spy = vi.spyOn(pass, "inlineSmall").mockImplementation((module, registry) => {
      const after = original(module, registry);
      observed.push({ before: module, after });
      return after;
    });
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
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const binary = Uint8Array.from(result.binary);
    expect(WebAssembly.validate(binary)).toBe(true);
    expect(result.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["leaf", "run"]));
    expect(result.irPostClaimErrors ?? []).toEqual([]);

    spy.mockRestore();
    expect(observed.length).toBeGreaterThan(0);
    const pair = observed.find((row) => row.before.functions.some((fn) => fn.name === "run"));
    expect(pair).toBeDefined();
    const before = pair!.before.functions.find((fn) => fn.name === "run")!;
    const after = pair!.after.functions.find((fn) => fn.unitId === before.unitId)!;
    const leaf = pair!.before.functions.find((fn) => fn.name === "leaf")!;
    expect(leaf).toBeDefined();
    expect(
      before.blocks
        .flatMap((b) => b.instrs)
        .some(
          (instr) =>
            instr.kind === "call" &&
            instr.target.binding.kind === "unit" &&
            instr.target.binding.unitId === leaf.unitId,
        ),
    ).toBe(true);
    let nested = 0;
    for (const block of before.blocks) for (const instr of block.instrs) forEachNestedBuffer(instr, () => nested++);
    expect(nested).toBeGreaterThan(0);
    expect(after).toBe(before);
    // Observe the IR barrier directly: a later physical optimizer may inline
    // the lowered call without moving SSA definitions between nested buffers.

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(binary, {
      env: imports.env,
      "wasm:js-string": imports["wasm:js-string"],
      string_constants: imports.string_constants,
      string_constants16: imports.string_constants16,
    });
    imports.setExports?.(instance.exports as Record<string, Function>);
    const run = instance.exports.run as (n: number) => number;
    for (const n of [0, 2, 5]) expect(run(n)).toBe(4 * (n + 1));
  });
});
