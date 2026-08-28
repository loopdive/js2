// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Deno's primordials build SafePromise as a direct Promise subclass and feed
// its inherited combinators a SafeArrayIterator instance. At the combinator
// call site the iterator has already been constructed, so the lowered carrier
// can expose only `next()`; no module-wide `@@iterator` dispatcher is needed.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const PROMISE_COMBINATOR_IMPORTS = new Set(["Promise_all", "Promise_allSettled", "Promise_any", "Promise_race"]);

describe("Deno SafePromise native combinators", () => {
  it("lowers direct inherited combinators over an already-created iterator without Promise host imports", async () => {
    const result = await compile(
      `
declare function __drain_microtasks(): void;

class SafePromise extends Promise<any> {
  constructor(executor: any) { super(executor); }
}

class SafeArrayIterator {
  private index = 0;
  private value = 0;
  constructor(value: number) { this.value = value; }
  next(): { value: any; done: boolean } {
    this.index = this.index + 1;
    return this.index === 1
      ? { value: this.value, done: false }
      : { value: undefined, done: true };
  }
}

let score = 0;
export function test(): number {
  SafePromise.all(new SafeArrayIterator(11) as any).then((values: any) => {
    if (values[0] === 11) score = score + 1;
  });
  SafePromise.race(new SafeArrayIterator(22) as any).then((value: any) => {
    if (value === 22) score = score + 10;
  });
  SafePromise.allSettled(new SafeArrayIterator(33) as any).then((values: any) => {
    if (values.length === 1) score = score + 100;
  });
  SafePromise.any(new SafeArrayIterator(44) as any).then((value: any) => {
    if (value === 44) score = score + 1000;
  });
  __drain_microtasks();
  return score;
}
`,
      {
        fileName: "deno-safe-promise.ts",
        target: "standalone",
        emitWat: true,
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, result.success ? "" : JSON.stringify(result.errors?.slice(0, 3))).toBe(true);
    expect((result.imports ?? []).filter((entry) => PROMISE_COMBINATOR_IMPORTS.has(entry.name))).toEqual([]);
    expect(result.wat).toContain("__call_next");
    expect(result.wat).not.toContain("__call_@@iterator");
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as { test(): number }).test()).toBe(1111);
  });

  it("keeps explicit Promise.all.call(Subclass, iterable) on the constructor-aware route", async () => {
    const result = await compile(
      `
class SafePromise extends Promise<any> {}
export function test(): any {
  return Promise.all.call(SafePromise, [] as any);
}
`,
      {
        fileName: "deno-safe-promise-explicit-call.ts",
        target: "standalone",
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, result.success ? "" : JSON.stringify(result.errors?.slice(0, 3))).toBe(true);
    expect((result.imports ?? []).map((entry) => entry.name)).toContain("Promise_all");
  });
});
