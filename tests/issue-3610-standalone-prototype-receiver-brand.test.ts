// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3610 — standalone builtins were missing the receiver brand check on a
// `<Builtin>.prototype.<member>` receiver.
//
// TypeScript types `Uint8ClampedArray.prototype` as `Uint8ClampedArray` and
// `Date.prototype` as `Date` (lib.d.ts declares `interface DateConstructor {
// prototype: Date }`), so every native arm that discriminates by receiver TYPE
// NAME treated the PROTOTYPE OBJECT as an INSTANCE and emitted the instance
// lowering — an unconditional `ref.cast` to the backing vec (uncatchable
// `illegal cast` trap) or a `struct.get` on a null `$Date` (uncatchable
// `null reference` trap). `%TypedArray%.prototype.set([])` did not even produce
// a valid module.
//
// The spec requires a CATCHABLE TypeError there (RequireInternalSlot /
// ValidateTypedArray / thisTimeValue). A trap aborts the module and escapes
// `try`/`catch`, so `assert.throws(TypeError, …)` can never observe it.
//
// Every assertion below checks an OBSERVABLE VALUE returned from the compiled
// module: `2` means the module itself caught the throw and `e instanceof
// TypeError` was true inside Wasm. "It compiles" is never asserted.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const io = r.importObject as WebAssembly.Imports & { __setExports?: (e: Record<string, unknown>) => void };
  const { instance } = await WebAssembly.instantiate(r.binary, io);
  io.__setExports?.(instance.exports as Record<string, unknown>);
  return (instance.exports as { test(): unknown }).test();
}

/** 1 = no throw (wrong), 2 = caught a TypeError (spec), 3 = caught something else. */
const guarded = (body: string) =>
  `export function test() { try { ${body} return 1; } catch (e) { return e instanceof TypeError ? 2 : 3; } }`;

const TYPED_ARRAYS = ["Int8Array", "Uint8Array", "Uint8ClampedArray", "Int32Array", "Float64Array"] as const;

describe("#3610 TypedArray prototype accessors throw a catchable TypeError (were: illegal_cast trap)", () => {
  for (const ta of TYPED_ARRAYS) {
    for (const prop of ["buffer", "byteLength", "byteOffset", "length"] as const) {
      it(`${ta}.prototype.${prop}`, async () => {
        expect(await runStandalone(guarded(`${ta}.prototype.${prop};`))).toBe(2);
      });
    }
  }
});

describe("#3610 buffer-family prototype accessors throw a catchable TypeError", () => {
  const cases: Array<[string, string]> = [
    ["ArrayBuffer.prototype.byteLength", "ArrayBuffer.prototype.byteLength;"],
    ["ArrayBuffer.prototype.maxByteLength", "ArrayBuffer.prototype.maxByteLength;"],
    ["ArrayBuffer.prototype.resizable", "ArrayBuffer.prototype.resizable;"],
    ["DataView.prototype.buffer", "DataView.prototype.buffer;"],
    ["DataView.prototype.byteLength", "DataView.prototype.byteLength;"],
    ["DataView.prototype.byteOffset", "DataView.prototype.byteOffset;"],
  ];
  for (const [name, body] of cases) {
    it(name, async () => {
      expect(await runStandalone(guarded(body))).toBe(2);
    });
  }
});

describe("#3610 Date.prototype methods throw a catchable TypeError (were: null_deref trap)", () => {
  const methods = ["getTime", "valueOf", "getFullYear", "toString", "toISOString", "getTimezoneOffset"] as const;
  for (const m of methods) {
    it(`Date.prototype.${m}()`, async () => {
      expect(await runStandalone(guarded(`Date.prototype.${m}();`))).toBe(2);
    });
  }
  it("Date.prototype.setFullYear(2012)", async () => {
    expect(await runStandalone(guarded("Date.prototype.setFullYear(2012);"))).toBe(2);
  });
  it("evaluates arguments before throwing (§13.3.6.1 ArgumentListEvaluation)", async () => {
    // The spec runs ArgumentListEvaluation BEFORE Call(), so the side effect
    // must be observable even though the call itself throws.
    const src = `let seen = 0;
      function arg() { seen = 5; return 2012; }
      export function test() {
        try { Date.prototype.setFullYear(arg()); } catch (e) { return seen; }
        return -1;
      }`;
    expect(await runStandalone(src)).toBe(5);
  });
});

describe("#3610 collection / view prototype methods throw a catchable TypeError", () => {
  const cases: Array<[string, string]> = [
    ["Uint8Array.prototype.fill(0)", "Uint8Array.prototype.fill(0);"],
    ["Uint8Array.prototype.slice()", "Uint8Array.prototype.slice();"],
    ["Uint8Array.prototype.subarray()", "Uint8Array.prototype.subarray();"],
    ["Uint8Array.prototype.join()", "Uint8Array.prototype.join();"],
    // Produced an INVALID module before the gate (array.set type mismatch),
    // which is strictly worse than a trap.
    ["Uint8Array.prototype.set([])", "Uint8Array.prototype.set([]);"],
    ["ArrayBuffer.prototype.slice(0)", "ArrayBuffer.prototype.slice(0);"],
    ["Map.prototype.get(1)", "Map.prototype.get(1);"],
    ["Map.prototype.set(1, 2)", "Map.prototype.set(1, 2);"],
    ["Set.prototype.add(1)", "Set.prototype.add(1);"],
    ["Set.prototype.has(1)", "Set.prototype.has(1);"],
    ["WeakMap.prototype.get({})", "WeakMap.prototype.get({});"],
  ];
  for (const [name, body] of cases) {
    it(name, async () => {
      expect(await runStandalone(guarded(body))).toBe(2);
    });
  }
});

describe("#3610 the gate does not over-throw", () => {
  it("real TypedArray instances keep their accessors", async () => {
    expect(
      await runStandalone(`export function test() { const a = new Uint8Array(4); return a.byteLength + a.length; }`),
    ).toBe(8);
  });
  it("real TypedArray instances keep their methods", async () => {
    expect(
      await runStandalone(
        `export function test() { const a = new Uint8Array([1,2,3]); a.fill(7); return a.slice(1).length + a[0]; }`,
      ),
    ).toBe(9);
  });
  it("real Date instances keep their methods", async () => {
    expect(await runStandalone(`export function test() { const d = new Date(1234); return d.getTime(); }`)).toBe(1234);
  });
  it("real Set instances keep their methods", async () => {
    expect(
      await runStandalone(`export function test() { const s = new Set(); s.add(3); return s.has(3) ? 1 : 0; }`),
    ).toBe(1);
  });
  it("a reflective `.call` on a real instance is NOT gated", async () => {
    // The CALL's receiver here is `Uint8Array.prototype.join`, not
    // `Uint8Array.prototype`, so the static gate must not claim it. Asserted as
    // "does not throw a TypeError" (1), not on the returned string: the
    // standalone reflective-`.call` return path is a separate pre-existing gap
    // (it yields a non-primitive here) and is deliberately not this test's
    // subject — what matters is that the gate stays out of the way.
    expect(
      await runStandalone(guarded(`const a = new Uint8Array([1,2]); (Uint8Array.prototype.join as any).call(a, "-");`)),
    ).toBe(1);
  });
  it("a user class shadowing a builtin name is NOT gated", async () => {
    // The gate keys on the LIB identity of the base identifier
    // (`declare var Date: DateConstructor`); a user `class Date` types its
    // identifier as `typeof Date`, so the gate must skip it.
    expect(
      await runStandalone(
        `class Date { m() { return 7; } }
         export function test() { const d = new Date(); return d.m(); }`,
      ),
    ).toBe(7);
  });
});
