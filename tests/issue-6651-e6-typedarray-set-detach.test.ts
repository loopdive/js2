// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 cluster E, slice E6 — the integer-indexed `[[Set]]` with a Receiver,
 * and three places a DETACHED buffer was answered as if it were merely empty.
 * Standalone, no host.
 *
 *  - §10.4.5.5: `Reflect.set(ta, key, v, receiver)` with a canonical numeric
 *    key never reaches OrdinarySet's prototype hop. An invalid index answers
 *    `true` and touches nothing — not the receiver, not an accessor installed
 *    on `TA.prototype`. With `SameValue(O, Receiver)` the element is written
 *    (ToNumber first), and an out-of-range one still coerces.
 *  - §23.2.3 HOFs visit every `k < len` (no HasProperty): a callback that
 *    detaches the buffer still gets the remaining indices, as `undefined`.
 *  - `fill` / `copyWithin` re-validate after their coercions: a `valueOf` that
 *    detaches the buffer is a TypeError. `join` validates a detached view
 *    BEFORE its separator's ToString.
 *
 * `buf.__detached__ = true` is the standalone detach marker the Test262
 * `$DETACHBUFFER` shim writes. Every case is red on the base.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(body: string): Promise<unknown> {
  const result = await compile(`export function test(): number { ${body} }`, {
    fileName: "issue-6651-e6.ts",
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

// Dynamic views (the `testWithTypedArrayConstructors` carrier), two kinds.
const FIX = `const ctors: any[] = [Float64Array, Int8Array]; var answer = 0;
  for (let i = 0; i < ctors.length; i++) { const C: any = ctors[i];`;

describe("#6651 E6 — TypedArray [[Set]] with a receiver, and detach after coercion", () => {
  it("Reflect.set on an invalid canonical index answers true and creates nothing", async () => {
    expect(
      await run(`${FIX}
      var hit = 0;
      Object.defineProperty(C.prototype, "1", { set: function (v: any) { hit++; }, configurable: true });
      const t: any = new C(1); const r: any = {};
      const a = Reflect.set(t, 1, 7, r) ? 1 : 0;
      const b = Reflect.set(t, "-0", 7, r) ? 1 : 0;
      const c = Reflect.set(t, 1.5, 7, r) ? 1 : 0;
      const own = (r.hasOwnProperty(1) ? 1 : 0) + (r.hasOwnProperty("1.5") ? 1 : 0);
      delete C.prototype[1];
      answer = answer * 1000 + (a + b + c) * 100 + own * 10 + hit;
    } return answer;`),
    ).toBe(300300);
  });

  it("Reflect.set with the view itself as receiver never reaches a prototype setter", async () => {
    expect(
      await run(`${FIX}
      var hit = 0; var calls = 0;
      Object.defineProperty(C.prototype, "5", { set: function (v: any) { hit++; }, configurable: true });
      const t: any = new C(2);
      const v: any = { valueOf() { calls++; return 5; } };
      const oob = Reflect.set(t, 5, v, t) ? 1 : 0;
      const inb = Reflect.set(t, 1, v, t) ? 1 : 0;
      delete C.prototype[5];
      answer = answer * 10000 + (oob + inb) * 1000 + hit * 100 + calls * 10 + t[1];
    } return answer;`),
    ).toBe(20252025);
  });

  it("static Int32Array: out-of-range key with a primitive receiver is true", async () => {
    expect(
      await run(`const ta = new Int32Array(10); var calls = 0;
      const v: any = { valueOf() { calls++; return 1; } };
      const a = Reflect.set(ta, 100, v, "not an object") ? 1 : 0;
      const b = Reflect.set(ta, 100, v, ta) ? 1 : 0;
      return a * 100 + b * 10 + calls;`),
    ).toBe(111);
  });

  it("a HOF callback that detaches the buffer still visits every index", async () => {
    expect(
      await run(`const holes: any[] = [1, , 3]; ${FIX}
      var loops = 0; var undef = 0;
      const s: any = new C(2);
      s.forEach(function (v: any) { if (loops === 0) (s.buffer as any).__detached__ = true; if (v === undefined) undef++; loops++; });
      answer = answer * 100 + loops * 10 + undef;
    } return answer + holes.length * 0;`),
    ).toBe(2121);
  });

  it("fill throws when coercing its value detaches the buffer", async () => {
    expect(
      await run(`${FIX}
      const s: any = new C(4); var kind = 0;
      try { s.fill({ valueOf() { (s.buffer as any).__detached__ = true; return 7; } }); kind = 1; }
      catch (e) { kind = e instanceof TypeError ? 2 : 3; }
      answer = answer * 10 + kind;
    } return answer;`),
    ).toBe(22);
  });

  it("join validates a detached view before coercing its separator", async () => {
    expect(
      await run(`${FIX}
      const s: any = new C(1); var kind = 0;
      (s.buffer as any).__detached__ = true;
      const sep: any = { toString() { throw new RangeError("sep"); } };
      try { s.join(sep); kind = 1; } catch (e) { kind = e instanceof TypeError ? 2 : e instanceof RangeError ? 3 : 4; }
      answer = answer * 10 + kind;
    } return answer;`),
    ).toBe(22);
  });

  it("copyWithin throws when coercing start detaches the buffer", async () => {
    expect(
      await run(`${FIX}
      const s: any = new C(8); var kind = 0;
      try { s.copyWithin(0, { valueOf() { (s.buffer as any).__detached__ = true; return 2; } }, 6); kind = 1; }
      catch (e) { kind = e instanceof TypeError ? 2 : 3; }
      answer = answer * 10 + kind;
    } return answer;`),
    ).toBe(22);
  });
});
