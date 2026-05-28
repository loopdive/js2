import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

// (#1528a) Dynamic `new <expr>()` where the callee is a runtime function value
// must perform IsConstructor and throw spec TypeError on failure. The compiler
// routes these calls through the host's `__reflect_construct`, which delegates
// to `Reflect.construct` — TypeError shape and message are guaranteed by the
// host engine.

async function run(src: string): Promise<unknown> {
  const r = compile(src, { fileName: "probe.ts" });
  expect(r.success).toBe(true);
  expect(r.errors).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject!);
  // biome-ignore lint/suspicious/noExplicitAny: test262-style export.
  return (instance.exports.test as any)?.();
}

describe("issue #1528a — dynamic new via __reflect_construct", () => {
  it("new <arrow-valued param>() throws TypeError caught by JS catch", async () => {
    const ret = await run(`export function test(): number {
      const arrow = (): number => 0;
      const x: any = arrow;
      try {
        new x();
        return 100;
      } catch (e: any) {
        if (e instanceof TypeError) return 1;
        return 200;
      }
    }`);
    expect(ret).toBe(1);
  });

  it("new <member-of-object-typed-any>() throws TypeError", async () => {
    const ret = await run(`export function test(): number {
      const obj: any = { fn: (): number => 0 };
      try {
        new obj.fn();
        return 100;
      } catch (e: any) {
        if (e instanceof TypeError) return 1;
        return 200;
      }
    }`);
    expect(ret).toBe(1);
  });

  it("new <unknown-typed Math.abs alias>() throws TypeError", async () => {
    const ret = await run(`export function test(): number {
      const f: any = Math.abs;
      try {
        new f(1);
        return 100;
      } catch (e: any) {
        if (e instanceof TypeError) return 1;
        return 200;
      }
    }`);
    expect(ret).toBe(1);
  });

  it("new <null>() throws TypeError (not 'cannot construct null' generic)", async () => {
    const ret = await run(`export function test(): number {
      const v: any = null;
      try {
        new v();
        return 100;
      } catch (e: any) {
        if (e instanceof TypeError) return 1;
        return 200;
      }
    }`);
    expect(ret).toBe(1);
  });
});
