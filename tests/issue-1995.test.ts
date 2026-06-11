// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compileAndInstantiate } from "../src/runtime.js";

// #1995 — `arr.flat()` with no argument flattened depth 0 instead of the spec
//   default of 1: the omitted depth was emitted as `ref.null.extern`, arriving
//   in the host shim as JS `null`. The shim checked `depth === undefined`
//   (false for null), so it called `jsArr.flat(null)` →
//   ToIntegerOrInfinity(null) = 0 → a no-op copy. Fixed by treating both
//   `null` and `undefined` as "use the default of 1".
//
// #1996 — `_toJsArray` materialized only the OUTER vec; nested elements stayed
//   opaque WasmGC vec refs. `flat()`/`flatMap` couldn't recognize them
//   (Array.isArray false) and JSON.stringify rendered them as `null`. Fixed by
//   deeply unwrapping nested vec refs (and flatMap callback results) into real
//   JS arrays before the native flatten runs.
async function runStr(src: string): Promise<string> {
  const exports = (await compileAndInstantiate(src)) as { f: () => string };
  return exports.f();
}

describe("#1995 flat() omitted depth defaults to 1", () => {
  it("flat() with no argument flattens one level (not zero)", async () => {
    expect(
      await runStr(`
        export function f(): string {
          const a: any[] = [1, [2, 3], [4, [5]]];
          return JSON.stringify(a.flat());
        }
      `),
    ).toBe(JSON.stringify([1, [2, 3], [4, [5]]].flat()));
  });

  it("flat() ≡ flat(1)", async () => {
    expect(
      await runStr(`
        export function f(): string {
          const a: any[] = [1, [2, 3], [4, [5]]];
          return JSON.stringify(a.flat(1));
        }
      `),
    ).toBe(JSON.stringify([1, [2, 3], [4, [5]]].flat(1)));
  });

  it("flat(0) stays a no-op copy", async () => {
    expect(
      await runStr(`
        export function f(): string {
          const a: any[] = [1, [2, 3]];
          return JSON.stringify(a.flat(0));
        }
      `),
    ).toBe(JSON.stringify([1, [2, 3]].flat(0)));
  });
});

describe("#1996 flat/flatMap unwrap nested WasmGC vecs", () => {
  it("[[1,2],[3,4]].flat() yields the numbers, not [null,null]", async () => {
    expect(
      await runStr(`
        export function f(): string {
          const a: number[][] = [[1, 2], [3, 4]];
          return JSON.stringify(a.flat());
        }
      `),
    ).toBe(
      JSON.stringify(
        (
          [
            [1, 2],
            [3, 4],
          ] as number[][]
        ).flat(),
      ),
    );
  });

  it("flatMap unwraps callback-returned arrays", async () => {
    expect(
      await runStr(`
        export function f(): string {
          const a: number[] = [1, 2, 3];
          return JSON.stringify(a.flatMap((x: number) => [x, x * 2]));
        }
      `),
    ).toBe(JSON.stringify([1, 2, 3].flatMap((x) => [x, x * 2])));
  });

  it("flat(2) on a 3-deep vec-of-vec flattens two levels", async () => {
    expect(
      await runStr(`
        export function f(): string {
          const a: any[] = [1, [2, [3, [4]]]];
          return JSON.stringify(a.flat(2));
        }
      `),
    ).toBe(JSON.stringify([1, [2, [3, [4]]]].flat(2)));
  });

  it("flat(Infinity) fully flattens nested vecs", async () => {
    expect(
      await runStr(`
        export function f(): string {
          const a: any[] = [1, [2, [3, [4, [5]]]]];
          return JSON.stringify(a.flat(Infinity));
        }
      `),
    ).toBe(JSON.stringify([1, [2, [3, [4, [5]]]]].flat(Infinity)));
  });

  it("flatMap returning nested arrays flattens exactly one level", async () => {
    expect(
      await runStr(`
        export function f(): string {
          const a: number[] = [1, 2];
          return JSON.stringify(a.flatMap((x: number) => [[x]]));
        }
      `),
    ).toBe(JSON.stringify([1, 2].flatMap((x) => [[x]])));
  });
});
