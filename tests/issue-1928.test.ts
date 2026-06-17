// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1928 — source-position remapping for pre-parse rewrites.
//
// Diagnostics were computed against the REWRITTEN source (timer shim prepended,
// imports replaced by `declare` stubs, CJS `require` rewritten, `define`
// substitutions), so reported line numbers were wrong — off by the prepended
// shim's line count, etc. A composed `PositionMap` now maps the diagnostic
// offset back to the user's original source before the line/column is computed.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { PositionMap } from "../src/position-map.js";

async function errorLines(
  source: string,
  opts: Record<string, unknown> = {},
): Promise<Array<{ line: number; column: number }>> {
  const r = await compile(source, { fileName: "t.ts", ...opts });
  return r.errors.filter((e) => e.severity === "error").map((e) => ({ line: e.line, column: e.column }));
}

describe("#1928 — PositionMap", () => {
  it("identity map leaves offsets unchanged", () => {
    const m = PositionMap.identity();
    expect(m.isIdentity).toBe(true);
    expect(m.toInputOffset(0)).toBe(0);
    expect(m.toInputOffset(42)).toBe(42);
  });

  it("a pure prepend shifts every output offset back by its length", () => {
    // Prepend 10 chars: output offset N (≥10) maps to input N−10.
    const m = new PositionMap([{ origStart: 0, origEnd: 0, newLength: 10 }]);
    expect(m.toInputOffset(10)).toBe(0);
    expect(m.toInputOffset(25)).toBe(15);
  });

  it("a replaced span anchors interior offsets at the original span start", () => {
    // Replace input [5,8) (len 3) with 9 chars of output.
    const m = new PositionMap([{ origStart: 5, origEnd: 8, newLength: 9 }]);
    expect(m.toInputOffset(4)).toBe(4); // before edit — unchanged
    expect(m.toInputOffset(5)).toBe(5); // at the replacement start
    expect(m.toInputOffset(10)).toBe(5); // inside replacement → anchored at orig start
    expect(m.toInputOffset(14)).toBe(8); // first output offset past the replacement
    expect(m.toInputOffset(20)).toBe(14); // after edit: 20 − (9−3) = 14
  });

  it("composition chains output → original across two stages", () => {
    // inner: prepend 4 chars (origStart 0). outer: prepend 6 chars on inner's output.
    const inner = new PositionMap([{ origStart: 0, origEnd: 0, newLength: 4 }]);
    const outer = new PositionMap([{ origStart: 0, origEnd: 0, newLength: 6 }]);
    const composed = outer.compose(inner);
    // Final output offset 10 → outer back to 4 → inner back to 0.
    expect(composed.toInputOffset(10)).toBe(0);
    expect(composed.toInputOffset(20)).toBe(10);
  });
});

describe("#1928 — diagnostic positions match the user's source under each rewrite", () => {
  it("timer-shim prepend: type error reports the user's line", async () => {
    const errs = await errorLines(
      [
        "export function f(): number {",
        "  setTimeout(() => {}, 100);",
        '  const x: number = "nope";',
        "  return x;",
        "}",
      ].join("\n"),
    );
    expect(errs).toContainEqual({ line: 3, column: 9 });
  });

  it("import-stub replacement: type error reports the user's line", async () => {
    const errs = await errorLines(
      [
        'import { foo } from "./mod";',
        "export function h(): number {",
        "  foo();",
        '  const z: number = "nope";',
        "  return z;",
        "}",
      ].join("\n"),
    );
    expect(errs).toContainEqual({ line: 4, column: 9 });
  });

  it("CJS require rewrite: type error reports the user's line", async () => {
    const errs = await errorLines(
      [
        'const lib = require("./lib");',
        "export function c(): number {",
        "  lib.use();",
        '  const q: number = "nope";',
        "  return q;",
        "}",
      ].join("\n"),
    );
    expect(errs).toContainEqual({ line: 4, column: 9 });
  });

  it("define substitution: type error reports the user's line", async () => {
    const errs = await errorLines(
      [
        "export function d(): number {",
        "  const env = process.env.NODE_ENV;",
        '  const w: number = "nope";',
        "  return w;",
        "}",
      ].join("\n"),
      { define: { "process.env.NODE_ENV": '"production"' } },
    );
    expect(errs).toContainEqual({ line: 3, column: 9 });
  });

  it("combined timer-shim + import: type error reports the user's line", async () => {
    const errs = await errorLines(
      [
        'import { bar } from "./bar";',
        "export function m(): number {",
        "  setTimeout(() => bar(), 1);",
        "  bar();",
        '  const r: number = "nope";',
        "  return r;",
        "}",
      ].join("\n"),
    );
    expect(errs).toContainEqual({ line: 5, column: 9 });
  });

  it("no rewrite fires: positions are exact (control)", async () => {
    const errs = await errorLines(
      ["export function g(): number {", '  const y: number = "nope";', "  return y;", "}"].join("\n"),
    );
    expect(errs).toContainEqual({ line: 2, column: 9 });
  });
});
