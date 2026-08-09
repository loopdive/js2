// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3024 — `super.<x>` inside a STATIC method emitted a call one argument short.
 *
 * `compileSuperMethodCallCore` / `compileSuperPropertyAccess`
 * (src/codegen/expressions/new-super.ts) both push the receiver only when a
 * `this` local exists:
 *
 *     const selfIdx = fctx.localMap.get("this");
 *     if (selfIdx !== undefined) { fctx.body.push({ op: "local.get", ... }); }
 *
 * ...but then assumed a receiver had ALWAYS been pushed. A static method has no
 * `this` local, and the parent's compiled static method has no receiver param
 * either, so the hardcoded `paramTypes.length - 1` self-offset was wrong:
 *   - the first real argument was mis-binned as an "extra" arg and DROPPED, and
 *   - the pad loop started at `args.length + 1`, past the end, so padded nothing
 * leaving `not enough arguments on the stack for call (need N, got N-1)` —
 * invalid Wasm. The arithmetic reproduces the observed errors exactly:
 *   Base_g(v)    → len 1, count 0 → 0 pushed, need 1 → "need 1, got 0"
 *   Base_g(a,b)  → len 2, count 1 → 1 pushed, need 2 → "need 2, got 1"
 *   0-arg        → len 0, count -1 → nothing needed → was already VALID
 *
 * Fix: track the offset from what was ACTUALLY pushed (`selfOffset = pushedSelf
 * ? 1 : 0`), and in the getter path pad any param slot left unfilled.
 *
 * This is a GENERAL correctness bug — any `super.m(arg)` or `super.<getter>` in
 * a static method mis-compiled, not just the test262 rows that surfaced it.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { compileAndRunTestNumber } from "./helpers/compile.ts";

async function validates(src: string): Promise<{ ok: boolean; msg: string }> {
  const r: any = await compile(src, { fileName: "t.ts" });
  if (!r.success) return { ok: false, msg: `compile failed: ${(r.errors ?? [])[0]?.message ?? "?"}` };
  if (WebAssembly.validate(r.binary)) return { ok: true, msg: "" };
  let msg = "invalid";
  try {
    await WebAssembly.compile(r.binary);
  } catch (e: any) {
    msg = String(e.message).split("\n")[0];
  }
  return { ok: false, msg };
}

describe("#3024 — super.<x> arity inside a static method", () => {
  // ---- the two shapes that emitted invalid Wasm --------------------------

  it("static super.method(arg) validates and passes the argument through", async () => {
    const src = `
class Base { static g(v: number): number { return v; } }
class C extends Base { static m(): number { return super.g(42); } }
export function test(): number { return C.m(); }`;
    const v = await validates(src);
    expect(v.ok, v.msg).toBe(true);
    // valid Wasm is not enough — the arg must actually arrive
    expect(await compileAndRunTestNumber(src)).toBe(42);
  });

  it("static super.method(a, b) passes BOTH arguments in order", async () => {
    const src = `
class Base { static g(a: number, b: number): number { return a * 10 + b; } }
class C extends Base { static m(): number { return super.g(3, 4); } }
export function test(): number { return C.m(); }`;
    const v = await validates(src);
    expect(v.ok, v.msg).toBe(true);
    // 34 (not 43) also pins argument ORDER, not just count
    expect(await compileAndRunTestNumber(src)).toBe(34);
  });

  it("static super.method(a, b, c) — 3 args all arrive in order", async () => {
    const src = `
class Base { static g(a: number, b: number, c: number): number { return a * 100 + b * 10 + c; } }
class C extends Base { static m(): number { return super.g(1, 2, 3); } }
export function test(): number { return C.m(); }`;
    expect(await compileAndRunTestNumber(src)).toBe(123);
  });

  it("static super.method(arg) resolves through a 2-level inheritance chain", async () => {
    const src = `
class A { static g(v: number): number { return v + 1; } }
class B extends A {}
class C extends B { static m(): number { return super.g(10); } }
export function test(): number { return C.m(); }`;
    expect(await compileAndRunTestNumber(src)).toBe(11);
  });

  // ---- CONTROLS: these were already VALID and must STAY valid -----------
  // A too-broad offset fix would break these, so they are asserted explicitly
  // rather than assumed.

  it("control — static super.method() with no args still validates", async () => {
    const src = `
class Base { static g(): number { return 7; } }
class C extends Base { static m(): number { return super.g(); } }
export function test(): number { return C.m(); }`;
    const v = await validates(src);
    expect(v.ok, v.msg).toBe(true);
    expect(await compileAndRunTestNumber(src)).toBe(7);
  });

  // NOT FIXED HERE — measured, documented, deliberately left alone.
  // Static super PROPERTY reads are a distinct root cause from call arity: a
  // static member is compiled instance-shaped (`Base_get_x (param (ref null
  // <Base>))`), and a static method has no receiver to pass. Fixing it needs the
  // CLASS modelled as the receiver. Padding the receiver instead would emit
  // `ref.null; ref.as_non_null` (a guaranteed runtime TRAP) — i.e. trading loud
  // invalid Wasm for a trap, so this slice deliberately does not touch it.
  it("KNOWN-OPEN — static super.<plain field> silently reads 0 (pre-existing)", async () => {
    const src = `
class Base { static x: number = 13; }
class C extends Base { static m(): number { return super.x; } }
export function test(): number { return C.m(); }`;
    const v = await validates(src);
    expect(v.ok, v.msg).toBe(true); // valid Wasm...
    // ...but WRONG: emits `f64.const 0`. Identical on stock main — this slice
    // neither causes nor fixes it. Asserted so a future fix flips this loudly.
    expect(await compileAndRunTestNumber(src)).toBe(0);
  });

  it("KNOWN-OPEN — static super.<getter> still emits invalid Wasm", async () => {
    const src = `
class Base { static get x(): number { return 9; } }
class C extends Base { static m(): number { return super.x; } }
export function test(): number { return C.m(); }`;
    const v = await validates(src);
    // Same root cause as the plain-field row above. Left invalid ON PURPOSE
    // rather than padded into a trap; see the comment block above.
    expect(v.ok).toBe(false);
    expect(v.msg).toMatch(/not enough arguments on the stack/);
  });

  it("control — static super.<setter> is unchanged", async () => {
    const src = `
class Base { static set x(v: number) {} }
class C extends Base { static m(): number { super.x = 5; return 1; } }
export function test(): number { return C.m(); }`;
    const v = await validates(src);
    expect(v.ok, v.msg).toBe(true);
    expect(await compileAndRunTestNumber(src)).toBe(1);
  });

  it("control — INSTANCE super.method(arg) is unchanged (receiver still pushed)", async () => {
    const src = `
class Base { g(v: number): number { return v; } }
class C extends Base { m(): number { return super.g(5); } }
export function test(): number { return new C().m(); }`;
    const v = await validates(src);
    expect(v.ok, v.msg).toBe(true);
    expect(await compileAndRunTestNumber(src)).toBe(5);
  });

  it("control — INSTANCE super.<getter> is unchanged", async () => {
    const src = `
class Base { get x(): number { return 11; } }
class C extends Base { m(): number { return super.x; } }
export function test(): number { return new C().m(); }`;
    const v = await validates(src);
    expect(v.ok, v.msg).toBe(true);
    expect(await compileAndRunTestNumber(src)).toBe(11);
  });

  it("control — INSTANCE super.method arg binding unaffected by the pad-loop change", async () => {
    // exercises the pad loop with a receiver present (selfOffset = 1)
    const src = `
class Base { g(a: number, b: number): number { return a * 10 + b; } }
class C extends Base { m(): number { return super.g(6, 7); } }
export function test(): number { return new C().m(); }`;
    expect(await compileAndRunTestNumber(src)).toBe(67);
  });
});
