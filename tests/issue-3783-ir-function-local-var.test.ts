// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3783 — function-local `var` adoption. The selector proves that every
// accepted binding is observationally equivalent to the IR's lexical
// local/slot representation before the function is claimed.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { planIrCompilation } from "../src/ir/select.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";

function selectionFor(source: string): ReturnType<typeof planIrCompilation> {
  const sourceFile = ts.createSourceFile("var.ts", source, ts.ScriptTarget.Latest, true);
  return planIrCompilation(sourceFile, { experimentalIR: true, trackFallbacks: true });
}

async function compileNumberExport(
  source: string,
  exportName: string,
): Promise<{ fn: (...args: number[]) => number; emitted: ReadonlySet<string> }> {
  const result = await compile(source, {
    fileName: "var.ts",
    experimentalIR: true,
    trackIrOutcomes: true,
  });
  if (!result.success) throw new Error(result.errors.map((error) => error.message).join("\n"));
  const imports = buildImports(result.imports as never, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as never);
  if (typeof (imports as { setExports?: (exports: unknown) => void }).setExports === "function") {
    (imports as { setExports: (exports: unknown) => void }).setExports(instance.exports);
  }
  return {
    fn: (instance.exports as Record<string, (...args: number[]) => number>)[exportName]!,
    emitted: new Set(
      (result.irOutcomes ?? []).filter((outcome) => outcome.kind === "emitted").map((outcome) => outcome.displayName),
    ),
  };
}

describe("#3783 — selector proof for function-local var", () => {
  it("accepts initialized body, nested-block, and for-head bindings", () => {
    const body = selectionFor(`
      export function body(n: number): number {
        var value = n + 1;
        return value;
      }
    `);
    expect(body.funcs.has("body")).toBe(true);

    const nested = selectionFor(`
      export function nested(flag: boolean): number {
        if (flag) {
          var yes = 7;
          return yes;
        } else {
          var no = 9;
          return no;
        }
      }
    `);
    expect(nested.funcs.has("nested")).toBe(true);

    const loop = selectionFor(`
      export function sum(n: number): number {
        var total = 0;
        for (var i = 0; i < n; i++) {
          total += i;
        }
        return total;
      }
    `);
    expect(loop.funcs.has("sum")).toBe(true);
  });

  it("rejects hoisting, redeclaration, scope escape, missing init, and capture", () => {
    const cases = [
      `
        export function before(): number {
          var value = later;
          var later = 1;
          return value;
        }
      `,
      `
        export function duplicate(): number {
          var value = 1;
          var value = 2;
          return value;
        }
      `,
      `
        export function blockEscape(flag: boolean): number {
          if (flag) {
            var value = 1;
          }
          return value;
        }
      `,
      `
        export function loopEscape(n: number): number {
          for (var i = 0; i < n; i++) {
            n += 0;
          }
          return i;
        }
      `,
      `
        export function missing(): number {
          var value;
          return value;
        }
      `,
      `
        export function captured(): number {
          var value = 1;
          const read = (): number => value;
          return read();
        }
      `,
    ];
    for (const source of cases) {
      const selection = selectionFor(source);
      expect(selection.funcs.size).toBe(0);
      expect(selection.fallbacks?.[0]?.reason).toBe("body-shape-rejected");
    }
  });

  it("keeps module-init var storage on the direct path", () => {
    const selection = selectionFor(`
      var value = 1;
      export function read(): number {
        return value;
      }
    `);
    expect(selection.moduleInit?.reason).toBe("body-shape-rejected");
  });

  it("keeps for-of consumers outside the first var slice", () => {
    const selection = selectionFor(`
      function* values(): Generator<number> {
        yield 1;
        return 2;
      }
      export function sum(): number {
        var total = 0;
        for (const value of values()) {
          total += value;
        }
        return total;
      }
    `);
    expect(selection.funcs.has("sum")).toBe(false);
  });
});

describe("#3783 — function-local var execution", () => {
  it("executes body and loop-carried bindings through IR", async () => {
    const { fn, emitted } = await compileNumberExport(
      `
        export function sum(n: number): number {
          var total = 0;
          for (var i = 0; i < n; i++) {
            total += i;
          }
          return total;
        }
      `,
      "sum",
    );
    expect(emitted.has("sum")).toBe(true);
    expect(fn(0)).toBe(0);
    expect(fn(1)).toBe(0);
    expect(fn(8)).toBe(28);
  });

  it("executes branch-local declarations through IR", async () => {
    const { fn, emitted } = await compileNumberExport(
      `
        export function choose(flag: boolean): number {
          if (flag) {
            var yes = 7;
            return yes;
          } else {
            var no = 9;
            return no;
          }
        }
      `,
      "choose",
    );
    expect(emitted.has("choose")).toBe(true);
    expect(fn(1)).toBe(7);
    expect(fn(0)).toBe(9);
  });
});
