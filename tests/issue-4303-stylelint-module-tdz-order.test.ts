// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Stylelint reaches three css-tree modules that all declare `noop`: two
// module-level const function expressions and one function declaration. The
// compiler's compatibility maps are still keyed by the bare name, so the last
// const declaration can see the first declaration's module global while the
// function declaration shadows registration of its own value observation.
// Attaching the shared TDZ flag to that non-owning declaration made Program
// ABI planning abort with "TDZ global noop was observed before its value
// global". This is the reduced source ordering from the real package graph.

import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";

describe("#4303 — module TDZ globals follow their exact value owner", () => {
  it("keeps colliding const/function declarations from stealing the TDZ observation", async () => {
    const result = await compileMulti(
      {
        "./first.ts": `
          const noop = function() {};
          export function first(): void { noop(); }
        `,
        "./middle.ts": `
          function noop() {}
          export function middle(): void { noop(); }
        `,
        "./last.ts": `
          const noop = function() {};
          export function last(): void { noop(); }
        `,
        "./entry.ts": `
          import "./first";
          import "./middle";
          import "./last";
          export function run(): number { return 42; }
        `,
      },
      "./entry.ts",
      { target: "gc", skipSemanticDiagnostics: true, emitWat: true },
    );

    const errors = result.errors.map((error) => error.message);
    expect(errors.filter((message) => message.includes("was observed before its value global"))).toEqual([]);
    expect(result.success, errors.join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const valueGlobal = result.wat.indexOf("(global $__mod_noop");
    const tdzGlobal = result.wat.indexOf("(global $__tdz_noop");
    expect(valueGlobal).toBeGreaterThanOrEqual(0);
    expect(tdzGlobal).toBeGreaterThan(valueGlobal);

    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
    expect((instance.exports as { run: () => number }).run()).toBe(42);
  });
});
