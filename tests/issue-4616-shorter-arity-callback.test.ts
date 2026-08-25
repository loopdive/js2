// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4616 — a typed callback call site must dispatch a SHORTER-arity callback
// compiled in a LATER module. jest's diff-sequences declares
// `foundSubsequence(nCommon, aCommon, bCommon)` while every test passes a
// 1-param arrow; the closureInfoByTypeIdx retention scan only sees closures
// already compiled, so the cross-module arrow's funcref type was missing from
// the dispatch cascade and the terminal threw TypeError.

import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";

async function compileAndRunMulti(files: Record<string, string>, entryFile: string) {
  const result = await compileMulti(files, entryFile);
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
  (result.importObject as { __setExports?: (e: WebAssembly.Exports) => void }).__setExports?.(instance.exports);
  return instance.exports as Record<string, Function>;
}

describe("#4616 cross-module shorter-arity callbacks", () => {
  it("invokes a 1-param arrow where the declared callback type has 3 params", async () => {
    const files = {
      "./lib.ts": `
        type IsCommon = (aIndex: number, bIndex: number) => boolean;
        type Found = (nCommon: number, aCommon: number, bCommon: number) => void;
        const countF = (
          aIndex: number,
          aEnd: number,
          bIndex: number,
          bEnd: number,
          isCommon: IsCommon,
        ): number => {
          let n = 0;
          while (aIndex < aEnd && bIndex < bEnd && isCommon(aIndex, bIndex)) {
            aIndex += 1; bIndex += 1; n += 1;
          }
          return n;
        };
        export default function diffSequence(
          aLength: number,
          bLength: number,
          isCommon: IsCommon,
          foundSubsequence: Found,
        ): void {
          const nCommonF = countF(0, aLength, 0, bLength, isCommon);
          if (nCommonF !== 0) foundSubsequence(nCommonF, 0, 0);
        }
      `,
      "./main.ts": `
        import diff from "./lib";
        export function run(): string {
          const a = [1, 2]; const b = [1, 2];
          let n = 0;
          diff(a.length, b.length, (ai: number, bi: number) => a[ai] === b[bi], (nc: number) => { n += nc; });
          return "n=" + n;
        }
      `,
    };
    const e = await compileAndRunMulti(files, "./main.ts");
    expect(e.run()).toBe("n=2");
  });
});
