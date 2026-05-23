// #1510 — for-await-of with destructuring patterns
//
// Tests that for-await-of correctly destructures yielded values, particularly
// when the yielded value is itself an iterable (sync or async generator).
//
// Reference test262 cases (excerpted):
// - async-gen-decl-dstr-array-elem-init-assignment.js — defaults fire on
//   undefined/hole elements; null is preserved.
// - async-func-dstr-let-async-ary-ptrn-rest-ary-elision.js — rest collects
//   from a sync generator that's been yielded.
// - async-func-decl-dstr-array-elem-init-in.js — parser must accept `in`
//   inside initializer of for-await head's destructuring pattern.

import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#1510 for-await-of destructuring", () => {
  it("destructures array elements with defaults (binding form)", async () => {
    // `const [a, b, c]` declares fresh locals scoped to the loop body.
    // We export via captured outer state.
    const src = `
      export function main(): number {
        let aOut: number = -1, cOut: number = -1, dOut: number = -1;
        const iterArr: number[][] = [[2, 4]];
        async function run(): Promise<void> {
          for await (const [a = 10, c = 12, d = 13] of iterArr) {
            aOut = a;
            cOut = c;
            dOut = d;
          }
        }
        run();
        // a=2, c=4, d=13 (default — only 2 elements in inner array)
        return (aOut === 2 && cOut === 4 && dOut === 13) ? 1 : 0;
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.main()).toBe(1);
  });

  it("destructures array elements as assignment-target with defaults (typed)", async () => {
    // The previously-crashing case (#1510 root cause): boxed-capture with default.
    const src = `
      export function main(): number {
        let v2: number = -1, vUndef: number = -1, vOob: number = -1;
        const iterArr: number[][] = [[2, 4]];
        async function run(): Promise<void> {
          // Assignment destructuring (no var/let/const before the pattern).
          // Without #1510 fix this trapped with "dereferencing a null pointer"
          // because emitDefaultValueCheck did local.set on the boxed-capture
          // param, overwriting the ref-cell.
          for await ([v2 = 10, vUndef = 13, vOob = 14] of iterArr) {}
        }
        run();
        // expected: v2=2 (extracted), vUndef=4 (extracted — no undefined here),
        // vOob=14 (out-of-bounds → default fires).
        if (v2 === 2 && vUndef === 4 && vOob === 14) return 1;
        return 0;
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.main()).toBe(1);
  });

  it("destructures with rest collecting all remaining elements", async () => {
    const src = `
      export function main(): number {
        let okHead = 0, okRestLen = 0, okRest1 = 0, okRest2 = 0;
        const iterArr: any[] = [[1, 2, 3, 4]];
        async function run(): Promise<void> {
          for await (const [head, ...rest] of iterArr) {
            if (head === 1) okHead = 1;
            if (rest.length === 3) okRestLen = 1;
            if (rest[0] === 2) okRest1 = 1;
            if (rest[1] === 3) okRest2 = 1;
          }
        }
        run();
        return okHead + okRestLen + okRest1 + okRest2;
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.main()).toBe(4);
  });

  it("destructures a yielded sync iterator with rest", async () => {
    const src = `
      // The yielded value is a sync generator — destructuring must use the
      // iterator protocol, not indexed access (gen[0] would be undefined).
      export function main(): number {
        let okLen = 0, okFirst = 0, okSecond = 0;
        function* g() { yield 10; yield 20; yield 30; }
        const iter: any[] = [g()];
        async function run(): Promise<void> {
          for await (const [...rest] of iter) {
            if (rest.length === 3) okLen = 1;
            if (rest[0] === 10) okFirst = 1;
            if (rest[1] === 20) okSecond = 1;
          }
        }
        run();
        return okLen + okFirst + okSecond;
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.main()).toBe(3);
  });

  it("accepts `in` inside for-await-of array-element initializer (parser)", async () => {
    // Parser-side: `for await (const [x = 'a' in {}] of arr)` — the `in`
    // inside the initializer must not be misread as the binding operator
    // (the loop is for-of, not for-in). This test compiles successfully
    // when the parser permits the `in` keyword inside the initializer.
    const src = `
      export function main(): number {
        const iterArr: number[][] = [[]];
        async function run(): Promise<void> {
          // 'a' in {a: 1} is a no-throw expression; we just want this to parse.
          for await (const [x = (('a' in {a: 1}) ? 1 : 0)] of iterArr) {
            void x;
          }
        }
        run();
        return 1; // compilation success is the success criterion
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.main()).toBe(1);
  });
});
