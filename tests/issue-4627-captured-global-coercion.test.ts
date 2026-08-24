import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { compileAndRunTestSync } from "./helpers/compile.js";

/**
 * #4627 — two sibling object-literal methods each declare `class MySubclass`
 * capturing a local of the SAME name but a DIFFERENT carrier: `let called = 0`
 * is an `f64`, `let called = false` is a branded-boolean `i32`.
 *
 * The #4618 class member-capture record was keyed by CLASS NAME, so the second
 * frame hit the re-bind early return against the FIRST frame's record and
 * synced its `i32` local into that frame's `f64` global. The whole module was
 * then rejected:
 *
 *   global.set[0] expected type f64, found local.get of type i32
 *
 * This is exactly test262's `temporalHelpers.js` shape — four helpers counting
 * with `let called = 0` plus `checkThisValueNotCalled` flagging with
 * `let called = false` — which is why one codegen defect stopped 1,477 Temporal
 * tests from instantiating at all.
 *
 * Fixed by 569d78f7, which re-keys that record by the `ts.Node` declaration.
 * `tests/issue-4787-*` covers the same defect class with a boolean/string pair
 * and plain classes; this covers the numeric-`f64`/boolean-`i32` pair, a
 * dynamic `extends` heritage, and runtime read-back.
 */
const SOURCE = `
class Base {
  constructor() {}
}

const Helpers = {
  // Mints \`__captured_called\` as f64 (\`let called = 0\`).
  countCalls(construct: any): number {
    let called = 0;
    class MySubclass extends construct {
      constructor() {
        ++called;
        super();
      }
    }
    new MySubclass();
    return called;
  },

  // Re-binds the SAME f64 global for a boolean local. The subclass constructor
  // is never run, so \`called\` must still read back as \`false\`.
  flagNotCalled(construct: any): number {
    let called = false;
    class MySubclass extends construct {
      constructor(...args: any[]) {
        called = true;
        super(...args);
      }
    }
    // MySubclass is deliberately never CONSTRUCTED: the whole point is that
    // \`called\` still reads back as \`false\`. Keep a reference so the class is
    // not elided.
    if (MySubclass === null) { new MySubclass(); }
    let score = 0;
    if (called === false) score += 1;
    if (typeof called === "boolean") score += 2;
    if (("" + called) === "false") score += 4;
    if (!called) score += 8;
    return score;
  },
};

export function test(): number {
  return Helpers.countCalls(Base) * 100 + Helpers.flagNotCalled(Base);
}
`;

describe("#4627 captured-global carrier mismatch on class re-bind", () => {
  it("emits a VALID module when a boolean capture shares an f64 capture global", async () => {
    const result = await compile(SOURCE, { fileName: "test.ts" });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    // The regression is a Wasm VALIDATION failure, not a compile-time error —
    // `compile()` reported success while the binary was unloadable.
    await expect(WebAssembly.compile(result.binary)).resolves.toBeDefined();
  });

  it("reads the captured boolean back as false, not as the number 0", async () => {
    // 100 = one construction counted in the f64 frame.
    // 15  = all four boolean reads in the widened frame: `=== false` (1),
    //       `typeof === "boolean"` (2), string conversion `"false"` (4) and
    //       falsiness (8).
    //
    // Bit 4 is the one that needs the read-side narrowing: comparison,
    // `typeof` and truthiness all survive the f64 widening on their own, but
    // the BOXING boundary consults the `boolean` brand to pick
    // `__box_boolean` over `__box_number` — without narrowing, `"" + called`
    // yields `"0"`. That boundary is what test262's
    // `assert.sameValue(called, false)` crosses.
    await expect(compileAndRunTestSync(SOURCE)).resolves.toBe(115);
  });
});
