// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #802 Slices B+C — dynamic prototype support for CLOSED-shape class-instance
// receivers of Object.setPrototypeOf / Reflect.setPrototypeOf / `o.__proto__ =`.
//
// A class instance is a bespoke WasmGC struct (typed fields, methods, an
// instanceof `__tag`), so it fails the native `ref.test $Object` that
// `__object_setPrototypeOf` uses — the proto link was silently dropped and
// inherited reads returned `undefined`/0. Slice B appends ONE conditional
// externref `$__proto__` field (standalone only, prescan-gated to the marked
// hierarchy root, appended LAST — the #799a-regression-avoidance design). Slice
// C walks that field on the read path (`__extern_get`) and answers
// `Object.getPrototypeOf`. gc/host mode is untouched (WeakMap sidecar).
//
// Standalone-only: gc/host models dynamic protos via the host
// `_wasmStructProto` sidecar and its structs are never given the field.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "invalid wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#802 Slices B+C — class-instance dynamic prototype (standalone)", () => {
  it("setPrototypeOf(classInstance, {foo}) → inherited read resolves (was undefined)", async () => {
    expect(
      await runStandalone(
        `class C { x: number = 1; }
         export function test(): number {
           const c = new C();
           Object.setPrototypeOf(c, { foo: 7 });
           return (c as any).foo;
         }`,
      ),
    ).toBe(7);
  });

  it("setPrototypeOf(classInstance, null) → getPrototypeOf === null", async () => {
    expect(
      await runStandalone(
        `class C { x: number = 1; }
         export function test(): number {
           const c = new C();
           Object.setPrototypeOf(c, null);
           return Object.getPrototypeOf(c) === null ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("untouched instance still reports its class prototype (singleton identity)", async () => {
    expect(
      await runStandalone(
        `class C { m(): number { return 3; } }
         export function test(): number {
           const c = new C();
           return Object.getPrototypeOf(c) === C.prototype ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("getPrototypeOf round-trips the set proto by identity", async () => {
    expect(
      await runStandalone(
        `class C { x: number = 1; }
         export function test(): number {
           const c = new C();
           const p: any = { foo: 7 };
           Object.setPrototypeOf(c, p);
           return Object.getPrototypeOf(c) === p ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("cycle is refused (a→b, b→a) — no hang, first link preserved", async () => {
    expect(
      await runStandalone(
        `class C { x: number = 1; }
         export function test(): number {
           const a = new C();
           const b = new C();
           Object.setPrototypeOf(a, b);
           Object.setPrototypeOf(b, a); // §10.1.2.1 step 8 refuse
           return Object.getPrototypeOf(b) === C.prototype ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("multi-level struct→struct→literal chain read", async () => {
    expect(
      await runStandalone(
        `class C { x: number = 1; }
         export function test(): number {
           const a = new C();
           const b = new C();
           const d = new C();
           Object.setPrototypeOf(a, b);
           Object.setPrototypeOf(b, d);
           Object.setPrototypeOf(d, { deep: 42 });
           return (a as any).deep;
         }`,
      ),
    ).toBe(42);
  });

  it("`o.__proto__ = p` setter form links (through an `as any` cast)", async () => {
    expect(
      await runStandalone(
        `class C { x: number = 1; }
         export function test(): number {
           const c = new C();
           (c as any).__proto__ = { foo: 9 };
           return (c as any).foo;
         }`,
      ),
    ).toBe(9);
  });

  it("Reflect.setPrototypeOf returns true and records the link", async () => {
    expect(
      await runStandalone(
        `class C { x: number = 1; }
         export function test(): number {
           const c = new C();
           const ok = Reflect.setPrototypeOf(c, { foo: 5 });
           return ok && (c as any).foo === 5 ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("explicit-null proto → inherited read is undefined", async () => {
    expect(
      await runStandalone(
        `class C { x: number = 1; }
         export function test(): number {
           const c = new C();
           Object.setPrototypeOf(c, null);
           return (c as any).foo === undefined ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("re-set after explicit null works", async () => {
    expect(
      await runStandalone(
        `class C { x: number = 1; }
         export function test(): number {
           const c = new C();
           Object.setPrototypeOf(c, null);
           Object.setPrototypeOf(c, { foo: 6 });
           return (c as any).foo;
         }`,
      ),
    ).toBe(6);
  });

  it("subclass receiver → root promotion; sibling instance untouched", async () => {
    expect(
      await runStandalone(
        `class A { x: number = 1; }
         class B extends A { y: number = 2; }
         export function test(): number {
           const b = new B();
           Object.setPrototypeOf(b, { foo: 4 });
           const other = new B();
           const inherited: number = (b as any).foo;
           const untouched = Object.getPrototypeOf(other) === B.prototype ? 1 : 0;
           return inherited + untouched;
         }`,
      ),
    ).toBe(5);
  });

  it("two independent marked hierarchies each link correctly", async () => {
    expect(
      await runStandalone(
        `class C { x: number = 1; }
         class D { y: number = 2; }
         export function test(): number {
           const c = new C();
           const d = new D();
           Object.setPrototypeOf(c, { p: 10 });
           Object.setPrototypeOf(d, { q: 20 });
           return (c as any).p + (d as any).q;
         }`,
      ),
    ).toBe(30);
  });

  // Regression guards — the pre-#802 paths must stay byte-correct.
  it("setPrototypeOf returns the receiver (§20.1.2.21)", async () => {
    expect(
      await runStandalone(
        `class C { x: number = 5; }
         export function test(): number {
           const c = new C();
           const r: any = Object.setPrototypeOf(c, { foo: 1 });
           return r === c ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("own declared field shadows the inherited one (typed read)", async () => {
    expect(
      await runStandalone(
        `class C { x: number = 1; }
         export function test(): number {
           const c = new C();
           Object.setPrototypeOf(c, { x: 99 });
           return c.x;
         }`,
      ),
    ).toBe(1);
  });

  it("Object.keys on a marked instance does not leak __proto__", async () => {
    expect(
      await runStandalone(
        `class C { x: number = 1; }
         export function test(): number {
           const c = new C();
           Object.setPrototypeOf(c, { foo: 7 });
           return Object.keys(c).length;
         }`,
      ),
    ).toBe(1);
  });

  it("subclass constructs with fields intact when its root is marked elsewhere", async () => {
    expect(
      await runStandalone(
        `class A { x: number = 1; }
         class B extends A { y: number = 2; }
         export function test(): number {
           const b = new B();
           Object.setPrototypeOf(new A(), { p: 1 });
           return b.x + b.y;
         }`,
      ),
    ).toBe(3);
  });

  it("plain-object ($Object) setPrototypeOf path is unchanged", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const o: any = {};
           Object.setPrototypeOf(o, { foo: 7 });
           return o.foo;
         }`,
      ),
    ).toBe(7);
  });
});
