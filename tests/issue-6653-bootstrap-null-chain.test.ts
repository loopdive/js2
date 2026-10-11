// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6653 — the three-defect chain behind deno_core's `__module_init`
// "Cannot destructure 'null' or 'undefined'" (see the issue file):
//  1. nested-function binding-pattern params must widen to externref (#862 gap),
//  2. `"get" in desc` must not fold true from an OPTIONAL declared property,
//  3. an argument-position class expression keeps its prototype edge
//     (standalone class-object singleton, #4618 gate widened).
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.ts";

async function runStandalone(src: string): Promise<Record<string, any>> {
  const result = await compileMulti({ "/m/e.js": src }, "/m/e.js", {
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  if (!result.success) {
    throw new Error(result.errors.map((e) => e.message).join("\n"));
  }
  const inst = await WebAssembly.instantiate(new WebAssembly.Module(result.binary), {});
  const ex = inst.exports as Record<string, any>;
  (ex.__module_init as (() => void) | undefined)?.();
  return ex;
}

describe("#6653 — deno bootstrap __module_init null chain", () => {
  it("nested function's destructured param receives a dynamic descriptor (not null)", async () => {
    const ex = await runStandalone(`
      let step = 0;
      (() => {
        function acc(key, { enumerable, get, set }) { step += typeof get === "function" ? 100 : 1; }
        function walk(src2) {
          for (const key of Reflect.ownKeys(src2)) {
            const desc = Reflect.getOwnPropertyDescriptor(src2, key);
            if (desc != null) acc(key, desc);
          }
        }
        walk({ a: 1, get b() { return 2; } });
      })();
      export function getStep() { return step; }
    `);
    // data prop `a` → get undefined (+1); accessor `b` → get function (+100).
    expect(ex.getStep()).toBe(101);
  });

  it('"get" in a data descriptor answers false (optional declared prop is not presence)', async () => {
    const ex = await runStandalone(`
      let step = 0;
      const desc = Reflect.getOwnPropertyDescriptor({ x: 1 }, "x");
      if (desc != null) {
        step += "get" in desc ? 1000 : 1;
        step += "zzz" in desc ? 10000 : 2;
        step += "value" in desc ? 40 : 20000;
        step += typeof desc.get === "undefined" ? 400 : 200000;
      }
      export function getStep() { return step; }
    `);
    expect(ex.getStep()).toBe(443);
  });

  it("argument-position class expression exposes .prototype through an any param", async () => {
    const ex = await runStandalone(`
      let step = 0;
      function f(safe) {
        const p = safe.prototype;
        step += p == null ? 2000 : (typeof p === "object" ? 10 : 4000);
      }
      f(class Safe extends Map { });
      export function getStep() { return step; }
    `);
    expect(ex.getStep()).toBe(10);
  });
});
