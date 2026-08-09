// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1937 — the linear/standalone backend used to NEVER compile break/continue
// (the statement dispatcher had no arm for them), so `while (true) { if (x)
// break; }` lowered to a silent infinite loop. Unsupported constructs likewise
// fell through both dispatchers' missing default arms, emitting zero
// instructions and surfacing — at best — as an opaque validator error far from
// the cause. This suite locks in the fix:
//   1. break/continue terminate / skip correctly (incl. nested loops, switch).
//   2. continue still runs the loop incrementor / re-tests the condition.
//   3. ToBoolean(NaN) is false (truthiness no longer `f64.ne 0`).
//   4. every unsupported construct fails loud with a located diagnostic.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/** Compile with the linear backend and instantiate; asserts the compile succeeded. */
async function compileLinear(source: string) {
  const result = await compile(source, { target: "linear" });
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
  ).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  return instance.exports as Record<string, (...args: number[]) => number>;
}

describe("linear break/continue (#1937)", () => {
  it("break terminates a while(true) loop (no infinite loop)", async () => {
    const e = await compileLinear(`
      export function f(): number {
        let i: number = 0;
        while (true) {
          if (i >= 5) {
            break;
          }
          i += 1;
        }
        return i;
      }
    `);
    expect(e.f()).toBe(5);
  });

  it("break terminates a while-condition loop early", async () => {
    const e = await compileLinear(`
      export function f(limit: number): number {
        let i: number = 0;
        while (i < 100) {
          if (i === limit) {
            break;
          }
          i += 1;
        }
        return i;
      }
    `);
    expect(e.f(7)).toBe(7);
    expect(e.f(3)).toBe(3);
  });

  it("continue skips the rest of a while body (and the body still advances)", async () => {
    const e = await compileLinear(`
      export function f(): number {
        let sum: number = 0;
        let i: number = 0;
        while (i < 10) {
          i += 1;
          if (i === 5) {
            continue;
          }
          sum += i;
        }
        return sum;
      }
    `);
    // sum of 1..10 = 55, minus the skipped 5 = 50
    expect(e.f()).toBe(50);
  });

  it("continue in a for loop still runs the incrementor", async () => {
    const e = await compileLinear(`
      export function f(): number {
        let sum: number = 0;
        for (let i: number = 0; i < 10; i += 1) {
          if (i === 5) {
            continue;
          }
          sum += i;
        }
        return sum;
      }
    `);
    // sum of 0..9 = 45, minus the skipped 5 = 40. If continue skipped the
    // incrementor we would loop forever on i === 5.
    expect(e.f()).toBe(40);
  });

  it("continue in a do-while still re-tests the condition", async () => {
    const e = await compileLinear(`
      export function f(): number {
        let sum: number = 0;
        let i: number = 0;
        do {
          i += 1;
          if (i === 3) {
            continue;
          }
          sum += i;
        } while (i < 6);
        return sum;
      }
    `);
    // i runs 1..6; sum = 1+2+4+5+6 = 18 (3 skipped)
    expect(e.f()).toBe(18);
  });

  it("break in the inner loop only exits the inner loop", async () => {
    const e = await compileLinear(`
      export function f(): number {
        let count: number = 0;
        for (let i: number = 0; i < 3; i += 1) {
          for (let j: number = 0; j < 10; j += 1) {
            if (j >= 2) {
              break;
            }
            count += 1;
          }
        }
        return count;
      }
    `);
    // inner loop contributes 2 per outer iteration × 3 = 6
    expect(e.f()).toBe(6);
  });

  it("continue in the inner loop only affects the inner loop", async () => {
    const e = await compileLinear(`
      export function f(): number {
        let count: number = 0;
        for (let i: number = 0; i < 3; i += 1) {
          for (let j: number = 0; j < 4; j += 1) {
            if (j === 1) {
              continue;
            }
            count += 1;
          }
        }
        return count;
      }
    `);
    // inner loop counts 3 of 4 iterations (skips j===1) × 3 outer = 9
    expect(e.f()).toBe(9);
  });

  it("break inside a switch exits the switch, not the surrounding loop", async () => {
    const e = await compileLinear(`
      export function f(): number {
        let total: number = 0;
        for (let i: number = 0; i < 4; i += 1) {
          switch (i) {
            case 1:
              total += 100;
              break;
            default:
              total += 1;
          }
          total += 10;
        }
        return total;
      }
    `);
    // i=0: default(+1)+10; i=1: case1(+100)+10; i=2: default(+1)+10; i=3: default(+1)+10
    // = (1+10)+(100+10)+(1+10)+(1+10) = 11+110+11+11 = 143
    expect(e.f()).toBe(143);
  });

  it("continue inside a switch continues the surrounding loop", async () => {
    const e = await compileLinear(`
      export function f(): number {
        let sum: number = 0;
        for (let i: number = 0; i < 5; i += 1) {
          switch (i) {
            case 2:
              continue;
            default:
              break;
          }
          sum += i;
        }
        return sum;
      }
    `);
    // sum of 0..4 = 10, minus the skipped 2 = 8
    expect(e.f()).toBe(8);
  });

  it("break/continue work inside for-of over an array", async () => {
    const brk = await compileLinear(`
      export function f(): number {
        const arr: number[] = [1, 2, 3, 4, 5];
        let sum: number = 0;
        for (const x of arr) {
          if (x === 3) {
            break;
          }
          sum += x;
        }
        return sum;
      }
    `);
    expect(brk.f()).toBe(3); // 1 + 2

    const cont = await compileLinear(`
      export function f(): number {
        const arr: number[] = [1, 2, 3, 4, 5];
        let sum: number = 0;
        for (const x of arr) {
          if (x === 3) {
            continue;
          }
          sum += x;
        }
        return sum;
      }
    `);
    expect(cont.f()).toBe(12); // 1+2+4+5
  });

  it("break/continue work inside for-of over a Map (destructured entry)", async () => {
    const cont = await compileLinear(`
      export function f(): number {
        const m: Map<number, number> = new Map();
        m.set(1, 10);
        m.set(2, 20);
        m.set(3, 30);
        let sum: number = 0;
        for (const [k, v] of m) {
          if (k === 2) {
            continue;
          }
          sum += v;
        }
        return sum;
      }
    `);
    expect(cont.f()).toBe(40); // 10 + 30

    const brk = await compileLinear(`
      export function f(): number {
        const m: Map<number, number> = new Map();
        m.set(1, 10);
        m.set(2, 20);
        m.set(3, 30);
        let count: number = 0;
        for (const [k, v] of m) {
          count += 1;
          if (count === 2) {
            break;
          }
        }
        return count;
      }
    `);
    expect(brk.f()).toBe(2);
  });
});

describe("linear ToBoolean(NaN) is false (#1937)", () => {
  it("if (NaN) takes the else branch", async () => {
    const e = await compileLinear(`
      export function f(): number {
        if (NaN) {
          return 1;
        }
        return 0;
      }
    `);
    expect(e.f()).toBe(0);
  });

  it("a NaN-producing expression is falsy", async () => {
    const e = await compileLinear(`
      export function f(): number {
        let x: number = 0;
        // 0/0 = NaN
        if (x / x) {
          return 1;
        }
        return 0;
      }
    `);
    expect(e.f()).toBe(0);
  });

  it("zero and -0 are falsy, non-zero finite values are truthy", async () => {
    const e = await compileLinear(`
      export function f(x: number): number {
        if (x) {
          return 1;
        }
        return 0;
      }
    `);
    expect(e.f(0)).toBe(0);
    expect(e.f(-0)).toBe(0);
    expect(e.f(3)).toBe(1);
    expect(e.f(-2)).toBe(1);
  });

  it("while (NaN) never iterates", async () => {
    const e = await compileLinear(`
      export function f(): number {
        let n: number = 0;
        let count: number = 0;
        while (n / n) {
          count += 1;
          if (count > 1000000) {
            break;
          }
        }
        return count;
      }
    `);
    expect(e.f()).toBe(0);
  });
});

describe("linear fail-loud on unsupported constructs (#1937)", () => {
  // Each snippet exercises a construct the linear backend cannot lower. The
  // contract: success:false with at least one located (line > 0) diagnostic —
  // NOT a silently-invalid binary.
  const unsupported: ReadonlyArray<readonly [string, string]> = [
    ["throw", `export function f(): number { throw 1; }`],
    ["dynamic typeof", `export function f(x: any): number { const t = typeof x; return 0; }`],
    [
      "await",
      `export async function f(): Promise<number> { return await g(); }
       async function g(): Promise<number> { return 1; }`,
    ],
  ];

  for (const [name, src] of unsupported) {
    it(`fails loud: ${name}`, async () => {
      const result = await compile(src, { target: "linear" });
      expect(result.success, `expected ${name} to fail compilation`).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      // At least one diagnostic must carry a real source position (line > 0),
      // proving we threaded getLineAndCharacterOfPosition rather than 0,0.
      expect(
        result.errors.some((e) => e.line > 0),
        `expected a located diagnostic, got: ${result.errors.map((e) => `L${e.line}:${e.column}`).join(", ")}`,
      ).toBe(true);
    });
  }

  // #2952 slice 3 — labeled break/continue moved OUT of the fail-loud list:
  // the IR path now claims labeled loops and lowers `br.label` to core-Wasm
  // `br` (backend-identical), so the linear target compiles AND runs them.
  it("labeled break now compiles and runs on linear (#2952 slice 3)", async () => {
    const e = await compileLinear(`export function f(): number { L: for (let i=0;i<2;i+=1) { break L; } return 1; }`);
    expect(e.f()).toBe(1);
  });

  it("labeled continue now compiles and runs on linear (#2952 slice 3)", async () => {
    const e = await compileLinear(
      `export function f(): number { L: for (let i=0;i<2;i+=1) { continue L; } return 1; }`,
    );
    expect(e.f()).toBe(1);
  });

  // #2952 slice 4 — switch (incl. non-empty-body fallthrough) moved OUT of
  // the fail-loud list: the IR path claims numeric-literal switches and the
  // block-per-case ladder is core Wasm, so linear compiles AND runs them.
  it("switch fallthrough now compiles and runs on linear (#2952 slice 4)", async () => {
    const e = await compileLinear(
      `export function f(x: number): number { let r=0; switch(x){ case 1: r=1; case 2: r=2; break; } return r; }`,
    );
    expect(e.f(1)).toBe(2); // case 1 falls into case 2
    expect(e.f(2)).toBe(2);
    expect(e.f(3)).toBe(0);
  });

  it("empty statements compile without a diagnostic", async () => {
    const e = await compileLinear(`
      export function f(): number {
        ;
        let x: number = 1;;
        return x;
      }
    `);
    expect(e.f()).toBe(1);
  });

  it("type-only statements/expressions compile and are erased", async () => {
    const e = await compileLinear(`
      type N = number;
      interface I { a: number; }
      export function f(x: number): number {
        const y = x as number;
        return y;
      }
    `);
    expect(e.f(42)).toBe(42);
  });
});
