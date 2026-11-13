// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7087 — the native repeat kernel used to double past the requested length
// and then substring the rope. Substring flattened the whole result, making
// the native-first string benchmark ~20x slower than the host-string lane.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

function watFunctionBody(wat: string, name: string): string {
  const starts = [...wat.matchAll(/^ {2}\(func \$([^\s(]+)/gm)].map((match) => ({
    name: match[1]!,
    index: match.index,
  }));
  const matches = starts.flatMap((entry, position) =>
    entry.name === name ? [wat.slice(entry.index, starts[position + 1]?.index ?? wat.length)] : [],
  );
  expect(matches, `unique WAT function $${name}`).toHaveLength(1);
  return matches[0]!;
}

function watCallTargets(wat: string, body: string): string[] {
  const imports = [...wat.matchAll(/^\s*\(import .+ \(func(?: \$([^\s(]+))?/gm)].map(
    (match) => match[1] ?? "<anonymous-import>",
  );
  const definitions = [...wat.matchAll(/^\s*\(func \$([^\s(]+)/gm)].map((match) => match[1]!);
  const names = [...imports, ...definitions];
  return [...body.matchAll(/\b(?:return_)?call (\d+)/g)].map((match) => {
    const target = names[Number(match[1])];
    if (!target) throw new Error(`WAT call ${match[1]} has no exact callable target`);
    return target;
  });
}

describe("#7087 native exact-rope repeat kernel", () => {
  it("builds exact repeated ropes without a flattening substring tail", async () => {
    const result = await compile(
      `
        export function benchmark(): number {
          let value = "";
          for (let index = 0; index < 1000; index++) value = value + "abcde";
          return value.length;
        }
        export function dynamicLength(count: number): number {
          return "abcde".repeat(count).length;
        }
      `,
      {
        fileName: "issue-7087-native-string-repeat-kernel.ts",
        semanticProviders: "native-first",
        emitWat: true,
        optimize: 0,
      },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

    const repeatBody = watFunctionBody(result.wat, "__sh_str_repeat");
    const repeatTargets = watCallTargets(result.wat, repeatBody);
    expect(repeatBody).toContain("f64.floor");
    expect(repeatTargets.filter((target) => target === "__str_concat")).toHaveLength(2);
    expect(repeatTargets.filter((target) => target === "__str_substring")).toEqual([]);

    const importObject = (result.importObject ?? {}) as WebAssembly.Imports & {
      __setInstance?: (instance: WebAssembly.Instance) => void;
    };
    const { instance } = await WebAssembly.instantiate(result.binary, importObject);
    importObject.__setInstance?.(instance);
    const benchmark = instance.exports.benchmark as () => number;
    const dynamicLength = instance.exports.dynamicLength as (count: number) => number;
    expect(benchmark()).toBe(5000);
    for (const count of [0, 1, 2, 3, 7, 32, 1000]) {
      expect(dynamicLength(count), `count=${count}`).toBe(5 * count);
    }
  });
});
