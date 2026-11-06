// #7145 — `console.log(m.get(k))` with `__map_get` inlined as a
// `block (result anyref)` into the externref console import was invalid wasm
// on the native-first gc lane. Same program, both lanes, same result as JS.
import { describe, expect, it, vi } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const SRC = `export function test(): number {
  const m = new Map();
  m.set("a", 1);
  m.set("b", 2);
  console.log(m.get("a"));
  return m.size;
}`;

describe("#7145 Map.get result passed straight to console.log", () => {
  it("gc and standalone agree with JS", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const expected = evaluateAsJs(SRC).test!();
      for (const target of [undefined, "standalone"] as const) {
        const lane = target ?? "gc";
        const result = await compile(SRC, { fileName: "probe.ts", ...(target ? { target } : {}) });
        expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
        const instance = await instantiateWithRuntime(result);
        expect((instance.exports.test as () => unknown)(), lane).toBe(expected);
      }
    } finally {
      spy.mockRestore();
    }
  });
});
