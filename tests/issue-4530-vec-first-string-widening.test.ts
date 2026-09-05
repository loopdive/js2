// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4530 (clsx 'functions' residual) — VEC-FIRST literal widening. In
// `[[fn], 'world']` the first-element heuristic picked the nested array's vec
// type for the whole literal, so the STRING element was coerced string→vec —
// split into its char array ("world" read back as "w,o,r,l,d", and clsx
// joined it as "hello w o r l d"). A vec-first literal with any non-vec
// element must widen its carrier to externref.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

describe("#4530 vec-first heterogeneous literal", () => {
  it("keeps a string element intact next to a nested array", async () => {
    const result = await compile(
      `export function t(): string {
         const fnv = () => {};
         const arr: any = [[fnv], 'world'];
         return String(arr[1]) + ":" + String((arr[0] as unknown[]).length);
       }`,
      { testRuntime: true, fileName: "issue-4530-vecfirst.ts", skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
    (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exp = wrapExports(instance, { signatures: (result as { exportSignatures?: unknown }).exportSignatures }) as {
      t: () => string;
    };
    expect(exp.t()).toBe("world:1");
  });

  it("homogeneous nested-array literals keep their vec carrier", async () => {
    const result = await compile(
      `export function t(): number {
         const m = [[1, 2], [3, 4]];
         return m[0][1] + m[1][0];
       }`,
      { testRuntime: true, fileName: "issue-4530-homog.ts", skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
    (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exp = wrapExports(instance, { signatures: (result as { exportSignatures?: unknown }).exportSignatures }) as {
      t: () => number;
    };
    expect(exp.t()).toBe(5);
  });
});
