// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2061 — finally clone inlined at the wrong branch depth.
//
// The finally body is compiled once with break/continue depths bumped by +1
// (the try frame) and CLONED into every abrupt-completion site
// (return/break/continue inside the try). When the abrupt site sits DEEPER than
// the try frame — inside an `if`/`switch`/inner-`try` within the try block —
// any `br` in the clone that targets an OUTER label is short by the extra
// nesting: a `break`/`continue` in the finally lands on the wrong block. The
// fix records the break/continue depth baseline on each finallyStack entry and
// routes every inline through `cloneFinallyAtDepth(delta)` with the
// site-computed delta (control-flow.ts `finallyInlineDelta`).
//
// `assertEquivalent` runs the source as JS and compares the wasm result, and
// also runs `WebAssembly.validate()` on the binary, so an out-of-range branch
// depth fails loudly too.
import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

describe("#2061 finally clone branch depth", () => {
  it("return nested one level inside try, finally break (repro t1)", { timeout: 15000 }, async () => {
    await assertEquivalent(
      `export function t1(): number {
        let r = 0;
        while (true) {
          r = r + 1;
          try { if (r === 1) { return 100; } } finally { break; }
        }
        return r;
      }`,
      [{ fn: "t1", args: [] }],
    );
  });

  it("nested try + if, two finally levels (repro nestedFinallyBreak)", { timeout: 15000 }, async () => {
    await assertEquivalent(
      `export function nestedFinallyBreak(): number {
        let log = 0;
        while (true) {
          try { try { if (log === 0) { log = 1; return 100; } } finally { log = log*10 + 2; } }
          finally { break; }
        }
        return log;
      }`,
      [{ fn: "nestedFinallyBreak", args: [] }],
    );
  });

  it("return three ifs deep, finally labeled break outer", { timeout: 15000 }, async () => {
    await assertEquivalent(
      `export function deepNest(): number {
        let r = 0;
        outer: while (true) {
          r = r + 1;
          try {
            if (r > 0) { if (r > 0) { if (r === 1) { return 100; } } }
          } finally { break outer; }
        }
        return r;
      }`,
      [{ fn: "deepNest", args: [] }],
    );
  });

  it("continue in finally, abrupt site nested in if", { timeout: 15000 }, async () => {
    await assertEquivalent(
      `export function contInFinally(): number {
        let r = 0; let n = 0;
        while (n < 3) {
          n = n + 1;
          try { if (n === 1) { continue; } r = r + 10; }
          finally { if (n === 2) { continue; } r = r + 1; }
        }
        return r;
      }`,
      [{ fn: "contInFinally", args: [] }],
    );
  });

  // Matrix: abrupt site at nesting depth 2 (two ifs) × finally containing
  // continue outer × labeled for-loop.
  it("matrix: return at depth 2 + finally continue outer", { timeout: 15000 }, async () => {
    await assertEquivalent(
      `export function m(n: number): number {
        let acc = 0;
        outer: for (let i = 0; i < 4; i++) {
          try {
            if (i >= 0) {
              if (i === n) { return acc * 100 + i; }
            }
            acc = acc + 1;
          } finally {
            if (i === 2) { continue outer; }
            acc = acc + 10;
          }
          acc = acc + 1000;
        }
        return acc;
      }`,
      [
        { fn: "m", args: [0] },
        { fn: "m", args: [1] },
        { fn: "m", args: [3] },
        { fn: "m", args: [9] },
      ],
    );
  });

  // break inside a switch inside the try (switch adds a label level too).
  it("break in finally, abrupt site inside switch in try", { timeout: 15000 }, async () => {
    await assertEquivalent(
      `export function sw(n: number): number {
        let r = 0;
        loop: while (true) {
          r = r + 1;
          try {
            switch (n) {
              case 1: { if (r === 1) { return 100; } break; }
              default: { break; }
            }
            r = r + 1000;
          } finally { break loop; }
        }
        return r;
      }`,
      [
        { fn: "sw", args: [1] },
        { fn: "sw", args: [2] },
      ],
    );
  });
});
