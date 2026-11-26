// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1970 — for (const [k, v] of map) yielded the FIRST entry on every
// iteration. The externref destructure helper's materialization fallbacks
// are gated on `ref.is_null __dparam_cvt_*`; the local was never reset to
// null at the start of the emitted sequence, so inside a loop iteration 2
// found iteration 1's vec non-null, skipped re-materializing, and
// destructured the stale values. The fix resets the conversion buffer to
// null on every execution of the sequence.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

async function compileAndRun(source: string, fnName = "test"): Promise<unknown> {
  const r = await compile(source);
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "<unknown>"}`);
  }
  const instance = await instantiateWithRuntime(r, ENV_STUB);
  const fn = instance.exports[fnName] as (...a: unknown[]) => unknown;
  return fn();
}

describe("#1970 — destructure-in-loop must re-materialize per iteration", () => {
  it("for (const [k, v] of map) yields every entry", async () => {
    const out = await compileAndRun(`
      export function test(): string {
        const m = new Map<string, number>();
        m.set("a", 1); m.set("b", 2); m.set("c", 3);
        let r = "";
        for (const [k, v] of m) r += k + "=" + v + ";";
        return r;
      }
    `);
    expect(out).toBe("a=1;b=2;c=3;");
  });

  it("body-form destructuring (const [k, v] = e as any) yields every entry", async () => {
    const out = await compileAndRun(`
      export function test(): string {
        const m = new Map<string, number>();
        m.set("x", 10); m.set("y", 20);
        let r = "";
        for (const e of m) {
          const [k, v] = e as any;
          r += k + ":" + v + ";";
        }
        return r;
      }
    `);
    expect(out).toBe("x:10;y:20;");
  });

  it("for (const [k, v] of Object.entries(obj)) yields every entry", async () => {
    const out = await compileAndRun(`
      export function test(): string {
        const o = { p: 1, q: 2, r: 3 };
        let r = "";
        for (const [k, v] of Object.entries(o)) r += k + "=" + v + ";";
        return r;
      }
    `);
    expect(out).toBe("p=1;q=2;r=3;");
  });

  it("destructuring with defaults in a loop re-evaluates per iteration", async () => {
    const out = await compileAndRun(`
      export function test(): string {
        const m = new Map<string, number>();
        m.set("a", 1); m.set("b", 2);
        let r = "";
        for (const [k, v = 99] of m) r += k + "=" + v + ";";
        return r;
      }
    `);
    expect(out).toBe("a=1;b=2;");
  });

  it("single-execution param destructuring is unregressed", async () => {
    const out = await compileAndRun(`
      function pick([a, b]: any): number {
        return a + b;
      }
      export function test(): number {
        const m = new Map<string, number>();
        m.set("k", 41);
        let r = 0;
        for (const e of m) r = pick(e as any) === 0 ? r : r + 1;
        return pick([20, 22] as any);
      }
    `);
    expect(out).toBe(42);
  });

  it("repeated calls to a destructuring function see fresh values", async () => {
    const out = await compileAndRun(`
      function first([a]: any): any {
        return a;
      }
      export function test(): string {
        const m = new Map<string, string>();
        m.set("one", "1"); m.set("two", "2");
        let r = "";
        for (const e of m) r += first(e as any) + ";";
        return r;
      }
    `);
    expect(out).toBe("one;two;");
  });
});
