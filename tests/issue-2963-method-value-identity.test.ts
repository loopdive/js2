// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2963 / #3037 — class-METHOD first-class value identity across the DYNAMIC
// (`any`-receiver) read path, plus #3080 private-method value identity.
//
// Root cause (verified on main 928c85179d105): a dynamic member read of a
// class PROTOTYPE METHOD (`c.m` where `c: any`) returned `undefined` in BOTH
// lanes — the read resolved fields via `__sget_<f>` (host) / the
// `__get_member_<name>` dispatcher (standalone) but had NO method arm, and the
// `__extern_get` terminal knows nothing about class prototypes. Consequently
// `assert.sameValue(c.m, C.prototype.m)` failed across ~63 test262
// class-elements files (`c.m === c.m` passed only coincidentally as
// `undefined === undefined`), `typeof c.m` was "undefined", and an extracted
// `const f = c.m; f()` misbehaved.
//
// Fix: the `__get_member_<name>` dispatcher gains METHOD arms
// (member-get-dispatch.ts): after the `__extern_get` terminal MISSES (so own
// sidecar props / accessors keep shadowing), the receiver is `ref.test`ed
// against each class owning a method `<name>` (children-first for overrides)
// and answers the CANONICAL cached method-closure singleton — the SAME
// `__method_closure_<Owner>_<m>` global the typed `C.prototype.m` read mints
// via `emitCachedMethodClosureAccess` — so both paths are `===`-identical.
// Identity follows the OWNING class (`resolveMethodOwnerClass`), and class
// EXPRESSIONS canonicalise through `classExprNameMap` (the #1394 dual
// registration would otherwise mint a second singleton under the binding
// name).
//
// #3080: the private-method VALUE read with a non-`this` receiver
// (`(() => this)().#m`) returned the brand-checked RECEIVER itself; it now
// emits the same canonical singleton (brand check preserved), so
// `this.#m === (() => this)().#m` holds.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Lane = "host" | "standalone";
const LANES: Lane[] = ["host", "standalone"];

async function run(source: string, lane: Lane): Promise<unknown> {
  const opts = lane === "standalone" ? ({ target: "standalone", nativeStrings: true } as const) : {};
  const r = await compile(source, { fileName: "test.ts", ...opts });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  if (!r.success) return undefined;
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  let importObj: Record<string, unknown> = {};
  if (lane === "host") {
    importObj = buildImports(r.imports ?? [], undefined, r.stringPool) as unknown as Record<string, unknown>;
  }
  const { instance } = await WebAssembly.instantiate(r.binary, importObj as WebAssembly.Imports);
  const setExports = (importObj as { setExports?: (e: unknown) => void }).setExports;
  if (setExports) setExports(instance.exports);
  return (instance.exports as Record<string, () => unknown>).test();
}

describe.each(LANES)("#2963 dynamic method-value identity [%s]", (lane) => {
  it("c.m === C.prototype.m for an any-typed receiver (the ~63-file cluster shape)", async () => {
    expect(
      await run(
        `let c: any;
         class C { m() { return 42; } }
         export function test(): number {
           c = new C();
           if (!(c.m === C.prototype.m)) return 3;
           return 1;
         }`,
        lane,
      ),
    ).toBe(1);
  });

  it("wrapped-runner shape: class inside function, comparator over any params", async () => {
    expect(
      await run(
        `function isSameValue(a: any, b: any): number {
           if (a === b) { return 1; }
           if (a !== a && b !== b) { return 1; }
           return 0;
         }
         let c: any;
         export function test(): number {
           class C { m() { return 42; } }
           c = new C();
           if (!isSameValue(c.m(), 42)) return 2;
           if (!isSameValue(c.m, C.prototype.m)) return 3;
           return 1;
         }`,
        lane,
      ),
    ).toBe(1);
  });

  it("swap-guard: c.m !== C.prototype.n (genuine per-method identity, not a vacuous pass)", async () => {
    expect(
      await run(
        `let c: any;
         class C { m() { return 42; } n() { return 3; } }
         export function test(): number {
           c = new C();
           return (c.m === C.prototype.n) ? 1 : 0;
         }`,
        lane,
      ),
    ).toBe(0);
  });

  it("typeof c.m is 'function' (was 'undefined' on main)", async () => {
    // NOTE: uses the store-to-local form deliberately. The INLINE
    // `typeof c.m === "function"` comparison has a pre-existing host-lane
    // fold bug (wrong even for object-literal methods on pristine main —
    // verified) that is independent of this read-path fix.
    expect(
      await run(
        `let c: any;
         class C { m() { return 42; } }
         export function test(): number {
           c = new C();
           const t = typeof c.m;
           if (t === "function") return 1;
           if (t === "undefined") return 2;
           return 3;
         }`,
        lane,
      ),
    ).toBe(1);
  });

  it("extracted method value is callable: const f = c.m; f() === 42", async () => {
    expect(
      await run(
        `let c: any;
         class C { m() { return 42; } }
         export function test(): number {
           c = new C();
           const f = c.m;
           try { return f() === 42 ? 1 : 3; } catch { return 2; }
         }`,
        lane,
      ),
    ).toBe(1);
  });

  it("inherited method: identity follows the OWNING class (d.m === C.prototype.m)", async () => {
    expect(
      await run(
        `let d: any;
         class C { m() { return 42; } }
         class D extends C {}
         export function test(): number {
           d = new D();
           if (!(d.m === C.prototype.m)) return 3;
           return 1;
         }`,
        lane,
      ),
    ).toBe(1);
  });

  it("override: d.m === D.prototype.m AND d.m !== C.prototype.m (children-first arms)", async () => {
    expect(
      await run(
        `let d: any;
         class C { m() { return 42; } }
         class D extends C { m() { return 43; } }
         export function test(): number {
           d = new D();
           if (!(d.m === D.prototype.m)) return 3;
           if (d.m === C.prototype.m) return 4;
           return 1;
         }`,
        lane,
      ),
    ).toBe(1);
  });

  it("class EXPRESSION: dual registration canonicalises to ONE singleton", async () => {
    expect(
      await run(
        `let c: any;
         const C = class { m() { return 42; } };
         export function test(): number {
           c = new C();
           if (!(c.m === C.prototype.m)) return 3;
           return 1;
         }`,
        lane,
      ),
    ).toBe(1);
  });

  it("generator method identity through the dynamic read", async () => {
    expect(
      await run(
        `let c: any;
         class C { *m() { yield 42; } }
         export function test(): number {
           c = new C();
           return (c.m === C.prototype.m) ? 1 : 0;
         }`,
        lane,
      ),
    ).toBe(1);
  });

  it("dynamic FIELD reads keep working alongside the method arm (mixed shape)", async () => {
    expect(
      await run(
        `let c: any;
         class C { x = 7; m() { return 42; } }
         export function test(): number {
           c = new C();
           if (c.x !== 7) return 2;
           if (!(c.m === C.prototype.m)) return 3;
           return 1;
         }`,
        lane,
      ),
    ).toBe(1);
  });
});

describe("#2963 own-property shadowing preserved (miss-gated method arm)", () => {
  // The method arm fires ONLY when `__extern_get` misses, so a host-lane own
  // sidecar write that shadows a method name must keep winning the read.
  // (Standalone cannot store an own prop on a nominal class instance at all —
  // a pre-existing lane gap unrelated to this change — so host-only.)
  it("[host] c.m = 5; c.m reads the OWN value, not the prototype method", async () => {
    expect(
      await run(
        `let c: any;
         class C { m() { return 42; } }
         export function test(): number {
           c = new C();
           c.m = 5;
           return (c.m === 5) ? 1 : 0;
         }`,
        "host",
      ),
    ).toBe(1);
  });
});

describe.each(LANES)("#3080 private-method value identity [%s]", (lane) => {
  it("this.#m === (() => this)().#m for a class DECLARATION", async () => {
    expect(
      await run(
        `class C {
           #m() { return 1; }
           probe() { return (this.#m === (() => this)().#m) ? 1 : 0; }
         }
         export function test() { return new C().probe(); }`,
        lane,
      ),
    ).toBe(1);
  });

  it("class EXPRESSION form stays fixed (#3045)", async () => {
    expect(
      await run(
        `const C = class {
           #m() { return 1; }
           probe() { return (this.#m === (() => this)().#m) ? 1 : 0; }
         };
         export function test() { return new C().probe(); }`,
        lane,
      ),
    ).toBe(1);
  });

  it("brand check still throws on a wrong-brand receiver", async () => {
    expect(
      await run(
        `class C {
           #m() { return 1; }
           probe(o: any) { try { const v = (o as any).#m; return 0; } catch (e) { return 1; } }
         }
         export function test() { return new C().probe({} as any); }`,
        lane,
      ),
    ).toBe(1);
  });

  it("private-method CALL through the arrow receiver still works", async () => {
    expect(
      await run(
        `class C {
           #m() { return 7; }
           probe() { return (() => this)().#m(); }
         }
         export function test() { return new C().probe(); }`,
        lane,
      ),
    ).toBe(7);
  });
});
