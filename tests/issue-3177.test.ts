// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #3177 slice 1 — standalone TypedArray integer-indexed MOP arms + ctor identity.
//
// Three mechanisms:
//  1. `$__ta_ctor` per-kind SINGLETON globals — every mention of the same ctor
//     name is the SAME struct ref (was: struct.new per site → ref.eq identity
//     broken at the root), plus the `<TA>.prototype.constructor` static arm.
//  2. `$__ta_dyn_view` §10.4.5 MOP arms (src/codegen/ta-dyn-mop.ts) prepended
//     at finalize into the standalone dynamic-object natives: canonical-
//     numeric-key interception (§7.1.21 round-trip + "-0"), IsValidIntegerIndex
//     element semantics for get/set/has/delete, named intrinsic props
//     (length/byteLength/byteOffset/BYTES_PER_ELEMENT/buffer/constructor),
//     and OwnPropertyKeys index enumeration.
//  3. Inline dyn-view OOB element read returns the `undefined` SINGLETON (was
//     ref.null.extern → compared as null).
//
// The dynamic-ctor shape (`const TA: any = Uint8Array; new TA(...)`) is the
// shape every `testWithTypedArrayConstructors` harness closure produces — the
// arms target exactly that corpus (built-ins/TypedArrayConstructors/internals).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(body: string): Promise<unknown> {
  const src = `export function test(): number {
  const TA: any = Uint8Array;
  const s: any = new TA([42, 43]);
  ${body}
}`;
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

describe("#3177 — ctor identity (singleton $__ta_ctor)", () => {
  it("two mentions of the same ctor are ref-equal: Uint8Array === Uint8Array", async () => {
    expect(await run(`const a: any = Uint8Array; const b: any = Uint8Array; return a === b ? 1 : 0;`)).toBe(1);
  });

  it("distinct ctors stay distinct: Uint8Array !== Int8Array", async () => {
    expect(await run(`const a: any = Uint8Array; const b: any = Int8Array; return a !== b ? 1 : 0;`)).toBe(1);
  });

  it("static arm: Uint16Array.prototype.constructor === Uint16Array", async () => {
    expect(await run(`return Uint16Array.prototype.constructor === Uint16Array ? 1 : 0;`)).toBe(1);
  });

  it("cross-check stays false: Uint16Array.prototype.constructor !== Uint8Array", async () => {
    expect(await run(`return (Uint16Array.prototype.constructor as any) === (Uint8Array as any) ? 0 : 1;`)).toBe(1);
  });

  it("runtime arm: instance.constructor === TA through the dyn-view [[Get]]", async () => {
    expect(await run(`return s.constructor === TA ? 1 : 0;`)).toBe(1);
  });
});

describe("#3177 — dyn-view integer-indexed MOP arms (§10.4.5)", () => {
  it("[[Get]] canonical string key reads the element: Reflect.get(s, '0') === 42", async () => {
    expect(await run(`const v: any = Reflect.get(s, "0"); return v === 42 ? 1 : 0;`)).toBe(1);
  });

  it("[[Get]] canonical-but-not-integer key is undefined, never ordinary lookup: s['1.1']", async () => {
    expect(await run(`const v: any = s["1.1"]; return v === undefined ? 1 : 0;`)).toBe(1);
  });

  it("[[HasProperty]]: '0' → true, '5' (OOB) → false, '-0' → false, 'foo' → false, 'length' → true", async () => {
    expect(
      await run(
        `return (Reflect.has(s, "0") && !Reflect.has(s, "5") && !Reflect.has(s, "-0") && !Reflect.has(s, "foo") && Reflect.has(s, "length")) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("[[Set]] canonical key writes through; Reflect.set reports true", async () => {
    expect(await run(`const ok = Reflect.set(s, "0", 9); const v: any = s[0]; return (ok && v === 9) ? 1 : 0;`)).toBe(
      1,
    );
  });

  it("[[Set]] OOB is a silent no-op and the read stays undefined", async () => {
    expect(await run(`s[5] = 7; const v: any = s[5]; return v === undefined ? 1 : 0;`)).toBe(1);
  });

  it("[[Delete]]: valid index → false; OOB index → true", async () => {
    expect(
      await run(`const a: any = delete s[0]; const b: any = delete s[9]; return (a === false && b === true) ? 1 : 0;`),
    ).toBe(1);
  });

  it("OwnPropertyKeys: Object.keys(s) enumerates ascending index strings", async () => {
    expect(
      await run(`const k = Object.keys(s); return (k.length === 2 && k[0] === "0" && k[1] === "1") ? 1 : 0;`),
    ).toBe(1);
  });

  it("named props through the dynamic reader: length/byteLength/byteOffset/BYTES_PER_ELEMENT", async () => {
    expect(
      await run(
        `const a: any = Reflect.get(s, "length"); const b: any = Reflect.get(s, "byteLength"); const c: any = Reflect.get(s, "byteOffset"); const d: any = Reflect.get(s, "BYTES_PER_ELEMENT"); return (a === 2 && b === 2 && c === 0 && d === 1) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it(".buffer returns the SAME backing buffer (identity) for a buffer-backed view", async () => {
    expect(
      await run(
        `const buf: any = new ArrayBuffer(4); const t: any = new TA(buf); const b: any = t.buffer; return b === buf ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("detach ($DETACHBUFFER model: __detached__=true) → element reads undefined, has false", async () => {
    expect(
      await run(
        `const b: any = s.buffer; (b as any).__detached__ = true; const v: any = s[0]; return (v === undefined && !Reflect.has(s, "0")) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("inline OOB element read is the undefined SINGLETON, not null", async () => {
    expect(await run(`const v: any = s[7]; return (v === undefined && !(v === null)) ? 1 : 0;`)).toBe(1);
  });
});

describe("#3177 slice 2 — §23.2.5.1 ctor-arg protocol throws (buffer/length args)", () => {
  // The statically-ArrayBuffer-typed arg0 path (emitDynamicTaViewConstruct).
  it("negative offset → RangeError instance", async () => {
    expect(
      await run(
        `const buffer = new ArrayBuffer(8); try { new TA(buffer, -1); return 0; } catch (e) { return (e as any) instanceof RangeError ? 1 : 2; }`,
      ),
    ).toBe(1);
  });

  it("misaligned offset (step 3) → RangeError", async () => {
    expect(
      await run(
        `const T2: any = Uint16Array; const buffer = new ArrayBuffer(8); try { new T2(buffer, 1); return 0; } catch (e) { return (e as any) instanceof RangeError ? 1 : 2; }`,
      ),
    ).toBe(1);
  });

  it("auto-length buffer modulo (step 13.a) → RangeError", async () => {
    expect(
      await run(
        `const T2: any = Uint16Array; const buffer = new ArrayBuffer(1); try { new T2(buffer); return 0; } catch (e) { return (e as any) instanceof RangeError ? 1 : 2; }`,
      ),
    ).toBe(1);
  });

  it("explicit `undefined` length counts as absent (still the step-13 arm)", async () => {
    expect(
      await run(
        `const T2: any = Uint16Array; const buffer = new ArrayBuffer(1); try { new T2(buffer, 0, undefined); return 0; } catch (e) { return (e as any) instanceof RangeError ? 1 : 2; }`,
      ),
    ).toBe(1);
  });

  it("offset beyond buffer end (step 13.c) → RangeError", async () => {
    expect(
      await run(
        `const buffer = new ArrayBuffer(1); try { new TA(buffer, 2); return 0; } catch (e) { return (e as any) instanceof RangeError ? 1 : 2; }`,
      ),
    ).toBe(1);
  });

  it("offset + length×es > bufferByteLength (step 14.c) → RangeError", async () => {
    expect(
      await run(
        `const buffer = new ArrayBuffer(1); try { new TA(buffer, 0, 2); return 0; } catch (e) { return (e as any) instanceof RangeError ? 1 : 2; }`,
      ),
    ).toBe(1);
  });

  it("detached buffer at construction (step 6) → TypeError", async () => {
    expect(
      await run(
        `const buffer = new ArrayBuffer(8); (buffer as any).__detached__ = true; try { new TA(buffer); return 0; } catch (e) { return (e as any) instanceof TypeError ? 1 : 2; }`,
      ),
    ).toBe(1);
  });

  it("detach DURING length valueOf is observed (fresh byte-length re-read) → TypeError", async () => {
    expect(
      await run(
        `const buffer = new ArrayBuffer(8); const len = { valueOf: function(): number { (buffer as any).__detached__ = true; return 4; } }; try { new TA(buffer, 0, len as any); return 0; } catch (e) { return (e as any) instanceof TypeError ? 1 : 2; }`,
      ),
    ).toBe(1);
  });

  it("statically-symbol offset → TypeError (§7.1.4 ToNumber(Symbol))", async () => {
    expect(
      await run(
        // NOTE: no `as any` on `sym` — the oracle's static-symbol detection reads
        // the identifier's own (unique symbol) type, which is exactly the corpus
        // shape (`var byteOffset = Symbol("1"); new TA(buffer, byteOffset)`). An
        // `as any` cast erases the brand and falls to the (pre-existing)
        // generic-coercion throw path instead.
        `const buffer = new ArrayBuffer(8); const sym = Symbol("1"); try { new TA(buffer, sym); return 0; } catch (e) { return (e as any) instanceof TypeError ? 1 : 2; }`,
      ),
    ).toBe(1);
  });

  it("runtime symbol count arg (pre-boxed argv path) → TypeError", async () => {
    expect(
      await run(
        `const sym: any = Symbol("1"); try { new TA(sym); return 0; } catch (e) { return (e as any) instanceof TypeError ? 1 : 2; }`,
      ),
    ).toBe(1);
  });

  it("-0 offset constructs (ToIndex(-0) = 0)", async () => {
    expect(
      await run(`const buffer = new ArrayBuffer(8); const t: any = new TA(buffer, -0); return t.length === 8 ? 1 : 0;`),
    ).toBe(1);
  });

  it("valid windowed construct is unchanged", async () => {
    expect(
      await run(
        `const T2: any = Uint16Array; const buffer = new ArrayBuffer(8); const t: any = new T2(buffer, 2, 2); return (t.length === 2 && t.byteOffset === 2) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("valid auto-length construct is unchanged", async () => {
    expect(
      await run(
        `const T2: any = Uint16Array; const buffer = new ArrayBuffer(8); const t: any = new T2(buffer, 4); return t.length === 2 ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("count form negative → RangeError INSTANCE (upgraded from bare-string throw)", async () => {
    expect(
      await run(`try { new TA(-1); return 0; } catch (e) { return (e as any) instanceof RangeError ? 1 : 2; }`),
    ).toBe(1);
  });

  it("guard: copy-from-int8-view pun shape does NOT throw (skipAutoModulo containment)", async () => {
    // A static Int8Array value is a bare byte vec — indistinguishable from an
    // ArrayBuffer in the pre-evaluated-argv arm. The step-13.a modulo check is
    // suppressed there so this (already-wrong-length) shape stays non-throwing.
    expect(
      await run(
        `const F8: any = Float64Array; const src = new Int8Array(10); try { const t: any = new F8(src as any); return 1; } catch (e) { return 0; }`,
      ),
    ).toBe(1);
  });
});

describe("#3177 slice 3 — proto identity, without-new TypeError, isExtensible", () => {
  it("Object.getPrototypeOf(dynview) === TA.prototype (static read) — THE identity", async () => {
    expect(
      await run(
        `const p: any = Object.getPrototypeOf(s); const sp: any = Uint8Array.prototype; return p === sp ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("Object.getPrototypeOf(dynview) === Reflect.get(TA, 'prototype') (runtime read)", async () => {
    expect(
      await run(
        `const p: any = Object.getPrototypeOf(s); const q: any = Reflect.get(TA, "prototype"); return p === q ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("cross-kind protos stay distinct: getProto(new Uint16Array) !== Uint8Array.prototype", async () => {
    expect(
      await run(
        `const T16: any = Uint16Array; const t: any = new T16(4); const sp: any = Uint8Array.prototype; return Object.getPrototypeOf(t) === sp ? 0 : 1;`,
      ),
    ).toBe(1);
  });

  it("TA(1) without new → TypeError instance (§23.2.5.1 step 1)", async () => {
    expect(await run(`try { TA(1); return 0; } catch (e) { return (e as any) instanceof TypeError ? 1 : 2; }`)).toBe(1);
  });

  it("without-new throw fires inside a closure (the assert.throws harness shape)", async () => {
    expect(
      await run(
        `const f = function(): number { try { TA(1); return 0; } catch (e) { return (e as any) instanceof TypeError ? 1 : 2; } }; return f();`,
      ),
    ).toBe(1);
  });

  it("Object.isExtensible(dynview) → true", async () => {
    expect(await run(`return Object.isExtensible(s) ? 1 : 0;`)).toBe(1);
  });

  it("TA.BYTES_PER_ELEMENT via runtime [[Get]] (construct present in module)", async () => {
    expect(
      await run(
        `const T16: any = Uint16Array; const b: any = Reflect.get(T16, "BYTES_PER_ELEMENT"); return b === 2 ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("guard: getPrototypeOf on a plain object keeps the $proto walk", async () => {
    expect(
      await run(
        `const base: any = { x: 1 }; const o: any = Object.create(base); return Object.getPrototypeOf(o) === base ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("guard: isExtensible on a plain object stays true / false after preventExtensions", async () => {
    expect(
      await run(
        `const o: any = {}; const a = Object.isExtensible(o); Object.preventExtensions(o); const b = Object.isExtensible(o); return (a && !b) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("guard: unknown key on a TA-ctor receiver falls through to undefined", async () => {
    expect(await run(`const v: any = Reflect.get(TA, "someUnknownKey"); return v === undefined ? 1 : 0;`)).toBe(1);
  });

  it("guard: a non-ctor dynamic callee still dispatches (closures unaffected)", async () => {
    expect(await run(`const f: any = (x: number): number => x + 1; const r: any = f(2); return r === 3 ? 1 : 0;`)).toBe(
      1,
    );
  });
});

describe("#3177 slice 4 — descriptor MOP arms (§10.4.5.1/.3) + expando side-table", () => {
  it("Reflect.defineProperty on a valid index writes the element and returns true", async () => {
    expect(
      await run(
        `const r: any = Reflect.defineProperty(s, "0", { value: 9, writable: true, enumerable: true, configurable: true }); const v: any = s[0]; return (r === true && v === 9) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("Reflect.defineProperty index with writable:false → false (§10.4.5.3 v)", async () => {
    expect(
      await run(
        `const r: any = Reflect.defineProperty(s, "0", { value: 9, writable: false }); return r === false ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("Object.defineProperty index with writable:false → TypeError (§20.1.2.4 step 3)", async () => {
    expect(
      await run(
        `try { Object.defineProperty(s, "0", { value: 9, writable: false }); return 0; } catch (e) { return (e as any) instanceof TypeError ? 1 : 2; }`,
      ),
    ).toBe(1);
  });

  it("Reflect.defineProperty OOB index → false (IsValidIntegerIndex)", async () => {
    expect(await run(`const r: any = Reflect.defineProperty(s, "5", { value: 9 }); return r === false ? 1 : 0;`)).toBe(
      1,
    );
  });

  it("defineProperty a NON-index key lands on the expando and reads back via [[Get]]", async () => {
    expect(
      await run(
        `Object.defineProperty(s, "foo", { value: 42 }); const v: any = (s as any).foo; return v === 42 ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("symbol-keyed [[Set]]/[[Get]] round-trips through the expando", async () => {
    expect(
      await run(
        `const sym: any = Symbol("k"); s[sym] = "test262"; const v: any = s[sym]; return v === "test262" ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("[[Delete]] of an expando prop → true and the prop is gone", async () => {
    expect(
      await run(
        `s.bar = 7; const d: any = delete s.bar; const v: any = s.bar; return (d === true && v === undefined) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("[[HasProperty]] sees expando props", async () => {
    expect(await run(`s.baz = 1; return Reflect.has(s, "baz") ? 1 : 0;`)).toBe(1);
  });

  it("gOPD on a valid index → {value, writable:true, enumerable:true, configurable:true}", async () => {
    expect(
      await run(
        `const d: any = Object.getOwnPropertyDescriptor(s, "0"); return (d.value === 42 && d.writable === true && d.enumerable === true && d.configurable === true) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("gOPD on an OOB / '-0' key → undefined", async () => {
    expect(
      await run(
        `const a: any = Object.getOwnPropertyDescriptor(s, "5"); const b: any = Object.getOwnPropertyDescriptor(s, "-0"); return (a === undefined && b === undefined) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("gOPD reads back an expando prop's descriptor", async () => {
    expect(
      await run(
        `Object.defineProperty(s, "foo", { value: 42 }); const d: any = Object.getOwnPropertyDescriptor(s, "foo"); return d.value === 42 ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("accessor descriptor on a canonical index → TypeError via Object.defineProperty (§10.4.5.3 ii)", async () => {
    expect(
      await run(
        `try { Object.defineProperty(s, "0", { get: function(): number { return 1; } }); return 0; } catch (e) { return (e as any) instanceof TypeError ? 1 : 2; }`,
      ),
    ).toBe(1);
  });

  it("preventExtensions(view) → isExtensible false; new expando define rejected", async () => {
    expect(
      await run(
        `Object.preventExtensions(s); const x = Object.isExtensible(s); const r: any = Reflect.defineProperty(s, "nope", { value: 1 }); return (!x && r === false) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("detached buffer: index define → TypeError (IsValidIntegerIndex step 2)", async () => {
    expect(
      await run(
        `const b: any = s.buffer; (b as any).__detached__ = true; try { Object.defineProperty(s, "0", { value: 8 }); return 0; } catch (e) { return (e as any) instanceof TypeError ? 1 : 2; }`,
      ),
    ).toBe(1);
  });

  it("guard: plain-object defineProperty/gOPD unchanged", async () => {
    expect(
      await run(
        `const o: any = {}; Object.defineProperty(o, "x", { value: 5, writable: true, enumerable: true, configurable: true }); const d: any = Object.getOwnPropertyDescriptor(o, "x"); return (o.x === 5 && d.value === 5) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("guard: Reflect.defineProperty on a plain object still returns true", async () => {
    expect(
      await run(
        `const o: any = {}; const r: any = Reflect.defineProperty(o, "x", { value: 1 }); return r === true ? 1 : 0;`,
      ),
    ).toBe(1);
  });
});

describe("#3177 — non-view receivers keep their behavior (arms fall through)", () => {
  it("plain any-typed array element/length are unchanged", async () => {
    // NOTE: `Object.keys(<any-typed plain array>)` returns [] on main (the
    // #3183 vec-awareness landed only in `__object_keys_forin`, not
    // `__object_keys`) — pre-existing, out of scope here; this guard asserts
    // the dyn-view arm did not CHANGE non-view behavior, so it checks only
    // what worked before.
    const src = `export function test(): number {
  const a: any = [10, 20, 30];
  const v: any = a[1];
  const l: any = a.length;
  return (v === 20 && l === 3) ? 1 : 0;
}`;
    const r = await compile(src, { target: "standalone" });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { test(): number }).test()).toBe(1);
  });

  it("plain object get/has/delete are unchanged", async () => {
    const src = `export function test(): number {
  const o: any = { x: 1 };
  const h = Reflect.has(o, "x");
  const g: any = Reflect.get(o, "x");
  const d: any = delete o.x;
  return (h && g === 1 && d === true && !Reflect.has(o, "x")) ? 1 : 0;
}`;
    const r = await compile(src, { target: "standalone" });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { test(): number }).test()).toBe(1);
  });

  it("byte-inert: a module with no TA construct compiles identically-valid and works", async () => {
    const src = `export function test(): number { const o: any = { a: 1, b: 2 }; return Object.keys(o).length === 2 ? 1 : 0; }`;
    const r = await compile(src, { target: "standalone" });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { test(): number }).test()).toBe(1);
  });
});
