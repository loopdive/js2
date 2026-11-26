// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2012 — Object.freeze of an inline literal was a no-op for struct receivers.
//
// `Object.freeze(o)` (identifier arg) marked `o` in ctx.frozenVars, so the
// write-path threw and isFrozen reported true. But `const o = Object.freeze({a:1})`
// passes an inline literal (not an identifier), so nothing was tracked: the
// strict write silently succeeded-as-noop and isFrozen returned false
// ("false,1,false" vs Node "true,1,true"). Fix: when the freeze/seal/
// preventExtensions CALL is the initializer of a variable declaration, mark the
// DECLARED variable instead of the (non-identifier) argument.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

async function runStr(source: string): Promise<string> {
  const r = await compile(source, { fileName: "issue-2012.ts" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const instance = await instantiateWithRuntime(r);
  return (instance.exports as Record<string, () => string>).test();
}

describe("#2012 Object.freeze of inline literal (struct receiver)", () => {
  it("const o = Object.freeze({a:1}): strict write throws, value kept, isFrozen true", async () => {
    expect(
      await runStr(`export function test(): string {
        const o: any = Object.freeze({ a: 1 });
        let threw = false;
        try { o.a = 2; } catch { threw = true; }
        return String(threw) + "," + String(o.a) + "," + String(Object.isFrozen(o));
      }`),
    ).toBe("true,1,true");
  });

  it("let o = Object.freeze({a:1}) is also tracked", async () => {
    expect(
      await runStr(`export function test(): string {
        let o: any = Object.freeze({ a: 1 });
        let threw = false;
        try { o.a = 2; } catch { threw = true; }
        return String(threw) + "," + String(Object.isFrozen(o));
      }`),
    ).toBe("true,true");
  });

  it("identifier-arg freeze still works (unchanged)", async () => {
    expect(
      await runStr(`export function test(): string {
        const obj: any = { a: 1 };
        Object.freeze(obj);
        let threw = false;
        try { obj.a = 2; } catch { threw = true; }
        return String(threw) + "," + String(obj.a) + "," + String(Object.isFrozen(obj));
      }`),
    ).toBe("true,1,true");
  });

  it("const o = Object.seal({a:1}) marks the variable sealed", async () => {
    expect(
      await runStr(`export function test(): string {
        const o: any = Object.seal({ a: 1 });
        return String(Object.isSealed(o));
      }`),
    ).toBe("true");
  });

  it("a non-frozen object remains writable (no false positive)", async () => {
    expect(
      await runStr(`export function test(): string {
        const o: any = { a: 1 };
        let threw = false;
        try { o.a = 2; } catch { threw = true; }
        return String(threw) + "," + String(o.a) + "," + String(Object.isFrozen(o));
      }`),
    ).toBe("false,1,false");
  });
});
