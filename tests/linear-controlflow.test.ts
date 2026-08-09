import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/** Compile with linear-memory backend and instantiate */
async function compileLinear(source: string) {
  const result = await compile(source, { target: "linear" });
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
  ).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  return instance.exports as Record<string, Function>;
}

describe("linear-controlflow: variables", () => {
  it("declares and uses local variables", async () => {
    const e = await compileLinear(`
      export function test(): number {
        let x: number = 10;
        let y: number = 20;
        return x + y;
      }
    `);
    expect(e.test()).toBe(30);
  });

  it("reassigns variables", async () => {
    const e = await compileLinear(`
      export function test(): number {
        let x: number = 5;
        x = 10;
        return x;
      }
    `);
    expect(e.test()).toBe(10);
  });

  it("compound assignment operators", async () => {
    const e = await compileLinear(`
      export function test(): number {
        let x: number = 10;
        x += 5;
        x -= 3;
        x *= 2;
        return x;
      }
    `);
    // 10 + 5 = 15, - 3 = 12, * 2 = 24
    expect(e.test()).toBe(24);
  });
});

describe("linear-controlflow: if/else", () => {
  it("if without else", async () => {
    const e = await compileLinear(`
      export function abs(x: number): number {
        if (x < 0) {
          return -x;
        }
        return x;
      }
    `);
    expect(e.abs(-5)).toBe(5);
    expect(e.abs(3)).toBe(3);
  });

  it("if with else", async () => {
    const e = await compileLinear(`
      export function max(a: number, b: number): number {
        if (a > b) {
          return a;
        } else {
          return b;
        }
      }
    `);
    expect(e.max(3, 7)).toBe(7);
    expect(e.max(10, 2)).toBe(10);
  });

  it("nested if/else", async () => {
    const e = await compileLinear(`
      export function classify(x: number): number {
        if (x > 0) {
          if (x > 100) {
            return 2;
          }
          return 1;
        } else {
          return 0;
        }
      }
    `);
    expect(e.classify(50)).toBe(1);
    expect(e.classify(200)).toBe(2);
    expect(e.classify(-5)).toBe(0);
  });
});

describe("linear-controlflow: while loops", () => {
  it("simple while loop", async () => {
    const e = await compileLinear(`
      export function sum(n: number): number {
        let result: number = 0;
        let i: number = 1;
        while (i <= n) {
          result += i;
          i += 1;
        }
        return result;
      }
    `);
    expect(e.sum(5)).toBe(15); // 1+2+3+4+5
    expect(e.sum(0)).toBe(0);
    expect(e.sum(1)).toBe(1);
  });

  it("while loop counting down", async () => {
    const e = await compileLinear(`
      export function countdown(n: number): number {
        let result: number = 0;
        while (n > 0) {
          result += n;
          n -= 1;
        }
        return result;
      }
    `);
    expect(e.countdown(5)).toBe(15); // 5+4+3+2+1
    expect(e.countdown(0)).toBe(0);
  });
});

describe("linear-controlflow: for loops", () => {
  it("simple for loop", async () => {
    const e = await compileLinear(`
      export function sum(n: number): number {
        let result: number = 0;
        for (let i: number = 0; i < n; i += 1) {
          result += i;
        }
        return result;
      }
    `);
    expect(e.sum(5)).toBe(10); // 0+1+2+3+4
    expect(e.sum(0)).toBe(0);
  });

  it("nested for loops", async () => {
    const e = await compileLinear(`
      export function mulTable(n: number): number {
        let total: number = 0;
        for (let i: number = 1; i <= n; i += 1) {
          for (let j: number = 1; j <= n; j += 1) {
            total += i * j;
          }
        }
        return total;
      }
    `);
    // Sum of i*j for i,j in 1..3 = (1+2+3)*(1+2+3) = 36
    expect(e.mulTable(3)).toBe(36);
  });
});

describe("linear-controlflow: comparison operators", () => {
  it("less than", async () => {
    const e = await compileLinear(`
      export function lt(a: number, b: number): number {
        if (a < b) return 1;
        return 0;
      }
    `);
    expect(e.lt(1, 2)).toBe(1);
    expect(e.lt(2, 1)).toBe(0);
    expect(e.lt(1, 1)).toBe(0);
  });

  it("greater than or equal", async () => {
    const e = await compileLinear(`
      export function gte(a: number, b: number): number {
        if (a >= b) return 1;
        return 0;
      }
    `);
    expect(e.gte(2, 1)).toBe(1);
    expect(e.gte(1, 1)).toBe(1);
    expect(e.gte(0, 1)).toBe(0);
  });

  it("equality", async () => {
    const e = await compileLinear(`
      export function eq(a: number, b: number): number {
        if (a === b) return 1;
        return 0;
      }
    `);
    expect(e.eq(5, 5)).toBe(1);
    expect(e.eq(5, 6)).toBe(0);
  });

  it("not equal", async () => {
    const e = await compileLinear(`
      export function neq(a: number, b: number): number {
        if (a !== b) return 1;
        return 0;
      }
    `);
    expect(e.neq(5, 6)).toBe(1);
    expect(e.neq(5, 5)).toBe(0);
  });
});

describe("linear-controlflow: prefix unary", () => {
  it("unary minus", async () => {
    const e = await compileLinear(`
      export function neg(x: number): number {
        return -x;
      }
    `);
    expect(e.neg(5)).toBe(-5);
    expect(e.neg(-3)).toBe(3);
    // f64.neg(0) produces -0 per IEEE 754; verify magnitude is zero
    expect(e.neg(0) === 0).toBe(true);
  });
});

describe("linear-controlflow: expression statements", () => {
  it("increment via expression statement", async () => {
    const e = await compileLinear(`
      export function test(): number {
        let x: number = 0;
        x = x + 1;
        x = x + 1;
        return x;
      }
    `);
    expect(e.test()).toBe(2);
  });
});

// ── #1937: break / continue ──────────────────────────────────────────────

/** Compile with the linear backend, expecting failure; return the errors. */
async function compileLinearExpectError(source: string) {
  const result = await compile(source, { target: "linear" });
  expect(result.success, `expected compile failure but got success\nWAT:\n${result.wat}`).toBe(false);
  return result.errors;
}

describe("linear-controlflow: break/continue (#1937)", () => {
  it("break exits a while(true) loop", async () => {
    const e = await compileLinear(`
      export function test(n: number): number {
        let i: number = 0;
        while (true) {
          if (i >= n) break;
          i = i + 1;
        }
        return i;
      }
    `);
    expect(e.test(5)).toBe(5);
    expect(e.test(0)).toBe(0);
  });

  it("continue in a while loop re-tests the condition", async () => {
    const e = await compileLinear(`
      export function sumOdds(n: number): number {
        let i: number = 0;
        let sum: number = 0;
        while (i < n) {
          i = i + 1;
          if (i % 2 === 0) continue;
          sum = sum + i;
        }
        return sum;
      }
    `);
    expect(e.sumOdds(10)).toBe(25); // 1+3+5+7+9
  });

  it("continue in a for loop still runs the incrementor", async () => {
    const e = await compileLinear(`
      export function sumNonMultiplesOf3(n: number): number {
        let sum: number = 0;
        for (let i = 0; i < n; i = i + 1) {
          if (i % 3 === 0) continue;
          sum = sum + i;
        }
        return sum;
      }
    `);
    // 0..9 minus {0,3,6,9} → 1+2+4+5+7+8 = 27
    expect(e.sumNonMultiplesOf3(10)).toBe(27);
  });

  it("break in a for loop", async () => {
    const e = await compileLinear(`
      export function firstSquareAbove(limit: number): number {
        let result: number = -1;
        for (let i = 1; i < 1000; i = i + 1) {
          if (i * i > limit) {
            result = i * i;
            break;
          }
        }
        return result;
      }
    `);
    expect(e.firstSquareAbove(10)).toBe(16);
    expect(e.firstSquareAbove(0)).toBe(1);
  });

  it("break/continue bind to the innermost of nested loops", async () => {
    const e = await compileLinear(`
      export function test(): number {
        let count: number = 0;
        for (let i = 0; i < 4; i = i + 1) {
          for (let j = 0; j < 4; j = j + 1) {
            if (j === i) continue;
            if (j > 2) break;
            count = count + 1;
          }
        }
        return count;
      }
    `);
    // i=0: j=1,2 → 2; i=1: j=0,2 → 2; i=2: j=0,1 → 2; i=3: j=0,1,2 → 3
    expect(e.test()).toBe(9);
  });

  it("continue in a do-while still checks the condition", async () => {
    const e = await compileLinear(`
      export function test(n: number): number {
        let i: number = 0;
        let evens: number = 0;
        do {
          i = i + 1;
          if (i % 2 === 1) continue;
          evens = evens + 1;
        } while (i < n);
        return evens;
      }
    `);
    expect(e.test(10)).toBe(5);
  });

  it("break in a do-while", async () => {
    const e = await compileLinear(`
      export function test(): number {
        let i: number = 0;
        do {
          i = i + 1;
          if (i === 3) break;
        } while (i < 100);
        return i;
      }
    `);
    expect(e.test()).toBe(3);
  });

  it("break/continue in for-of over an array", async () => {
    const e = await compileLinear(`
      export function test(): number {
        const arr: number[] = [1, 2, 3, 4, 5, 6];
        let sum: number = 0;
        for (const x of arr) {
          if (x === 2) continue;
          if (x === 5) break;
          sum = sum + x;
        }
        return sum;
      }
    `);
    expect(e.test()).toBe(8); // 1 + 3 + 4
  });

  it("break inside switch exits the switch, not an enclosing loop", async () => {
    const e = await compileLinear(`
      export function test(n: number): number {
        let total: number = 0;
        for (let i = 0; i < n; i = i + 1) {
          switch (i % 3) {
            case 0:
              total = total + 1;
              break;
            case 1:
              total = total + 10;
              break;
            default:
              total = total + 100;
              break;
          }
        }
        return total;
      }
    `);
    expect(e.test(6)).toBe(222); // two of each arm
  });

  it("break inside an if inside a switch inside a loop", async () => {
    const e = await compileLinear(`
      export function test(): number {
        let acc: number = 0;
        for (let i = 0; i < 5; i = i + 1) {
          switch (i) {
            case 2: {
              if (acc > 0) {
                acc = acc + 100;
                break;
              }
              acc = acc + 1000;
              break;
            }
            default:
              acc = acc + 1;
              break;
          }
        }
        return acc;
      }
    `);
    expect(e.test()).toBe(104); // i=0,1: +1+1; i=2: +100; i=3,4: +1+1
  });
});

// ── #1937: truthiness ────────────────────────────────────────────────────

describe("linear-controlflow: NaN truthiness (#1937)", () => {
  it("if (NaN) takes the else branch", async () => {
    const e = await compileLinear(`
      export function test(x: number): number {
        const y: number = x / x; // NaN when x is 0
        if (y) return 1;
        return 0;
      }
    `);
    expect(e.test(0)).toBe(0); // 0/0 = NaN → falsy
    expect(e.test(2)).toBe(1); // 2/2 = 1 → truthy
  });

  it("while (NaN) never enters the loop", async () => {
    const e = await compileLinear(`
      export function test(): number {
        let guard: number = 0 / 0;
        let n: number = 0;
        while (guard) {
          n = 1;
          guard = 0;
        }
        return n;
      }
    `);
    expect(e.test()).toBe(0);
  });

  it("negative numbers stay truthy, zero stays falsy", async () => {
    const e = await compileLinear(`
      export function test(x: number): number {
        if (x) return 1;
        return 0;
      }
    `);
    expect(e.test(-5)).toBe(1);
    expect(e.test(0.5)).toBe(1);
    expect(e.test(0)).toBe(0);
    expect(e.test(-0)).toBe(0);
  });
});

// ── #1937: fail-loud dispatchers ─────────────────────────────────────────

describe("linear-controlflow: unsupported constructs fail loud (#1937)", () => {
  // (#2952 slice 3) "labeled break" moved OUT of this list: the IR path now
  // claims labeled loops and lowers `br.label` to core-Wasm `br`
  // (backend-identical), so the linear target compiles and runs it — see the
  // positive test after this block.
  const unsupportedStatements: [name: string, source: string][] = [
    [
      "throw",
      `export function test(x: number): number {
        if (x < 0) throw new Error("negative");
        return x;
      }`,
    ],
    [
      "break outside any loop",
      `export function test(): number {
        break;
        return 0;
      }`,
    ],
    [
      "continue outside any loop",
      `export function test(): number {
        continue;
        return 0;
      }`,
    ],
  ];

  it.each(unsupportedStatements)("%s → success:false with a located message", async (_name, body) => {
    const errors = await compileLinearExpectError(body);
    expect(errors.length).toBeGreaterThan(0);
    // At least one diagnostic must carry a real source position (#1937
    // threads getLineAndCharacterOfPosition into linear diagnostics).
    expect(errors.some((e) => e.line > 0)).toBe(true);
  });

  it("switch fallthrough from a non-empty body now compiles and runs on linear (#2952 slice 4)", async () => {
    const e = await compileLinear(`
      export function test(n: number): number {
        let r: number = 0;
        switch (n) {
          case 0:
            r = r + 1;
          case 1:
            r = r + 10;
            break;
        }
        return r;
      }
    `);
    expect(e.test(0)).toBe(11); // case 0 falls into case 1
    expect(e.test(1)).toBe(10);
    expect(e.test(2)).toBe(0);
  });

  it("labeled break now compiles and runs on linear (#2952 slice 3)", async () => {
    const e = await compileLinear(`
      export function test(): number {
        let n: number = 0;
        outer: for (let i = 0; i < 3; i = i + 1) {
          for (let j = 0; j < 3; j = j + 1) {
            if (i === 1) { break outer; }
            n = n + 1;
          }
        }
        return n;
      }
    `);
    expect(e.test()).toBe(3); // i=0 counts j=0..2, i=1 breaks out immediately
  });

  it("dynamic typeof (unsupported expression) fails loud with a located message", async () => {
    const errors = await compileLinearExpectError(`
      export function test(x: any): number {
        if (typeof x === "number") return 1;
        return 0;
      }
    `);
    expect(errors.some((e) => e.message.includes("Unsupported expression") && e.line > 0)).toBe(true);
  });
});

// ── #1937: modulo (was an empty dispatch arm leaving 2 stack values) ─────

describe("linear-controlflow: % operator (#1937)", () => {
  it("computes the remainder, not the divisor", async () => {
    const e = await compileLinear(`
      export function mod(a: number, b: number): number {
        return a % b;
      }
    `);
    expect(e.mod(10, 3)).toBe(1);
    expect(e.mod(9, 3)).toBe(0);
    expect(e.mod(5.5, 2)).toBe(1.5);
    expect(e.mod(-5, 3)).toBe(-2); // JS %: sign of the dividend
    expect(e.mod(5, -3)).toBe(2);
    expect(Number.isNaN(e.mod(5, 0))).toBe(true);
    expect(Number.isNaN(e.mod(Infinity, 3))).toBe(true);
  });
});
