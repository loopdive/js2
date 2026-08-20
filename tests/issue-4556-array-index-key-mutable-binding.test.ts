// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4556) `arrayIndexConstantKey` resolves a constant element key whose ToString
// IS an array index but which is NOT spelled as a number — `a["1"]`,
// `a[new Number(2)]`, `a[new String("2")]` — because the vec lane compiles the
// key with an i32 hint that has no lowering for those, so they silently
// compiled to `0`.
//
// The hazard this file pins is the OTHER direction. `resolveConstantExpression`
// (literals.ts) folds a `let`/`var` binding to its INITIALIZER — mutability be
// damned — and returns it as a STRING even for a numeric one. So a first cut
// that accepted a bare identifier resolved `for (var i = 0; …) nums[i]` to the
// key `"0"`, which IS an array index, and every iteration read `nums[0]`:
// `[1,2,3]` summed to 3 instead of 6.
//
// That fold is harmless to `nonArrayIndexNumericKey` (#4247) — an index-looking
// result makes it DECLINE — but here it is the answer, so the identical input
// becomes a silent wrong read. Both lanes are pinned because the resolution is
// lane-shared; the regression was found in the GC lane by
// `issue-4394-mixed-array-literal-host`, while the standalone conformance lane
// and a 551-row standalone guard both stayed green.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Lane = "standalone" | "gc";
const LANES: Lane[] = ["standalone", "gc"];

async function run(src: string, target: Lane): Promise<unknown> {
  const r = await compile(src, target === "standalone" ? { target: "standalone" as const } : {});
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const imports = target === "standalone" ? {} : buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as { test: () => unknown }).test();
}

describe.each(LANES)("#4556 — element keys and mutable bindings (%s)", (lane) => {
  it("a mutable loop variable indexes every element, not just its initializer", async () => {
    expect(
      await run(
        `export function test(): number {
           const nums = [1, 2, 3];
           let total = 0;
           for (let i = 0; i < nums.length; i++) total += nums[i]!;
           return total;
         }`,
        lane,
      ),
    ).toBe(6);
  });

  it("a mutable binding reassigned after its initializer reads the CURRENT index", async () => {
    expect(
      await run(
        `export function test(): number {
           const nums = [10, 20, 30];
           let k = 0;
           k = 2;
           return nums[k]!;
         }`,
        lane,
      ),
    ).toBe(30);
  });

  // The shape that regressed test262 `String/prototype/split/*-instance-is-number`
  // on `main`: a `var` loop counter indexing an ANY-typed array (the result of a
  // call). Both operands of the comparison are element reads, so a fold on
  // either side silently compares element 0 against the right element.
  it("a var loop counter indexes an any-typed array element-by-element", async () => {
    expect(
      await run(
        `const parts: any[] = ["", "00", "", "22"];
         const want: any[] = ["", "00", "", "22"];
         export function test(): number {
           var matched = 0;
           for (var index = 0; index < want.length; index++) {
             if (parts[index] === want[index]) matched++;
           }
           return matched === 4 && parts[1] === "00" ? 1 : 0;
         }`,
        lane,
      ),
    ).toBe(1);
  });

  it("the string spelling of an index still reaches that element", async () => {
    expect(
      await run(
        `const a: any[] = [];
         export function test(): number { a["1"] = 7; return a[1] === 7 && a.length === 2 ? 1 : 0; }`,
        lane,
      ),
    ).toBe(1);
  });

  it("a wrapper spelling of an index still reaches that element", async () => {
    expect(
      await run(
        `const a: any[] = [10, 20, 30];
         export function test(): number {
           return a[new Number(2) as any] === 30 && a[new String("2") as any] === 30 ? 1 : 0;
         }`,
        lane,
      ),
    ).toBe(1);
  });
});
