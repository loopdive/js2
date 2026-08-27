// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4768 — an array binding pattern must consume EXACTLY the IteratorSteps
 * §8.5.3 prescribes, including when the iterator is a compiled generator that
 * reaches the pattern through a call boundary.
 *
 * Two independent defects produced the same symptom (every
 * `*ary-ptrn-elision.js` row reporting `Expected SameValue(«1», «0»)`):
 *
 *  1. `emitNativeGeneratorToVec` — the native (suspend/resume) drain shared by
 *     spread / `Array.from` / destructuring — always ran the generator to
 *     COMPLETION. `var [,] = g()` therefore observed both yields of a two-yield
 *     generator. It now takes a `stepLimit` and performs the §13.3.3.5-step-3
 *     IteratorClose when it stops early.
 *  2. A generator flowing into an array-binding-pattern PARAMETER — `f(g())`
 *     or `([,] = g()) => …` — failed `hostLaneGeneratorUsesAreSafe` and kept
 *     the eager BUFFER lowering, where a single host-side `next()` runs the
 *     whole body. The walk now admits those two positions, and
 *     `destructureParamArray` recovers the state struct from the externref
 *     parameter (`any.convert_extern` + `ref.test`) and drains it with the
 *     same budget.
 *
 * The counters below are the direct §8.5.3 observable: `first` increments
 * before the first yield, `second` between the two yields.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string, target?: "standalone"): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true, ...(target ? { target } : {}) });
  if (!r.success) throw new Error(r.errors[0]?.message ?? "compile error");
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as { setExports?: (e: unknown) => void }).setExports?.(instance.exports);
  return (instance.exports as { test(): unknown }).test();
}

/** `first * 10 + second` after `f(g())`, where `f`'s only param is `pattern`. */
const callArgProbe = (pattern: string): string => `
  var first = 0;
  var second = 0;
  function* g() { first = first + 1; yield 1; second = second + 1; yield 2; }
  function f(${pattern}) { return 0; }
  export function test(): number {
    f(g());
    return first * 10 + second;
  }
`;

/** Same counters, but the generator call is the pattern parameter's DEFAULT. */
const paramDefaultProbe = (pattern: string): string => `
  var first = 0;
  var second = 0;
  function* g() { first = first + 1; yield 1; second = second + 1; yield 2; }
  function f(${pattern} = g()) { return 0; }
  export function test(): number {
    f();
    return first * 10 + second;
  }
`;

/** Same counters, but the pattern is a declaration over a direct call. */
const declProbe = (pattern: string): string => `
  var first = 0;
  var second = 0;
  function* g() { first = first + 1; yield 1; second = second + 1; yield 2; }
  export function test(): number {
    var ${pattern} = g();
    return first * 10 + second;
  }
`;

describe("#4768 — array-pattern IteratorStep budget over a compiled generator", () => {
  describe("call argument — f(g())", () => {
    it("[] consumes ZERO steps", async () => {
      expect(await run(callArgProbe("[]"))).toBe(0);
    });

    it("[,] consumes exactly one step (the ary-ptrn-elision shape)", async () => {
      expect(await run(callArgProbe("[,]"))).toBe(10);
    });

    it("[, ,] consumes exactly two steps", async () => {
      expect(await run(callArgProbe("[, ,]"))).toBe(11);
    });

    it("[a] consumes exactly one step", async () => {
      expect(await run(callArgProbe("[a]"))).toBe(10);
    });

    it("[a, b] consumes exactly two steps", async () => {
      expect(await run(callArgProbe("[a, b]"))).toBe(11);
    });

    it("KNOWN GAP — a PLAIN parameter still drains the eager buffer", async () => {
      // `f(g())` with an identifier param is deliberately NOT admitted by the
      // use-site safety walk: the callee could hand the value to any
      // host-iterating context, and a raw WasmGC state struct there drops
      // values silently (#3468). So it keeps the EAGER buffer lowering — where
      // something on the host side still resumes the generator to completion
      // even though nothing in the source iterates `x`.
      //
      // Spec says 0. This pins the pre-existing behaviour (measured identical
      // before and after #4768) so the residual gap is visible rather than
      // silent; flip it to 0 when the eager-buffer lowering is retired.
      expect(await run(callArgProbe("x"))).toBe(11);
    });
  });

  describe("pattern parameter default — ([,] = g()) => …", () => {
    it("[] consumes ZERO steps", async () => {
      expect(await run(paramDefaultProbe("[]"))).toBe(0);
    });

    it("[,] consumes exactly one step", async () => {
      expect(await run(paramDefaultProbe("[,]"))).toBe(10);
    });

    it("[a, b] consumes exactly two steps", async () => {
      expect(await run(paramDefaultProbe("[a, b]"))).toBe(11);
    });
  });

  describe("declaration — var [,] = g()", () => {
    it("[,] consumes exactly one step", async () => {
      expect(await run(declProbe("[,]"))).toBe(10);
    });

    it("[, ,] consumes exactly two steps", async () => {
      expect(await run(declProbe("[, ,]"))).toBe(11);
    });

    it("[a] consumes exactly one step", async () => {
      expect(await run(declProbe("[a]"))).toBe(10);
    });

    it("[,] consumes exactly one step on the STANDALONE lane too", async () => {
      expect(await run(declProbe("[,]"), "standalone")).toBe(10);
    });
  });

  it("a bounded pattern still runs the generator's finally (IteratorClose)", async () => {
    // §13.3.3.5 step 3 closes an iterator the pattern left suspended; for a
    // generator that means resuming in RETURN mode, which unwinds `finally`.
    const src = `
      var closed = 0;
      function* g() { try { yield 1; yield 2; } finally { closed = 1; } }
      function f([a]) { return 0; }
      export function test(): number {
        f(g());
        return closed;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("a rest element keeps the pre-#4768 path (deliberately excluded)", async () => {
    // `[a, ...rest]` is excluded from the pattern-param arm — see
    // `paramConsumesPatternNatively`. It must still produce the right values.
    const src = `
      function* g() { yield 1; yield 2; yield 3; }
      function f([a, ...rest]) { return a * 100 + rest.length * 10 + rest[1]; }
      export function test(): number { return f(g()); }
    `;
    expect(await run(src)).toBe(123);
  });
});
