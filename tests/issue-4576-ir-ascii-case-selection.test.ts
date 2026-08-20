// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { expect, it } from "vitest";

import { type CompileResult, compile } from "../src/index.js";

function parseWatFunctions(wat: string): readonly { readonly name: string; readonly body: string }[] {
  const starts = [...wat.matchAll(/^ {2}\(func \$([^\s(]+)/gm)].map((match) => ({
    name: match[1]!,
    index: match.index,
  }));
  return starts.map(({ name, index }, position) => ({
    name,
    body: wat.slice(index, starts[position + 1]?.index ?? wat.length),
  }));
}

function watCallTargets(result: CompileResult, functionName: string): string[] {
  const functions = parseWatFunctions(result.wat);
  const matches = functions.filter(({ name }) => name === functionName);
  expect(matches, `unique WAT function $${functionName}`).toHaveLength(1);
  const imports = [...result.wat.matchAll(/^\s*\(import .+ \(func(?: \$([^\s(]+))?/gm)].map(
    (match) => match[1] ?? "<anonymous-import>",
  );
  const names = [...imports, ...functions.map(({ name }) => name)];
  return [...matches[0]!.body.matchAll(/\b(?:return_)?call (\d+)/g)].map(
    (match) => names[Number(match[1])] ?? "<missing>",
  );
}

it("selects compact native case helpers only from proven-ASCII IR receiver evidence", async () => {
  const previousInline = process.env.JS2WASM_IR_INLINE;
  const previousAsciiCase = process.env.JS2WASM_NATIVE_PROVEN_ASCII_CASE;
  process.env.JS2WASM_IR_INLINE = "0";
  Reflect.deleteProperty(process.env, "JS2WASM_NATIVE_PROVEN_ASCII_CASE");
  try {
    const result = await compile(
      `
        export function asciiUpper(): string { return "alpha".toUpperCase(); }
        export function asciiLower(): string {
          const value = "BRAVO";
          return value.toLowerCase();
        }
        export function unicodeUpper(): string { return "straße".toUpperCase(); }
        export function dynamicUpper(value: string): string { return value.toUpperCase(); }
      `,
      {
        fileName: "issue-4576-ir-ascii-case-selection.ts",
        target: "standalone",
        experimentalIR: true,
        trackFallbacks: true,
        trackIrOutcomes: true,
        emitWat: true,
      },
    );
    expect(result.success, result.success ? "" : result.errors.map(({ message }) => message).join("\n")).toBe(true);
    for (const name of ["asciiUpper", "asciiLower", "unicodeUpper", "dynamicUpper"] as const) {
      expect(result.irOutcomes?.filter(({ displayName }) => displayName === name)).toEqual([
        expect.objectContaining({ kind: "emitted", irBodyEmitted: true, legacyBodyEmitted: false }),
      ]);
    }

    expect(watCallTargets(result, "asciiUpper")).toContain("__str_toUpperCase_ascii");
    expect(watCallTargets(result, "asciiLower")).toContain("__str_toLowerCase_ascii");
    expect(watCallTargets(result, "unicodeUpper")).toContain("__str_toUpperCase_uni");
    expect(watCallTargets(result, "unicodeUpper")).not.toContain("__str_toUpperCase_ascii");
    expect(watCallTargets(result, "dynamicUpper")).toContain("__str_toUpperCase_uni");
    expect(watCallTargets(result, "dynamicUpper")).not.toContain("__str_toUpperCase_ascii");
  } finally {
    if (previousInline === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_INLINE");
    else process.env.JS2WASM_IR_INLINE = previousInline;
    if (previousAsciiCase === undefined) Reflect.deleteProperty(process.env, "JS2WASM_NATIVE_PROVEN_ASCII_CASE");
    else process.env.JS2WASM_NATIVE_PROVEN_ASCII_CASE = previousAsciiCase;
  }
});
