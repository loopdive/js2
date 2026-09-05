// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4616 (jest deepCyclicCopy cluster) — `options = { ...defaults, ...options }`
// with `options` an OPTIONAL param:
// 1. The contextual type of the literal is `Opts | undefined`; the union's
//    empty getProperties() mis-read the shape as "non-specific" and routed the
//    literal to the host path, whose result null-casted back into the
//    struct-typed slot — every later member read threw.
// 2. On the struct path, the spread-source `struct.get` had no null guard, so
//    a runtime-undefined source trapped un-catchably ("dereferencing a null
//    pointer"). §13.2.5.5 CopyDataProperties SKIPS a nullish source.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(source: string) {
  const result = await compile(source, {
    testRuntime: true,
    fileName: "issue-4616-nullish-spread.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success).toBe(true);
  const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
  (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return wrapExports(instance, {
    signatures: (result as { exportSignatures?: unknown }).exportSignatures,
  }) as Record<string, (...args: unknown[]) => unknown>;
}

describe("#4616 nullish spread source", () => {
  it("param reassignment merges defaults when options is undefined and when given", async () => {
    const exp = await run(`
      type Opts = { keepPrototype?: boolean; tag?: string };
      function f(options?: Opts): string {
        options = { keepPrototype: false, tag: "d", ...options };
        return String(options.keepPrototype) + ":" + String(options.tag);
      }
      export function t(): string {
        return f() + "|" + f({ keepPrototype: true }) + "|" + f({ tag: "x" });
      }`);
    expect(exp.t!()).toBe("false:d|true:d|false:x");
  });

  it("deepCyclicCopy-shaped recursion with options threading does not trap", async () => {
    const exp = await run(`
      type Opts = { keepPrototype?: boolean };
      function copy(value: any, options?: Opts): any {
        options = { keepPrototype: false, ...options };
        if (typeof value !== "object" || value === null) return value;
        if (Array.isArray(value)) {
          const out: any[] = [];
          for (let i = 0; i < value.length; i++) out[i] = copy(value[i], { keepPrototype: options.keepPrototype });
          return out;
        }
        const o: any = {};
        for (const k of Object.keys(value)) o[k] = copy(value[k], { keepPrototype: options.keepPrototype });
        return o;
      }
      export function t(): string {
        const c: any = copy([null, 42, "foo", [1], { a: 2 }]);
        return String(c.length) + ":" + String(c[1]) + ":" + String(c[3][0]) + ":" + String(c[4].a);
      }`);
    expect(exp.t!()).toBe("5:42:1:2");
  });
});
