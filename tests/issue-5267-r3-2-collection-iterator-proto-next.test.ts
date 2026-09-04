// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5267 R3-2 (metadata slice) — `%MapIteratorPrototype%` and
// `%SetIteratorPrototype%` own a `next` data property (§24.1.5.2 / §24.2.5.2)
// whose value is a function with `name: "next"` and `length: 0`.
//
// Before this the two singletons carried only `@@toStringTag`, so
// `Object.getOwnPropertyDescriptor(proto, "next")` read `undefined` and the
// `*IteratorPrototype/next/{name,length}.js` rows died with "Cannot convert
// undefined or null to object".
//
// SCOPE: this seeds the descriptor-carrying closure (the String-iterator
// recipe, refusal body). Calling `proto.next.call(record)` is NOT made to
// step the record here — that is the rest of R3-2 and stays open.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<{ value: number; hostImports: string[] }> {
  const result = await compile(source, {
    fileName: "test.ts",
    target: "standalone",
    deferTopLevelInit: true,
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  const module = await WebAssembly.compile(result.binary);
  const hostImports = WebAssembly.Module.imports(module).map((i) => `${i.module}::${i.name}`);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as Record<string, unknown>;
  (exports.__module_init as (() => void) | undefined)?.();
  return { value: (exports.test as () => number)(), hostImports };
}

describe("#5267 R3-2 — collection iterator prototypes own a `next` function", () => {
  it('MapIteratorPrototype.next has name "next" and length 0', async () => {
    const { value, hostImports } = await runStandalone(
      `var proto = Object.getPrototypeOf(new Map().keys());
       var d = Object.getOwnPropertyDescriptor(proto, "next");
       var score = 0;
       if (d !== undefined) score += 1;
       if (typeof d.value === "function") score += 2;
       if (d.value.name === "next") score += 4;
       if (d.value.length === 0) score += 8;
       if (d.enumerable === false) score += 16;
       export function test(): number { return score; }`,
    );
    expect(hostImports).toEqual([]);
    expect(value).toBe(31);
  });

  it('SetIteratorPrototype.next has name "next" and length 0', async () => {
    const { value, hostImports } = await runStandalone(
      `var proto = Object.getPrototypeOf(new Set().values());
       var d = Object.getOwnPropertyDescriptor(proto, "next");
       var score = 0;
       if (d !== undefined) score += 1;
       if (typeof d.value === "function") score += 2;
       if (d.value.name === "next") score += 4;
       if (d.value.length === 0) score += 8;
       if (d.enumerable === false) score += 16;
       export function test(): number { return score; }`,
    );
    expect(hostImports).toEqual([]);
    expect(value).toBe(31);
  });
});
