import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("yield as expression (#763)", () => {
  it("yield without value used as IIFE argument", async () => {
    // yield (no operand) used as argument to an IIFE inside a generator.
    // In the eager generator model, the yield receives undefined from .next().
    const exports = await compileToWasm(`
      function *gen(): Generator<undefined, number, number> {
        return (function(arg: number): number {
          return arg + 1;
        }(yield));
      }
      export function test(): number {
        const iter = gen();
        iter.next();       // start generator, yield produces undefined
        const result = iter.next(42);  // resume; Node binds 42 here, we do not (see below)
        return result.done ? 1 : 0;
      }
    `);
    // The important thing is that compilation succeeds (no "not enough arguments" error).
    //
    // (#2864 wave-2 S1) This assertion used to be `typeof result.value ===
    // "number"`, which pinned the UNDEF_F64 SENTINEL's rendering rather than any
    // real behaviour. Node returns `43` here (`arg` = 42); we do not deliver the
    // `.next(42)` sent value into a yield in ARGUMENT position, so the value has
    // always been the undefined sentinel. It merely used to *read back* as the
    // number NaN, which satisfied a `typeof === "number"` check by accident;
    // S1 makes an absent value render as `undefined`, as it already was.
    // #2864's own R1 note says not to pin this residual in tests — so the
    // assertion now pins `done`, which is true in every model. The real gap
    // (sent value not bound for an argument-position yield) is unchanged and
    // untested here by design.
    expect(exports.test()).toBe(1);
  });

  it("yield with value used as expression", async () => {
    // yield <value> used as expression -- the result of yield is the value passed to .next()
    const exports = await compileToWasm(`
      function *gen(): Generator<number, number, undefined> {
        const x: number = yield 10;
        return 42;
      }
      export function test(): number {
        const iter = gen();
        const first = iter.next();
        // In eager model, generator runs to completion immediately.
        // first.value should be 10 (the yielded value)
        return first.done ? 0 : 1;
      }
    `);
    // In eager model, generator behavior may differ from spec.
    // Just verify compilation succeeds and returns a number.
    expect(typeof exports.test()).toBe("number");
  });

  it("yield in template literal", async () => {
    // yield inside a template expression: \`prefix\${yield}suffix\`
    const exports = await compileToWasm(`
      let result: string = "";
      function *g(): Generator<undefined, undefined, string> {
        result = "a" + (yield) + "b";
      }
      export function test(): number {
        const iter = g();
        iter.next();
        // In eager model, yield returns undefined
        return result.length > 0 ? 1 : 0;
      }
    `);
    // Compilation succeeds -- the yield expression produces a value for the template
    expect(typeof exports.test()).toBe("number");
  });

  it("bare yield as function argument", async () => {
    // yield used as a direct argument to a function call
    const exports = await compileToWasm(`
      function identity(x: number): number { return x; }
      function *gen(): Generator<undefined, number, number> {
        return identity(yield);
      }
      export function test(): number {
        const iter = gen();
        iter.next();
        const result = iter.next(5);
        return result.done ? 1 : 0;
      }
    `);
    // (#2864 wave-2 S1) Same correction as the IIFE case above: Node returns
    // `5` (the sent value flows through `identity`), we return the undefined
    // sentinel because an argument-position yield is not bound to `.next(v)`.
    // The old `typeof result.value === "number"` pinned the sentinel's
    // rendering, not the behaviour; `done` is the part that is actually stable.
    expect(exports.test()).toBe(1);
  });
});
