// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7442 — a string builder asked for a result past the native string length limit throws RangeError, as node does
// past its own. `repeat` used to clamp the count and build a 2^31-1 string; `padStart` / `padEnd` trapped.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Target = "gc" | "standalone";

/** Runs `body` in an arrow and returns 1 when String(its value), or "RangeError" for a RangeError, equals `expected`. */
async function matches(body: string, expected: string, target: Target, experimentalIR?: false): Promise<number> {
  const source = `export function main(): number {
    let actual: string;
    try { actual = String((() => { ${body} })()); }
    catch (e) { actual = e instanceof RangeError ? "RangeError" : "other"; }
    return actual === ${JSON.stringify(expected)} ? 1 : 0;
  }`;
  const result = await compile(source, { fileName: "test.ts", target, experimentalIR });
  if (!result.success) throw new Error(result.errors.map((error) => error.message).join(" | "));
  const built = buildImports(result.imports, {}, result.stringPool);
  const imports = target === "standalone" ? {} : { env: built.env, string_constants: built.string_constants };
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return (instance.exports.main as () => number)();
}

// [body of an arrow returning a value, what `main` returns]
const CASES: readonly (readonly [string, string])[] = [
  ['return "a".repeat(9007199254740991).length;', "RangeError"],
  ['let n: number = 9007199254740991; return "a".repeat(n).length;', "RangeError"],
  ['return "ab".repeat(2147483647).length;', "RangeError"],
  ['return "a".padStart(9007199254740991).length;', "RangeError"],
  ['return "a".padEnd(4294967296, "b").length;', "RangeError"],
  // The spec's early returns come first: an empty receiver or fill, or a target not longer than the receiver.
  ['return "".repeat(9007199254740991).length;', "0"],
  ['return "a".padStart(9007199254740991, "").length;', "1"],
  ['return "abc".padEnd(2, "x");', "abc"],
  ['return "a".repeat(-1).length;', "RangeError"],
  ['return "ab".repeat(3);', "ababab"],
  ['return "7".padStart(3, "0");', "007"],
];

describe.each(["gc", "standalone"] as const)("#7442 — string builders past the length limit (%s)", (target) => {
  for (const experimentalIR of [undefined, false] as const) {
    const pipeline = experimentalIR === false ? "legacy" : "default";
    for (const [body, expected] of CASES) {
      it(`${pipeline}: ${body}`, async () => {
        expect(await matches(body, expected, target, experimentalIR)).toBe(1);
      });
    }
  }
});
