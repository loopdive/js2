// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4138 (narrow slice) — for-in over a receiver typed `T | undefined`.
 *
 * A receiver that flowed through `Array.pop()` types as `T | undefined`, and a
 * union's `getProperties()` is the COMMON property set — empty — so the
 * standalone static-unroll path silently enumerated nothing (the walk in the
 * acorn self-parse benchmark visited only the root). The static shape must be
 * read off the non-nullable type; the loop's own guards already handle the
 * runtime null case.
 *
 * The rest of #4138 (runtime-polymorphic receivers, closed-struct
 * enumerability through the dynamic runtime) is deliberately NOT covered here.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const SRC = `
export function bench() {
  var root = { type: "A", kid: { type: "B" } };
  var stack = [root];
  var node = stack.pop();
  var n = 0;
  for (var k in node) { n = n + 1; }
  return n;
}
`;

describe("#4138 — for-in over a popped (T | undefined) receiver", () => {
  // standalone-only: that is where the static-unroll branch decides the key
  // set at compile time. The gc lane routes through the `__for_in_*` host
  // imports and enumerates at runtime, so it was never affected.
  it("enumerates the non-nullable shape's keys (standalone)", async () => {
    const result = await compile(SRC, { fileName: "m.mjs", skipSemanticDiagnostics: true, target: "standalone" });
    expect(result.binary.length).toBeGreaterThan(0);
    const mod = await WebAssembly.compile(result.binary as BufferSource);
    const instance = await WebAssembly.instantiate(mod, {});
    expect((instance.exports.bench as () => number)()).toBe(2);
  });
});
