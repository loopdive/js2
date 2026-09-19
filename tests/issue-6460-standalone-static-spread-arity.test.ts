// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6460 — `new F(...names)` where `names` is a `const` array binding, under
// `--target standalone`.
//
// WHY THIS REDUCTION EXISTS. Found through the compiled `@js-temporal/polyfill`
// provider (#5383 S12). Nine rows of the 120-row `built-ins/Temporal/Duration`
// sample failed with `TypeError: Cannot access property on null or undefined at
// 164:22` — harness line 164 is `assert.sameValue(duration.years, …)` inside
// `TemporalHelpers.assertDuration`, so the `duration` handed to it was null.
// Every one of those tests is written:
//
//     const args = [1, 1, 1];
//     const implicit = new Temporal.Duration(...args);
//
// Two DIFFERENT lowerings were reading the same too-narrow predicate,
// `flattenCallArgs`, which only understands an INLINE array literal
// (`new F(...[1, 2])`):
//
//   - the native construct drivers are minted one per call-site ARITY, so an
//     unresolvable arity DECLINED and the `new` evaluated to `null` — that is
//     the Temporal row above; and
//   - the ordinary-function `new` path pushes one operand per declared
//     parameter, so the spread degraded through `compileExpressionInner`'s
//     last-resort `SpreadElement` arm and the whole ARRAY landed in the first
//     parameter while the rest read their defaults.
//
// The second shape is the cheaper witness and needs no provider, so it is what
// this file asserts. Both are repaired by the same helper
// (`src/codegen/static-spread-arity.ts`), which resolves a spread whose source
// is a `const`-bound array literal of re-evaluable literals that is only ever
// spread.
//
// NOT covered here, on purpose: a spread into a DYNAMIC call
// (`const g = f; g(...args)`) is still wrong the same way — it is a third
// lowering (`compileIdentifierCall`) that reads `expr.arguments` positionally
// in a dozen places, and rewriting it did not fit this slice. The last `it`
// PINS that residual so the day it is fixed the stale expectation fails loudly
// instead of rotting.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const STANDALONE = {
  target: "standalone" as const,
  hostBridge: "off" as const,
  fileName: "/p.ts",
  allowJs: true,
  skipSemanticDiagnostics: true,
};

/**
 * Compile `source` standalone, instantiate with an EMPTY import object (so a
 * leaked host import fails the test rather than being papered over), and read
 * the string the exported `run` left behind, one char code at a time.
 */
async function runStandaloneString(expression: string): Promise<string> {
  const source = `let __s = "";
    export function prepare() { __s = "" + (${expression}); return __s.length; }
    export function at(i) { return __s.charCodeAt(i); }`;
  const result = await compile(source, STANDALONE);
  if (!result.success) throw new Error(`compile failed: ${result.errors?.[0]?.message}`);
  const module = await WebAssembly.compile(result.binary as Uint8Array);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as { prepare: () => number; at: (i: number) => number };
  const length = exports.prepare();
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(exports.at(i));
  return out;
}

describe("#6460 — static-arity spread into `new`, standalone", () => {
  it("spreads a const array binding into an ordinary-function constructor", async () => {
    // Base tree: "1,2,3undefinedundefined" — the whole array in `a`.
    await expect(
      runStandaloneString(
        `(() => { function C(a, b, c) { this.s = "" + a + b + c; }
          const args = [1, 2, 3];
          return new C(...args).s; })()`,
      ),
    ).resolves.toBe("123");
  });

  it("keeps a trailing positional argument after the spread", async () => {
    // The `*-undefined.js` Temporal rows use exactly this shape:
    // `new Temporal.Duration(...args, undefined)`.
    await expect(
      runStandaloneString(
        `(() => { function C(a, b, c, d) { this.s = "" + a + b + c + d; }
          const args = [1, 2, 3];
          return new C(...args, undefined).s; })()`,
      ),
    ).resolves.toBe("123undefined");
  });

  it("still declines a spread source that is written to (length is not static)", async () => {
    // `args` is pushed to, so its length is NOT syntactic and the helper must
    // refuse — the historical lowering (array in the first slot) is kept.
    // This asserts the REFUSAL, not a correct answer: silently expanding a
    // mutated binding to its declaration-time length would be a wrong answer
    // rather than a missing one.
    await expect(
      runStandaloneString(
        `(() => { function C(a, b) { this.s = "" + a + "|" + b; }
          const args = [1, 2];
          args.push(3);
          return new C(...args).s; })()`,
      ),
    ).resolves.toBe("1,2,3|undefined");
  });

  it("expands an INLINE array-literal spread too (this path never called flattenCallArgs)", async () => {
    // Base tree: "[object Object]undefinedundefined". The inline-literal case
    // was assumed handled because `flattenCallArgs` understands it — but the
    // fnctor `new` path never consulted it at all, so the literal was just as
    // broken as the named binding. Byte A/B shows this shape moving too.
    await expect(
      runStandaloneString(
        `(() => { function C(a, b, c) { this.s = "" + a + b + c; }
          return new C(...[1, 2, 3]).s; })()`,
      ),
    ).resolves.toBe("123");
  });

  it("PINS the residual: a spread into a dynamic call is still dropped", async () => {
    // When this starts failing, the dynamic-call lowering was fixed — update
    // the expectation to "123" and delete this note.
    await expect(
      runStandaloneString(
        `(() => { function f(a, b, c) { return "" + a + b + c; }
          const g = f;
          const args = [1, 2, 3];
          return g(...args); })()`,
      ),
    ).resolves.toBe("1,2,3undefinedundefined");
  });
});
