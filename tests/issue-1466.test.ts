// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #1466 — Proxy + Reflect trap / operation fidelity
//
// Replaces 13 Reflect.X compile-time rewrites with host-import dispatches so
// the host's Reflect.* drives the spec semantics:
//   * boolean returns (`Reflect.set` on frozen → false)
//   * MOP traps fire when target is a real Proxy
//   * Symbol keys are surfaced by `Reflect.ownKeys`
//   * `newTarget` propagates in `Reflect.construct`
//
// The wasm-side `new Proxy(target, handler)` with a wasm-struct handler is
// pre-existing pass-through (see tests/proxy-passthrough.test.ts) — out of
// scope for #1466.  We test trap-firing using a JS-side proxy supplied via
// `deps`, since the host Reflect path is what #1466 wires up.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(code: string, deps?: Record<string, unknown>): Promise<unknown> {
  const r = await compile(code, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, deps as Record<string, any> | undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
  return (instance.exports as any).test();
}

describe("#1466 — Reflect operations preserve spec-mandated booleans", () => {
  it("Reflect.set on a non-writable property returns false (no silent success)", async () => {
    const result = await run(`
      export function test(): number {
        // Use Reflect.defineProperty (proven trap-bypass route) to make 'a' non-writable.
        const o: any = {};
        Reflect.defineProperty(o, "a", {value: 1, writable: false, configurable: false});
        const ok: any = Reflect.set(o, "a", 2);
        // Host returns the spec boolean; without the fix the rewrite returned true.
        return ok === false ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("Reflect.deleteProperty on a non-configurable own property returns false", async () => {
    const result = await run(`
      export function test(): number {
        const o: any = {};
        Reflect.defineProperty(o, "a", {value: 1, configurable: false, writable: true});
        const ok: any = Reflect.deleteProperty(o, "a");
        return ok === false ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("Reflect.defineProperty failure returns false (re-defining non-configurable)", async () => {
    const result = await run(`
      export function test(): number {
        const o: any = {};
        const first: any = Reflect.defineProperty(o, "p", {value: 1, configurable: false, writable: false});
        // Re-defining a non-configurable, non-writable property with a different value must fail.
        const second: any = Reflect.defineProperty(o, "p", {value: 2});
        return (first === true && second === false) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });
});

describe("#1466 — Reflect.ownKeys includes Symbol-keyed properties", () => {
  it("Reflect.ownKeys returns both string and Symbol own properties", async () => {
    const result = await run(`
      export function test(): number {
        const sym: any = Symbol("k");
        const o: any = {};
        o["a"] = 1;
        o[sym] = 2;
        const keys: any = Reflect.ownKeys(o);
        let strCount: number = 0;
        let symCount: number = 0;
        for (const k of keys) {
          if (typeof k === "symbol") symCount = symCount + 1;
          else strCount = strCount + 1;
        }
        // Pre-fix: Object.getOwnPropertyNames drops Symbol — symCount would be 0.
        return (strCount === 1 && symCount === 1) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });
});

// Reflect.construct argument-marshaling tests are covered by the test262
// suite (built-ins/Reflect/construct/*).  Local validation here is limited
// because wasm-side array literals cross the boundary as opaque wasm structs
// that the host's CreateListFromArrayLike doesn't recognise as array-likes —
// orthogonal to #1466's host-dispatch fix.

describe("#1466 — Reflect.isExtensible / preventExtensions agree with host state", () => {
  it("preventExtensions then isExtensible returns host's runtime answer", async () => {
    const result = await run(`
      export function test(): number {
        const o: any = {};
        const before: any = Reflect.isExtensible(o);
        const ok: any = Reflect.preventExtensions(o);
        const after: any = Reflect.isExtensible(o);
        return (before === true && ok === true && after === false) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });
});

describe("#1466 — Reflect.getPrototypeOf / setPrototypeOf round-trip", () => {
  it("setPrototypeOf updates prototype, observable via getPrototypeOf", async () => {
    const result = await run(`
      export function test(): number {
        const base: any = {hi: 1};
        const obj: any = {};
        const ok: any = Reflect.setPrototypeOf(obj, base);
        const p: any = Reflect.getPrototypeOf(obj);
        return (ok === true && p === base) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });
});

describe("#1466 — Reflect.defineProperty descriptor round-trip", () => {
  it("Reflect.defineProperty + Reflect.getOwnPropertyDescriptor preserves writable=false", async () => {
    const result = await run(`
      export function test(): number {
        const o: any = {};
        const ok: any = Reflect.defineProperty(o, "x", {value: 7, writable: false, configurable: false, enumerable: true});
        const d: any = Reflect.getOwnPropertyDescriptor(o, "x");
        return (ok === true && d.value === 7 && d.writable === false && d.configurable === false) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });
});

describe("#1466 — Reflect.has / Reflect.get on regular objects", () => {
  it("Reflect.has returns true for own property, false otherwise", async () => {
    const result = await run(`
      export function test(): number {
        const o: any = {x: 1};
        const a: any = Reflect.has(o, "x");
        const b: any = Reflect.has(o, "missing");
        return (a === true && b === false) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("Reflect.get reads own property value", async () => {
    const result = await run(`
      export function test(): number {
        const o: any = {x: 99};
        const v: any = Reflect.get(o, "x");
        return v === 99 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });
});

describe("#1466 — Reflect dispatch through a JS-side Proxy installed on globalThis", () => {
  // When the Proxy is reachable via globalThis (host-installed before instantiation),
  // Reflect.X dispatched through the host's __reflect_* import flows through the
  // proxy's MOP — verifying the spec hooks are preserved end-to-end.
  it("Reflect.has on a host-installed Proxy fires the has trap", async () => {
    let trapHit = 0;
    const sentinel = new Proxy(
      {},
      {
        has(_t, _p) {
          trapHit++;
          return false;
        },
      },
    );
    (globalThis as any).__r1466_proxy = sentinel;
    try {
      const r = await run(`
        export function test(): number {
          const p: any = (globalThis as any).__r1466_proxy;
          const ok: any = Reflect.has(p, "anything");
          return ok === false ? 1 : 0;
        }
      `);
      expect(r).toBe(1);
      expect(trapHit).toBeGreaterThanOrEqual(1);
    } finally {
      (globalThis as any).__r1466_proxy = undefined;
    }
  });
});
