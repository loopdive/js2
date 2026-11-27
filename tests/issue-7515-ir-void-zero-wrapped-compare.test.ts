// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7515 — `void 0` / `undefined` inside a TS type wrapper (`as`, `<T>`, `satisfies`, `!`) is still `undefined`. The IR
// read the compare operand directly (`isUndefinedCompareOperand`) and classed a wrapped `void x` as a number
// (`isValueVoid` peeled parentheses only), so `(void 0 as any) === (void 0)` folded to false on the IR lane, gc and
// standalone, where legacy and node answer true. Both now read through `skipOuterExpressions`.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const SHAPES: readonly [string, boolean][] = [
  ["(void 0 as any) === (void 0)", true],
  ["(void 0 as any) === (void 0 as any)", true],
  ["(void 0)! === void 0", true],
  ["(undefined as any) === (void 0)!", true],
  ["(void 0 satisfies undefined) === void 0", true],
  ["(void 0 as any) !== (void 0)", false],
  ["(void 0 as any) == (void 0)", true],
  ["(void 0 as any) != (void 0)", false],
  ["(void 0 as any) == undefined", true],
];

async function answer(expression: string, target: "gc" | "standalone", experimentalIR: boolean): Promise<boolean> {
  const result = (await compile(`export function f(): boolean { return ${expression}; }`, {
    fileName: "t.ts",
    experimentalIR,
    ...(target === "standalone" ? { target: "standalone" } : {}),
  } as never)) as unknown as {
    success: boolean;
    errors?: { message: string }[];
    binary: Uint8Array;
    importObject?: WebAssembly.Imports;
  };
  expect(result.success, (result.errors ?? []).map((error) => error.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  return Boolean((instance.exports.f as () => number)());
}

describe("#7515 — a wrapped `void 0` / `undefined` compares as `undefined`", () => {
  for (const target of ["gc", "standalone"] as const)
    for (const experimentalIR of [true, false])
      it.each(SHAPES)(
        `${target}, ${experimentalIR ? "default (IR)" : "legacy"}: %s`,
        async (expression, expected) => {
          expect(new Function(`return ${expression.replace(/ as any| satisfies undefined|!(?=$|[ )])/g, "")};`)()).toBe(
            expected,
          );
          expect(await answer(expression, target, experimentalIR)).toBe(expected);
        },
        60_000,
      );
});
