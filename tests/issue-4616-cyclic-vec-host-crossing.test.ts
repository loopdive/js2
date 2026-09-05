// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4616 (jest deepCyclicCopy family) — a self-referencing wasm vec crossing to
// the host (`a.push(a); new Set(a)`) recursed until "Maximum call stack size
// exceeded": `__make_iterable`'s convertToJS memoized the mirror ARRAY OBJECT
// but re-ran the fill on every entry, and `_convertIterableForHost` had no
// cycle guard at all. Both now hand an in-flight cycle the same output
// identity.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

describe("#4616 cyclic vec host crossing", () => {
  it("a self-referencing array crosses into new Set without overflowing", async () => {
    const result = await compile(
      `export function t(): string {
         const a: unknown[] = [1];
         a.push(a);
         const s = new Set(a as any);
         return "size=" + String((s as { size: number }).size);
       }`,
      { testRuntime: true, fileName: "issue-4616-cyc.ts", skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
    (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exp = wrapExports(instance, { signatures: (result as { exportSignatures?: unknown }).exportSignatures }) as {
      t: () => string;
    };
    expect(exp.t()).toBe("size=2");
  });
});
