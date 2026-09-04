// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5310 — a for-in receiver that lowers to a closed WasmGC struct enumerated
 * NOTHING in JS-host mode, while standalone enumerated it correctly.
 *
 * WHY the two targets disagreed: `compileForInStatement` picks its enumeration
 * strategy by asking whether the `__for_in_*` host imports are REGISTERED, not
 * by asking what the receiver actually lowers to. In standalone those imports
 * are deliberately absent, so control fell through to the static-unroll path —
 * which is exact for a closed shape, and whose own comment says a closed struct
 * "does NOT lower to `$Object`" and therefore must not be handed to the dynamic
 * enumerators. In host mode the imports exist, so that reasoning never ran: the
 * struct was wrapped with `extern.convert_any` and passed to a JS function that
 * sees an opaque WasmGC value and returns zero keys. The loop body never ran.
 *
 * These cases pin the AGREEMENT, not one target's answer: the strategy is now
 * chosen from the lowered representation, so both targets unroll a closed shape.
 */
import { describe, expect, it } from "vitest";

import { compileAndRunHost as compileAndRun } from "./helpers/compile.js";

async function keysOf(literal: string): Promise<string> {
  const exports = await compileAndRun(`
    export function keys(): string {
      const o = ${literal};
      let out = "";
      for (const k in o) out += k + ",";
      return out;
    }
  `);
  return (exports.keys as () => string)();
}

describe("#5310 for-in over a closed-struct receiver (JS-host mode)", () => {
  it("enumerates data properties", async () => {
    expect(await keysOf(`{ a: 1, b: 2 }`)).toBe("a,b,");
  });

  it("enumerates string-valued properties", async () => {
    expect(await keysOf(`{ a: "x", b: "y" }`)).toBe("a,b,");
  });

  it("enumerates method-valued properties", async () => {
    // The shape that matters to real packages: an options bag of callbacks.
    // marked's `use({ hooks: { preprocess() {…} } })` walks exactly this with
    // `for (const i in n.hooks)`.
    expect(
      await keysOf(`{ preprocess(m: string): string { return m; }, postprocess(h: string): string { return h; } }`),
    ).toBe("preprocess,postprocess,");
  });

  it("enumerates a mix of data and method properties in source order", async () => {
    expect(await keysOf(`{ flag: 1, run(m: string): string { return m; }, name: "n" }`)).toBe("flag,run,name,");
  });

  it("runs the loop body once per key, not zero times", async () => {
    // The original bug was silent: zero iterations reads as "the object had no
    // keys", so a count is what distinguishes it from a formatting difference.
    const exports = await compileAndRun(`
      export function count(): number {
        const o = { a: 1, b: 2, c: 3 };
        let n = 0;
        for (const k in o) n++;
        return n;
      }
    `);
    expect((exports.count as () => number)()).toBe(3);
  });
});
