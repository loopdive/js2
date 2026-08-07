// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4196 slice 1 — `[[Construct]]` through a bound function in `--target
// standalone` (ECMA-262 §10.4.1.2).
//
// Before this landed, `new (f.bind(o, …))()` in a host-free target evaluated to
// **null** with no trap and no diagnostic: #3140 wired the bound carrier's
// [[Call]] side but there was no `$__bound_fn` arm anywhere in the `new`
// lowering, so the site fell out of the dynamic-ctor chain as
// `ref.null.extern`.
//
// ANTI-TAUTOLOGY: the first test asserts the PRECONDITION explicitly — the
// carrier must exist and be callable (`typeof bound === "function"`, and
// calling it normally already applies the bound args). Every `new`-side
// assertion below is meaningless unless that precondition holds, so it is
// asserted rather than assumed. Without it a fixture that never reaches the
// carrier would pass on unpatched main and prove nothing.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile `source` host-free, assert zero imports, run `test()`. */
async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, { fileName: "issue-4196.ts", target: "standalone" });
  expect(result.errors.filter((e) => e.severity === "error").map((e) => e.message)).toEqual([]);
  expect(result.success).toBe(true);
  // Host-free: a standalone verdict may never depend on a JS-host import (#2961).
  expect(result.imports ?? []).toHaveLength(0);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as Record<string, () => number>;
  exports.__module_init?.();
  return exports.test!();
}

describe("#4196 — [[Construct]] through a bound function (standalone)", () => {
  it("the $__bound_fn carrier exists and its CALL side already works (precondition)", async () => {
    // Green on BOTH arms by design. If this ever fails, every other case in
    // this file is vacuous — the fixture is not reaching the carrier at all.
    const code = await runStandalone(`
      export function test(): number {
        const target = function (x: any, y: any, z: any) {
          return "" + x + y + z;
        };
        const bound: any = (target as any).bind({}, "a", "b");
        let score = 0;
        if (typeof bound === "function") score += 1;
        if (bound("c") === "abc") score += 2;
        return score;
      }
    `);
    expect(code).toBe(3);
  });

  it("uses [[BoundArgs]] as the FORMER part of the construct argument list", async () => {
    // test262 built-ins/Function/prototype/bind/15.3.4.5.2-4-1
    const code = await runStandalone(`
      export function test(): number {
        const target = function (x: any, y: any, z: any) {
          const out: any = {};
          out.joined = "" + x + y + z;
          return out;
        };
        const Bound: any = (target as any).bind({}, "a", "b", "c");
        const inst: any = new Bound();
        if (inst === null || inst === undefined) return 1;
        return inst.joined === "abc" ? 100 : 2;
      }
    `);
    expect(code).toBe(100);
  });

  it("uses the provided arguments as the LATTER part, after [[BoundArgs]]", async () => {
    // 15.3.4.5.2-4-2 (no bound args) and -4-13 (bound + extra) in one fixture.
    const code = await runStandalone(`
      export function test(): number {
        const target = function (x: any, y: any, z: any) {
          const out: any = {};
          out.joined = "" + x + y + z;
          return out;
        };
        let score = 0;
        const NoneBound: any = (target as any).bind({});
        if ((new NoneBound("a", "b", "c") as any).joined === "abc") score += 1;
        const OneBound: any = (target as any).bind({}, "a");
        if ((new OneBound("b", "c") as any).joined === "abc") score += 2;
        return score;
      }
    `);
    expect(code).toBe(3);
  });

  it("composes a bound-of-bound chain, outermost [[BoundArgs]] first", async () => {
    const code = await runStandalone(`
      export function test(): number {
        const target = function (x: any, y: any, z: any) {
          const out: any = {};
          out.joined = "" + x + y + z;
          return out;
        };
        const inner: any = (target as any).bind({}, "a");
        const outer: any = (inner as any).bind({}, "b");
        const inst: any = new outer("c");
        if (inst === null || inst === undefined) return 1;
        return inst.joined === "abc" ? 100 : 2;
      }
    `);
    expect(code).toBe(100);
  });

  it("IGNORES [[BoundThis]] — the receiver is the freshly created object", async () => {
    // §10.4.1.2 threads newTarget, never [[BoundThis]]. This is the one place
    // the construct path must NOT reuse __apply_closure's front guard, which
    // deliberately lets [[BoundThis]] beat the caller-supplied receiver
    // (§10.4.1.1, the CALL rule).
    const code = await runStandalone(`
      export function test(): number {
        const boundThis: any = {};
        boundThis.tag = "bound-this";
        const target = function (this: any) {
          this.tag = "fresh";
        };
        const Bound: any = (target as any).bind(boundThis);
        const inst: any = new Bound();
        if (inst === null || inst === undefined) return 1;
        if (inst === boundThis) return 2;
        if (boundThis.tag !== "bound-this") return 3;
        return inst.tag === "fresh" ? 100 : 4;
      }
    `);
    expect(code).toBe(100);
  });

  it("returns the fresh instance when the target body returns a non-object", async () => {
    // §10.2.2 step 13. The null test must be separate from the typeof probe:
    // typeof null === "object", so folding them would return null from `new`.
    const code = await runStandalone(`
      export function test(): number {
        const target = function (this: any, v: any) {
          this.seen = v;
          return 42;
        };
        const Bound: any = (target as any).bind({}, "x");
        const inst: any = new Bound();
        if (inst === null || inst === undefined) return 1;
        if (inst === 42) return 2;
        return inst.seen === "x" ? 100 : 3;
      }
    `);
    expect(code).toBe(100);
  });

  it("BYTE-NEUTRALITY: a bind-free module emits no __construct_bound at all", async () => {
    // The retry sits on the #2872 dynamic-`$__ta_ctor` arm, which every
    // host-free `new <any-typed binding>(…)` in the corpus goes through. Without
    // the source-file gate this change would move the bytes of all of them. The
    // gate is what keeps the blast radius at "modules that call .bind".
    const dynamicNewNoBind = `
      export function test(): number {
        const ctors: any = [Int8Array, Uint8Array];
        const C: any = ctors[0];
        const view: any = new C(2);
        return view.length;
      }
    `;
    const bare = await compile(dynamicNewNoBind, { fileName: "no-bind.ts", target: "standalone" });
    expect(bare.success).toBe(true);
    expect(bare.wat).not.toContain("__construct_bound");

    // Same module plus one `.bind` call: now the driver IS emitted.
    const withBind = await compile(`${dynamicNewNoBind}\nexport const b: any = (test as any).bind(null);`, {
      fileName: "with-bind.ts",
      target: "standalone",
    });
    expect(withBind.success).toBe(true);
    expect(withBind.wat).toContain("__construct_bound");
  });

  it("REGRESSION: a SYNTHESIZED new node (Reflect.construct) must not crash the compile", async () => {
    // `Reflect.construct(...)` desugars to a NewExpression with no parent chain,
    // so `getSourceFile()` on it is `undefined` — and handing that to the
    // byte-neutrality memo's WeakMap is a hard "Invalid value used as weak map
    // key" that kills the whole compile. The `.bind` below arms the gate; the
    // control sweep caught this on 7 previously-passing
    // TypedArrayConstructors/.../use-default-proto-if-custom-proto-is-not-object.js.
    const result = await compile(
      `
      function newTarget() {}
      (newTarget as any).prototype = null;
      export function test(): number {
        const TA: any = Int8Array;
        const bound: any = (newTarget as any).bind(null);
        const ta: any = (Reflect as any).construct(TA, [], newTarget);
        return ta === null || bound === null ? 1 : 100;
      }
    `,
      { fileName: "synth-new.ts", target: "standalone" },
    );
    const internal = result.errors.filter((e) => /Internal error|weak map key/i.test(e.message));
    expect(internal.map((e) => e.message)).toEqual([]);
  });

  it("CONTROL: a dynamic non-bound callee is unaffected", async () => {
    // Green on BOTH arms. The driver's first act is a `ref.test $__bound_fn`
    // that declines, so every other dynamic-`new` callee keeps its pre-#4196
    // value — this is what makes the change a pure addition.
    const code = await runStandalone(`
      export function test(): number {
        const ctors: any = [Int8Array, Uint8Array];
        let total = 0;
        for (let i = 0; i < 2; i++) {
          const C: any = ctors[i];
          const view: any = new C(3);
          total += view.length;
        }
        return total;
      }
    `);
    expect(code).toBe(6);
  });
});
