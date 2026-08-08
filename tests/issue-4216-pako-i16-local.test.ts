// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4216 — standalone `u16[i]++` declared a LOCAL with packed type i16.
//
// The vec-element inc/dec arm (`unary-updates.ts` makeStoreLocal, #3024) routes
// the new value through coerceType into a store temp when the element rep is
// not the arithmetic numType. For a packed i8/i16 element (Uint16Array's
// standalone backing store) coerceType leaves an i32 on the stack — packed
// kinds are storage-only — but the temp was DECLARED with the raw elemType, so
// the function-locals vector carried an i16 and the emit-time guard
// (binary.ts encodeValType, #1939) failed the whole module. First hit on a
// real corpus: pako 2.1.0's dist bundle (3 such locals in one closure).
//
// The fix widens the declared type via unpackedElemType; the stored VALUE was
// already correctly coerced, so runtime semantics (incl. u16 wraparound) hold.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const SRC = `
export function bump(): number {
  const u = new Uint16Array(4);
  u[1] = 7;
  u[1]++;
  ++u[2];
  u[3]--;
  return u[1] + u[2] + u[3];
}
`;

describe("#4216 packed i16 element inc/dec must not declare an i16 local", () => {
  it("compiles Uint16Array element ++/-- to valid standalone Wasm with correct semantics", async () => {
    const result = await compile(SRC, {
      fileName: "fixture.ts",
      target: "standalone",
    });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    // The regression surfaced at binary emit — validate the whole module.
    const module = await WebAssembly.compile(result.binary);
    const instance = await WebAssembly.instantiate(module, {});
    const exports = instance.exports as Record<string, () => unknown>;
    exports.__module_init?.();
    // 8 (7++) + 1 (++0) + 65535 (0-- wraps per Uint16Array) = 65544
    expect(exports.bump!()).toBe(65544);
  }, 120_000);
});
