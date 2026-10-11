// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// (#6788) An array carrier in a String / `+` position runs ToPrimitive (its
// `join(",")`) — the full matrix lives in tests/issue-6788-array-carrier-toprimitive.test.ts.
import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Array carrier ToPrimitive (#6788)", () => {
  it("String(arr) and a template substitution join the elements", async () => {
    await assertEquivalent(
      `
      export function str(): string { const arr: number[] = [0, 9, 0]; return String(arr); }
      export function strLength(): number { const arr: number[] = [1, 22, 333]; return String(arr).length; }
      export function tmpl(): string { const arr: number[] = [1, 2]; return \`<\${arr}>\`; }
      export function nested(): string { const arr: number[][] = [[1, 2], [3]]; return String(arr); }
      export function empty(): string { const arr: number[] = []; return \`[\${arr}]\`; }
      `,
      [
        { fn: "str", args: [] },
        { fn: "strLength", args: [] },
        { fn: "tmpl", args: [] },
        { fn: "nested", args: [] },
        { fn: "empty", args: [] },
      ],
    );
  });

  it("`+` with an array operand concatenates the join", async () => {
    await assertEquivalent(
      `
      export function emptyPlusEmpty(): string { const s: any = [] + []; return s; }
      export function emptyPlusObject(): string { const s: any = [] + {}; return s; }
      export function arrPlusNumber(): string { const a: number[] = [1, 2]; const s: any = a + 1; return s; }
      export function numberPlusArr(): string { const a: number[] = [3]; const s: any = 1 + a; return s; }
      export function arrPlusString(): string { const a: number[] = [1, 2]; return a + "!"; }
      `,
      [
        { fn: "emptyPlusEmpty", args: [] },
        { fn: "emptyPlusObject", args: [] },
        { fn: "arrPlusNumber", args: [] },
        { fn: "numberPlusArr", args: [] },
        { fn: "arrPlusString", args: [] },
      ],
    );
  });

  it("ToNumber and loose equality reduce through the join", async () => {
    await assertEquivalent(
      `
      export function unaryEmpty(): number { return +[]; }
      export function unaryOne(): number { return +[1]; }
      export function numberOf(): number { return Number([5]); }
      export function looseEqString(): number { const a: number[] = [1, 2]; return a == "1,2" ? 1 : 0; }
      export function relationalStrings(): number { const a: number[] = [10]; const b: number[] = [9]; return a < b ? 1 : 0; }
      `,
      [
        { fn: "unaryEmpty", args: [] },
        { fn: "unaryOne", args: [] },
        { fn: "numberOf", args: [] },
        { fn: "looseEqString", args: [] },
        { fn: "relationalStrings", args: [] },
      ],
    );
  });
});
