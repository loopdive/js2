// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 cluster E — standalone TypedArray/ArrayBuffer residuals.
 *
 * Four seams, each pinned by the behaviour its test262 rows assert:
 *  - the any-receiver array HOF dispatcher now claims ARITY 0, so
 *    `sample.every()` is `IsCallable(undefined)` → TypeError instead of a
 *    normal `undefined` return (§23.1.3.x step 3);
 *  - `__arrprod_sort` rejects a present, non-`undefined`, non-callable
 *    comparefn (§23.1.3.30 step 1) instead of demoting it to "no comparator";
 *  - `ArrayBuffer.isView` answers for the DYNAMIC view brand and answers FALSE
 *    for an ArrayBuffer's own backing carrier (§25.1.4.1);
 *  - `slice`/`subarray` on a dynamic view throw on a Symbol index argument
 *    (§7.1.4 step 3 through ToIntegerOrInfinity).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(body: string, target: "standalone" | undefined = "standalone"): Promise<unknown> {
  const result = await compile(`export function test(): number { ${body} }`, {
    fileName: "issue-6651-e.ts",
    ...(target ? { target } : {}),
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  if (target === "standalone") expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

const DYN = `const ctors: any[] = [Int8Array]; var answer = 0;
  for (const C of ctors) { const sample: any = new C(2);`;

describe("#6651 E — zero-arg array HOFs throw TypeError", () => {
  it("throws for every/some/forEach/reduce/reduceRight on a dynamic view", async () => {
    expect(
      await run(`${DYN}
      try { sample.every(); } catch (e) { answer += (e instanceof TypeError) ? 1 : 0; }
      try { sample.some(); } catch (e) { answer += (e instanceof TypeError) ? 2 : 0; }
      try { sample.forEach(); } catch (e) { answer += (e instanceof TypeError) ? 4 : 0; }
      try { sample.reduce(); } catch (e) { answer += (e instanceof TypeError) ? 8 : 0; }
      try { sample.reduceRight(); } catch (e) { answer += (e instanceof TypeError) ? 16 : 0; }
    } return answer;`),
    ).toBe(31);
  });

  it("throws for a zero-arg HOF on a plain any-typed array too", async () => {
    expect(
      await run(`const a: any = [1, 2]; var answer = 0;
      try { a.every(); } catch (e) { answer += (e instanceof TypeError) ? 1 : 0; }
      try { a.map(); } catch (e) { answer += (e instanceof TypeError) ? 2 : 0; }
      return answer;`),
    ).toBe(3);
  });

  it("keeps a callable one-arg HOF working", async () => {
    expect(
      await run(`${DYN}
      answer = sample.every(function (v: any) { return v === 0; }) ? 1 : 0;
    } return answer;`),
    ).toBe(1);
  });
});

describe("#6651 E — sort comparefn IsCallable", () => {
  it("throws a TypeError for a present, non-callable comparator", async () => {
    expect(
      await run(`${DYN}
      try { sample.sort(null); } catch (e) { answer += (e instanceof TypeError) ? 1 : 0; }
      try { sample.sort(42); } catch (e) { answer += (e instanceof TypeError) ? 2 : 0; }
      try { sample.sort({}); } catch (e) { answer += (e instanceof TypeError) ? 4 : 0; }
      try { sample.sort([]); } catch (e) { answer += (e instanceof TypeError) ? 8 : 0; }
    } return answer;`),
    ).toBe(15);
  });

  it("does NOT throw for an absent, undefined or callable comparator", async () => {
    expect(
      await run(`${DYN}
      try { sample.sort(); answer += 1; } catch (e) { answer += 100; }
      try { sample.sort(undefined); answer += 2; } catch (e) { answer += 200; }
      try { sample.sort(function (a: any, b: any) { return a - b; }); answer += 4; } catch (e) { answer += 400; }
    } return answer;`),
    ).toBe(7);
  });
});

describe("#6651 E — ArrayBuffer.isView brands", () => {
  it("answers true for a dynamic view and false for its buffer", async () => {
    expect(
      await run(`${DYN}
      if (ArrayBuffer.isView(sample)) answer += 1;
      if (ArrayBuffer.isView(sample.buffer)) answer += 100;
    } return answer;`),
    ).toBe(1);
  });

  it("answers true for a DataView and false for a bare ArrayBuffer", async () => {
    expect(
      await run(`var answer = 0; const b: any = new ArrayBuffer(8);
      if (ArrayBuffer.isView(new DataView(b))) answer += 1;
      if (ArrayBuffer.isView(b)) answer += 100;
      return answer;`),
    ).toBe(1);
  });
});

describe("#6651 E — Symbol index argument on a dynamic view", () => {
  it("throws a TypeError from slice and subarray", async () => {
    expect(
      await run(`const s1: any = Symbol("1"); ${DYN}
      try { sample.slice(s1); } catch (e) { answer += (e instanceof TypeError) ? 1 : 0; }
      try { sample.slice(0, s1); } catch (e) { answer += (e instanceof TypeError) ? 2 : 0; }
      try { sample.subarray(s1); } catch (e) { answer += (e instanceof TypeError) ? 4 : 0; }
      try { sample.subarray(0, s1); } catch (e) { answer += (e instanceof TypeError) ? 8 : 0; }
    } return answer;`),
    ).toBe(15);
  });

  it("keeps ordinary numeric windows working", async () => {
    expect(
      await run(`const ctors: any[] = [Int8Array]; var answer = 0;
      for (const C of ctors) { const sample: any = new C(4);
        answer = sample.subarray(1, 3).length * 10 + sample.slice(1).length;
      } return answer;`),
    ).toBe(23);
  });
});
