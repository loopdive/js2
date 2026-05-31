// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1716 — ToPrimitive residual: "Cannot convert object to primitive value" in
// the property-key and built-in-arg coercion paths.
//
// #1319 / #1090 / #1525 wired ToPrimitive into the *direct* coercion sites
// (`String(obj)`, template spans, arithmetic ref→f64) through `_hostToPrimitive`
// in src/runtime.ts, the callbackState-aware OrdinaryToPrimitive walker. But two
// families of call sites were never routed through it, so they still threw:
//
//   1. ToPropertyKey (§7.1.19): an object used as a property key — `obj[key]`,
//      `Object.getOwnPropertyDescriptor/defineProperty(obj, key)`, `Reflect.*`.
//      `_safeGet`/`_safeSet`/the Object.* + Reflect.* runtime handlers coerced
//      the key via `_toPrimitiveSync` *without* callbackState (or a bare
//      `String(prop)`), so a key whose valueOf/toString/@@toPrimitive is a
//      compiled WasmGC closure collapsed to "[object Object]" and the lookup
//      silently missed (or native defineProperty threw on the opaque struct).
//
//   2. ToString/ToPrimitive of an object argument to a host constructor that
//      coerces its arg — `new RegExp(obj)`, `new Date(obj)`, `new String(obj)`,
//      `new Number(obj)`. V8's `new Ctor(struct)` runs its own ToPrimitive on
//      the opaque struct and threw, never reaching the compiled methods.
//
// Two-part fix, REUSING #1319's machinery rather than duplicating it:
//   - runtime.ts: `_toPrimitiveSync` now accepts callbackState and defers to
//     `_hostToPrimitive` for structs; a new `_toPropertyKey` helper applies
//     §7.1.19 at the property-key handlers; the extern_class constructor coerces
//     struct args for RegExp/Date/String/Number.
//   - codegen/index.ts: emits `__call_@@toPrimitive(self, hint)` so the runtime
//     can dispatch a class's `[Symbol.toPrimitive]` *method* (valueOf/toString
//     already had `__call_<name>` dispatchers; the exotic method did not).
//
// A §7.1.1.1 step-6 violation (a coercion method returning an object) still
// throws TypeError — that is the spec-correct outcome on these paths too, so the
// regression guard asserts it.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<Record<string, Function>> {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed:\n${r.errors.map((e) => `  L${e.line}:${e.column} ${e.message}`).join("\n")}`);
  }
  new WebAssembly.Module(r.binary);
  const imports: any = buildImports(r.imports, undefined, r.stringPool);
  const inst = await WebAssembly.instantiate(r.binary, imports);
  if (typeof imports.setExports === "function") imports.setExports(inst.instance.exports);
  return inst.instance.exports as Record<string, Function>;
}

describe("#1716 — ToPropertyKey coercion (object used as property key)", () => {
  it("obj[key] where key has valueOf/toString invokes the method", async () => {
    const exports = await run(`
      class Key {
        valueOf(): string { return "k" as any; }
        toString(): string { return "k"; }
      }
      export function test(): string {
        const o: any = {};
        o["k"] = "hit";
        return o[new Key() as any];
      }
    `);
    expect(exports.test!()).toBe("hit");
  });

  it("obj[key] where key defines [Symbol.toPrimitive] as a method", async () => {
    const exports = await run(`
      class Key {
        [Symbol.toPrimitive](hint: string): string { return "k"; }
      }
      export function test(): string {
        const o: any = {};
        o["k"] = "hit2";
        return o[new Key() as any];
      }
    `);
    expect(exports.test!()).toBe("hit2");
  });

  it("Object.getOwnPropertyDescriptor with an object key", async () => {
    const exports = await run(`
      class K { toString(): string { return "k"; } }
      export function test(): number {
        const o: any = { k: 42 };
        const d: any = Object.getOwnPropertyDescriptor(o, new K() as any);
        return d.value as number;
      }
    `);
    expect(exports.test!()).toBe(42);
  });

  it("Object.defineProperty with an object key", async () => {
    const exports = await run(`
      class K { toString(): string { return "dyn"; } }
      export function test(): number {
        const o: any = {};
        Object.defineProperty(o, new K() as any, { value: 99, enumerable: true });
        return o.dyn as number;
      }
    `);
    expect(exports.test!()).toBe(99);
  });

  it("step-6 violation: object key whose @@toPrimitive returns an object throws TypeError", async () => {
    const exports = await run(`
      class Bad { [Symbol.toPrimitive](hint: string): any { return {}; } }
      export function test(): string {
        const o: any = {};
        return o[new Bad() as any];
      }
    `);
    expect(() => exports.test!()).toThrow();
  });
});

describe("#1716 — host-constructor object-argument coercion", () => {
  it("String(obj) consults @@toPrimitive with the string hint", async () => {
    const exports = await run(`
      class B { [Symbol.toPrimitive](h: string): string { return h === "string" ? "S" : "N"; } }
      export function test(): string { return String(new B() as any); }
    `);
    expect(exports.test!()).toBe("S");
  });

  it("new RegExp(obj) coerces the source via toString", async () => {
    const exports = await run(`
      class P { toString(): string { return "ab+"; } }
      export function test(): string {
        const r = new RegExp(new P() as any);
        return r.source;
      }
    `);
    expect(exports.test!()).toBe("ab+");
  });

  it("new Date(obj) coerces a numeric valueOf to a timestamp", async () => {
    const exports = await run(`
      class T { valueOf(): number { return 0; } }
      export function test(): number {
        const d = new Date(new T() as any);
        return d.getTime();
      }
    `);
    expect(exports.test!()).toBe(0);
  });
});

describe("#1716 — regression guard: defined methods still win, no spurious coercion", () => {
  it("class WITH valueOf is still invoked correctly (guards #1319 path)", async () => {
    const exports = await run(`
      class Boxed {
        v: number;
        constructor(v: number) { this.v = v; }
        valueOf(): number { return this.v; }
      }
      export function test(): number {
        return ((new Boxed(42) as any) - 0) + 1;
      }
    `);
    expect(exports.test!()).toBe(43);
  });

  it("no-method object key falls back to a string key (does not throw)", async () => {
    const exports = await run(`
      class Bare { x: number = 1; }
      export function test(): number {
        const o: any = {};
        o[new Bare() as any] = 7;
        // The key stringifies to a stable "[object Object]"-shaped key; reading
        // it back with the same kind of key must round-trip without throwing.
        return o[new Bare() as any] as number;
      }
    `);
    expect(() => exports.test!()).not.toThrow();
  });
});
