// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3774 — quantified backreferences to empty captures must stop repeating once
 * their minimum is satisfied. RepeatMatcher §22.2.2.3.1 explicitly uses
 * `/(a*)b\1+/` as the empty-progress example.
 */
import { describe, expect, it } from "vitest";
import { compilePattern } from "../src/codegen/regex/compile.js";
import { search } from "../src/codegen/regex/vm.js";
import { compile } from "../src/index.js";

describe("#3774 quantified empty-backreference progress", () => {
  it("matches the spec example in the reference VM", () => {
    const compiled = compilePattern("(a*)b\\1+", 0);
    const match = search(compiled.prog, compiled.classTable, compiled.nGroups, "baaaac", 0, false, compiled.nScratch);

    expect(match).not.toBeNull();
    expect(Array.from(match!.slice(0, 4))).toEqual([0, 1, 0, 0]);
  });

  it("matches the spec example in standalone Wasm", async () => {
    const source = `
      const match = /(a*)b\\1+/.exec("baaaac")!;
      export function wholeLength(): number { return match[0]!.length; }
      export function captureLength(): number { return match[1]!.length; }
    `;
    const result = await compile(source, { fileName: "test.ts", target: "standalone" });
    expect(result.success, result.success ? "" : result.errors?.[0]?.message).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    const exports = instance.exports as { wholeLength(): number; captureLength(): number };

    expect(exports.wholeLength()).toBe(1);
    expect(exports.captureLength()).toBe(0);
  });

  it("keeps consuming backreference repetitions greedy", async () => {
    const source = `
      const match = /(a)b\\1+/.exec("abaaac")!;
      export function wholeLength(): number { return match[0]!.length; }
    `;
    const result = await compile(source, { fileName: "test.ts", target: "standalone" });
    expect(result.success, result.success ? "" : result.errors?.[0]?.message).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});

    expect((instance.exports as { wholeLength(): number }).wholeLength()).toBe(5);
  });
});
