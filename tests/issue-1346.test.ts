// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1346 — first native-generator slice for YieldExpression evaluation.
//
// ECMA-262 §15.5.5 evaluates `yield expr` by evaluating `expr`, yielding that
// value, then using the next resumption completion as the value of the yield
// expression. §27.5.3.4 resumes a suspended generator with a return completion
// for `.return(value)`, which must run any active `finally` blocks before the
// generator completes.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const HOST_GEN_ITER_RE = /^(__gen_|__create_generator|__create_async_generator|__iterator)/;

async function instantiateStandalone(source: string): Promise<{
  exports: Record<string, Function>;
  imports: string[];
}> {
  const result = await compile(source, { fileName: "issue-1346.ts", target: "standalone" });
  expect(result.success, result.success ? "" : `compile error: ${result.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(mod)
    .filter((i) => i.module === "env" && HOST_GEN_ITER_RE.test(i.name))
    .map((i) => `${i.module}::${i.name}`);
  const instance = await WebAssembly.instantiate(mod, {});
  return { exports: instance.exports as Record<string, Function>, imports };
}

describe("#1346 native generator yield expression order", () => {
  it("uses values passed to .next(value) as sequential yield-expression results", async () => {
    const { exports, imports } = await instantiateStandalone(`
      function* gen(): Generator<number, number, number> {
        const a: number = yield 1;
        const b: number = yield 2;
        return a * 10 + b;
      }

      export function run(): number {
        const g = gen();
        const r1 = g.next();
        const r2 = g.next(4);
        const r3 = g.next(7);
        return r1.value * 10000 + r2.value * 1000 + r3.value * 10 + (r3.done ? 1 : 0);
      }
    `);

    expect(imports).toEqual([]);
    expect((exports.run as () => number)()).toBe(12471);
  });

  it("runs a pending finally when .return(value) resumes at a suspended yield", async () => {
    const { exports, imports } = await instantiateStandalone(`
      let log = 0;

      function* gen(): Generator<number, number, number> {
        try {
          log = log + 1;
          yield 5;
          log = log + 100;
        } finally {
          log = log + 10;
        }
        return log;
      }

      export function run(): number {
        const g = gen();
        const first = g.next();
        const ret = g.return(77);
        const after = g.next();
        return log * 10000 + first.value * 1000 + (ret.done ? 100 : 0) + ret.value + (after.done ? 1 : 0);
      }
    `);

    expect(imports).toEqual([]);
    expect((exports.run as () => number)()).toBe(115178);
  });

  it("runs finally on the normal resume path after a yield in try", async () => {
    const { exports, imports } = await instantiateStandalone(`
      let log = 0;

      function* gen(): Generator<number, number, number> {
        try {
          yield 1;
          log = log + 2;
        } finally {
          log = log + 10;
        }
        return log;
      }

      export function run(): number {
        const g = gen();
        g.next();
        const r = g.next(0);
        return r.value + (r.done ? 100 : 0);
      }
    `);

    expect(imports).toEqual([]);
    expect((exports.run as () => number)()).toBe(112);
  });

  it("does not enter the body when .return(value) is called before the first next", async () => {
    const { exports, imports } = await instantiateStandalone(`
      let log = 0;

      function* gen(): Generator<number, number, number> {
        try {
          log = 1;
          yield 2;
        } finally {
          log = 10;
        }
        return log;
      }

      export function run(): number {
        const g = gen();
        const r = g.return(33);
        return log * 100 + r.value + (r.done ? 1000 : 0);
      }
    `);

    expect(imports).toEqual([]);
    expect((exports.run as () => number)()).toBe(1033);
  });
});
