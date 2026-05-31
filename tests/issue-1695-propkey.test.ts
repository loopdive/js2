// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #1695 — PropertyAssignment form with computed [Symbol.dispose] /
 * [Symbol.asyncDispose] keys was silently dropped at literals.ts:344, so
 * `DisposableStack.use({ [Symbol.dispose]: () => … })` never invoked the
 * disposer. The MethodDeclaration form (`{ [Symbol.dispose]() {} }`) was
 * already routed correctly via #1433.
 *
 * Fix: extend the disposal-method detector + the PropertyAssignment branch
 * in `compileObjectLiteralAsExternref`'s sibling (the
 * `compileObjectLiteralWithAccessors` walker) so both shapes box the
 * well-known symbol via `__box_symbol` and store the value under the real
 * Symbol property.
 */

async function run(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool) as Record<string, unknown>;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  const exp = instance.exports as Record<string, unknown>;
  if (typeof (imports as { setExports?: (e: unknown) => void }).setExports === "function") {
    (imports as { setExports: (e: unknown) => void }).setExports(exp);
  }
  const fn = exp.test as (() => unknown) | undefined;
  if (typeof fn !== "function") throw new Error("no test() export");
  return fn();
}

describe("#1695 PropertyAssignment computed-key (Symbol.dispose)", () => {
  it("[Symbol.dispose] arrow property is invoked by DisposableStack.use()", async () => {
    const src = `
      export function test(): number {
        let called = 0;
        const resource: any = {
          [Symbol.dispose]: () => {
            called = called + 1;
          },
        };
        const stack = new DisposableStack();
        stack.use(resource);
        stack.dispose();
        return called;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("[Symbol.dispose] function-expression property is invoked by DisposableStack.use()", async () => {
    const src = `
      export function test(): number {
        let called = 0;
        const resource: any = {
          [Symbol.dispose]: function () {
            called = called + 2;
          },
        };
        const stack = new DisposableStack();
        stack.use(resource);
        stack.dispose();
        return called;
      }
    `;
    expect(await run(src)).toBe(2);
  });

  it("[Symbol.asyncDispose] arrow property survives the routing change", async () => {
    // Property is reachable under the real Symbol.asyncDispose key; we don't
    // invoke the disposer (await semantics are out of scope for this fix).
    const src = `
      declare function check(o: any): number;
      export function test(): number {
        const r: any = {
          [Symbol.asyncDispose]: () => 7,
        };
        return check(r);
      }
    `;
    const result = await compile(src, { fileName: "test.ts" });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool) as Record<string, unknown> & {
      env?: Record<string, unknown>;
    };
    imports.env = imports.env ?? {};
    imports.env.check = (o: unknown) => {
      const cb = (o as { [k: symbol]: unknown })[Symbol.asyncDispose];
      return typeof cb === "function" ? 1 : 0;
    };
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const exp = instance.exports as Record<string, unknown>;
    if (typeof (imports as { setExports?: (e: unknown) => void }).setExports === "function") {
      (imports as { setExports: (e: unknown) => void }).setExports(exp);
    }
    const fn = exp.test as () => number;
    expect(fn()).toBe(1);
  });

  it("Non-symbol computed string key works via PropertyAssignment", async () => {
    const src = `
      export function test(): number {
        const k = "foo";
        const obj: any = { [k]: 42 };
        return obj.foo;
      }
    `;
    expect(await run(src)).toBe(42);
  });

  it("Mixed disposal + plain string keys preserved", async () => {
    const src = `
      export function test(): number {
        let n = 0;
        const r: any = {
          tag: "x",
          [Symbol.dispose]: () => { n = n + 5; },
        };
        const stack = new DisposableStack();
        stack.use(r);
        stack.dispose();
        return n;
      }
    `;
    expect(await run(src)).toBe(5);
  });
});
