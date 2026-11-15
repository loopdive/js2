// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3195 (bloat S5) — the three near-duplicate closure-iterable drainers in
 * runtime.ts (`_drainClosureIterableToArray`, `_drainWasmClosureIterable`, and
 * the nested `_walkWasmIterator`) now share ONE parameterized step loop
 * (`_stepClosureIterator`), with the historical divergences (cap, limit,
 * IteratorClose, malformed-next / missing-callFn0 handling) as options. Also
 * folds the verbatim-dup `truthyEnv` into one export.
 *
 * Pure dedup (zero test-diff). (#6979 S7-f) The host drainers themselves were
 * deleted with the eager-generator provider — no live import reached them; the
 * rows stay as end-to-end value checks of the native lowering. These cases
 * exercise the three drainer call paths end-to-end through the unified loop — spread and Array.from (full
 * drain) and bounded destructuring (limit + IteratorClose) over an object whose
 * `[Symbol.iterator]` is a compiled Wasm closure.
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function run(src: string): Promise<unknown> {
  const exports = await compileToWasm(src);
  return (exports.test as () => unknown)();
}

// An object whose own `[Symbol.iterator]` is a compiled closure returning a
// hand-rolled `{ next() }` iterator — the exact shape the drainers exist for.
const ITERABLE = `
  const obj: any = {};
  obj[Symbol.iterator] = function () {
    let i = 0;
    return {
      next() {
        return i < 3 ? { value: (i = i + 1) * 10, done: false } : { value: 0, done: true };
      },
    };
  };
`;

describe("#3195 unified closure-iterable drainer", () => {
  it("full drain via spread (…) collects every yielded value", async () => {
    expect(
      await run(`
        export function test(): number {
          ${ITERABLE}
          const a: any[] = [...obj];
          return a[0] + a[1] + a[2] + a.length; // 10+20+30+3
        }
      `),
    ).toBe(63);
  });

  it("full drain via Array.from collects every yielded value", async () => {
    expect(
      await run(`
        export function test(): number {
          ${ITERABLE}
          const a: any[] = Array.from(obj);
          return a.length * 100 + a[2]; // 3*100 + 30
        }
      `),
    ).toBe(330);
  });

  it("bounded destructuring consumes exactly the pattern slots", async () => {
    expect(
      await run(`
        export function test(): number {
          ${ITERABLE}
          const [first, second]: any[] = obj;
          return first * 1000 + second; // 10*1000 + 20
        }
      `),
    ).toBe(10020);
  });

  it("for-of drains the closure iterable to completion", async () => {
    expect(
      await run(`
        export function test(): number {
          ${ITERABLE}
          let sum = 0;
          for (const v of obj) { sum = sum + (v as number); }
          return sum; // 10+20+30
        }
      `),
    ).toBe(60);
  });
});
