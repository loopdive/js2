// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 cluster F — three `--target standalone` Proxy/Reflect answers that were
// each a DISCARDED value rather than a missing mechanism. Every `it` below was
// run against this branch's base (`claude/es2015-test262-plan-54tooh`
// @ `a68e20f7`) first and answered exactly as the RED/GUARD label says.
//
//  1. `Reflect.setPrototypeOf` always answered `true`. The file's own "KNOWN
//     LIMITATION" comment said the writer had no failure channel — stale:
//     #5148 cluster 2b built one (`__object_setPrototypeOf_status`, a pure
//     §10.1.2.1 predicate that performs no write). The answer is now the
//     conjunction of that ordinary bit and `__is_truthy` of the writer's
//     result, which for a `$Proxy` receiver IS the §10.5.2 trap's boolean.
//
//  2. `Reflect.preventExtensions` likewise did `drop; i32.const 1` over a
//     result whose `$Proxy` front guard had already computed the §10.5.4
//     trap's `false`.
//
//  3. `Reflect.ownKeys` dropped SYMBOL keys. The arm's comment claimed the
//     runtime "does not retain symbol-keyed properties yet"; it does, and
//     `Object.getOwnPropertySymbols` already read them back with correct
//     identity on base. The two lists were simply never joined (§10.1.11.1
//     step 4). A `$Proxy` receiver is excluded — its `ownKeys` TRAP result must
//     be returned as-is.
//
//  4. `Object.getPrototypeOf(o)` folded to `%Object.prototype%` from the
//     binding's object-literal DECLARATION even when the module writes that
//     binding's prototype — while `o.inheritedKey`, the same link read through
//     the runtime walk, already resolved through the new prototype. One object,
//     two answers.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(body: string): Promise<number> {
  const src = `export function test(): number {\n${body}\n}\n`;
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(r.imports ?? [], "standalone module must import nothing").toEqual([]);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#6651 cluster F — Reflect boolean answers that were discarded", () => {
  it("RED on base: Reflect.setPrototypeOf reports every §10.1.2.1 refusal", async () => {
    expect(
      await runStandalone(`
      let out = 0;
      const same: any = {};
      if (Reflect.setPrototypeOf(same, same) === false) out += 1;
      const sealed: any = {};
      Object.preventExtensions(sealed);
      if (Reflect.setPrototypeOf(sealed, {} as any) === false) out += 2;
      const child: any = {};
      const descendant: any = Object.create(child);
      if (Reflect.setPrototypeOf(child, descendant) === false) out += 4;
      return out;`),
    ).toBe(7);
  });

  it("GUARD: a legal Reflect.setPrototypeOf still answers true", async () => {
    expect(
      await runStandalone(`
      let out = 0;
      const a: any = {};
      if (Reflect.setPrototypeOf(a, null as any) === true) out += 1;
      const b: any = {};
      if (Reflect.setPrototypeOf(b, { tag: 1 } as any) === true) out += 2;
      const c: any = Object.create(null);
      if (Reflect.setPrototypeOf(c, Object.prototype) === true) out += 4;
      return out;`),
    ).toBe(7);
  });

  it("RED on base: a false setPrototypeOf trap is reported as false", async () => {
    expect(
      await runStandalone(`
      const p: any = new Proxy({} as any, { setPrototypeOf(_t: any, _v: any) { return false; } });
      return Reflect.setPrototypeOf(p, {} as any) === false ? 1 : 0;`),
    ).toBe(1);
  });

  it("RED on base: a false preventExtensions trap is reported as false", async () => {
    expect(
      await runStandalone(`
      const p: any = new Proxy({} as any, { preventExtensions(_t: any) { return false; } });
      return Reflect.preventExtensions(p) === false ? 1 : 0;`),
    ).toBe(1);
  });

  it("GUARD: preventExtensions on an ordinary object still answers true", async () => {
    expect(
      await runStandalone(`
      const o: any = { a: 1 };
      return Reflect.preventExtensions(o) === true ? 1 : 0;`),
    ).toBe(1);
  });
});

describe("#6651 cluster F — Reflect.ownKeys and the symbol group", () => {
  it("RED on base: symbol keys follow the string keys", async () => {
    expect(
      await runStandalone(`
      let out = 0;
      const o: any = {};
      o.p1 = 42;
      const s1: any = Symbol("1");
      o[s1] = 44;
      const keys: any = Reflect.ownKeys(o);
      if (keys.length === 2) out += 1;
      if (keys[0] === "p1") out += 2;
      if (keys[1] === s1) out += 4;
      return out;`),
    ).toBe(7);
  });

  it("GUARD: a proxy ownKeys trap result is returned as-is, with nothing appended", async () => {
    // The trap answers a two-element list while the TARGET carries a symbol
    // key. Appending the target's symbols here would both mutate a user array
    // and report a key the trap did not.
    expect(
      await runStandalone(`
      const target: any = {};
      const sym: any = Symbol("hidden");
      target[sym] = 1;
      target.a = 2;
      const p: any = new Proxy(target, { ownKeys(_t: any) { return ["a", "b"]; } });
      const keys: any = Reflect.ownKeys(p);
      return keys.length === 2 && keys[0] === "a" && keys[1] === "b" ? 1 : 0;`),
    ).toBe(1);
  });
});

describe("#6651 cluster F — Object.getPrototypeOf must read a written prototype", () => {
  it("RED on base: the fold no longer outranks a [[Prototype]] write", async () => {
    expect(
      await runStandalone(`
      let out = 0;
      const proto: any = { tag: 7 };
      const o: any = {};
      Reflect.setPrototypeOf(o, proto);
      // The runtime walk already agreed with the write on base …
      if (o.tag === 7) out += 1;
      // … the reader did not.
      if (Object.getPrototypeOf(o) === proto) out += 2;
      const o2: any = {};
      Object.setPrototypeOf(o2, proto);
      if (Object.getPrototypeOf(o2) === proto) out += 4;
      return out;`),
    ).toBe(7);
  });

  it("GUARD: an untouched literal binding keeps the %Object.prototype% fold", async () => {
    expect(
      await runStandalone(`
      let out = 0;
      const plain: any = { a: 1 };
      if (Object.getPrototypeOf(plain) === Object.prototype) out += 1;
      // A binding whose prototype write is REFUSED keeps it too: the field is
      // never written, and the native reads the implicit terminal back as
      // %Object.prototype%.
      const refused: any = {};
      Reflect.setPrototypeOf(refused, refused);
      if (Object.getPrototypeOf(refused) === Object.prototype) out += 2;
      return out;`),
    ).toBe(3);
  });
});
