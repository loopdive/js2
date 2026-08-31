// #4628 — `.prototype` on a class read as a VALUE.
//
// Surfaced by the #4628 provider work, but it is a general compiler defect and
// stands on its own:
//
//   class C { m() {} }
//   function tag(e) { Object.defineProperty(e.prototype, Symbol.toStringTag, …); }
//   tag(C);        // TypeError: Object.defineProperty called on non-object
//
// A class object is a `$ClassName` WasmGC struct, not a CLOSURE struct, so the
// host's `.prototype` reader (`_getOrVivifyFnPrototype`, gated on the exact
// `__is_closure` export) declined it and the dynamic read answered `undefined`
// — while the STATIC lane (`emitLazyProtoGet`) answered the real prototype
// singleton all along. The split is invisible until a class crosses a function
// boundary as a value, because `typeof C`, `new C()`, `C.name` and even
// `arr[0].prototype` are all served by statically-resolved arms.
//
// `@js-temporal/polyfill` does exactly that on every one of its nine classes
// (`ae(Instant, "Temporal.Instant")` → `Object.defineProperty(e.prototype, …)`),
// which is why its module init threw the moment it was compiled as a linked
// provider. The fix reads the prototype out of the class-ctor registry that
// `__register_class_ctor` already populates at singleton init.
//
// Fix: src/runtime.ts `_classObjectPrototypeStruct`, consulted by both
// `__extern_get` bindings before the closure-vivify fallback.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function run(source: string, deferTopLevelInit = false): Promise<unknown> {
  const result = await compile(source, {
    fileName: "issue-4628-proto.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    emitWat: false,
    deferTopLevelInit,
  });
  expect(result.success).toBe(true);
  const imports = result.importObject as WebAssembly.Imports & { __setInstance?: (i: WebAssembly.Instance) => void };
  const { instance } = await WebAssembly.instantiate(result.binary as unknown as BufferSource, imports);
  imports.__setInstance?.(instance);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return (instance.exports as { run?: () => unknown }).run?.();
}

describe("#4628 — class object `.prototype` through the dynamic lane", () => {
  // Base: "undefined".
  it("reads as an object when the class arrives as a function parameter", async () => {
    expect(
      await run(`
        class C { m() { return 1; } }
        function probe(e) { return typeof e.prototype; }
        export function run() { return probe(C); }
      `),
    ).toBe("object");
  });

  // Base: THREW "Object.defineProperty called on non-object". This is the
  // exact `@js-temporal/polyfill` shape (its `ae` helper).
  it("accepts a defineProperty against the prototype of a passed class", async () => {
    expect(
      await run(`
        class C { m() { return 1; } }
        function tag(e, t) {
          Object.defineProperty(e.prototype, Symbol.toStringTag, {
            value: t, writable: false, enumerable: false, configurable: true,
          });
          return "tagged";
        }
        export function run() { return tag(C, "C"); }
      `),
    ).toBe("tagged");
  });

  // The two lanes must agree: the dynamic read returns the SAME prototype
  // singleton the static lane hands out, not a fresh facade object. This is
  // why the fix returns the raw struct rather than a `_wrapForHost` proxy.
  // Base: 0 (false) — the dynamic read answered undefined, so it could not
  // possibly match. The fix returns the RAW prototype singleton rather than a
  // `_wrapForHost` proxy precisely so the two lanes agree here. (A compiled
  // boolean export marshals as i32, hence 1 rather than `true`.)
  it("returns the same object the static lane returns", async () => {
    expect(
      await run(`
        class C { m() { return 1; } }
        function probe(e) { return e.prototype; }
        export function run() { return probe(C) === C.prototype; }
      `),
    ).toBe(1);
  });

  it("holds under deferTopLevelInit, where the static arm does not apply", async () => {
    expect(
      await run(
        `
        class C { m() { return 1; } }
        function probe(e) { return typeof e.prototype; }
        const atInit = probe(C);
        export function run() { return atInit; }
      `,
        true,
      ),
    ).toBe("object");
  });

  // Controls — shapes that already worked must not move.
  // NOT a claim that this is spec-correct — `({}).prototype` should be
  // undefined and answers "object" here. It is pre-existing on this branch's
  // base (measured both ways, `.tmp/probe-ctrl.mts`: base "object", after
  // "object"): a plain object literal is a WasmGC struct and the closure
  // vivify path cannot tell it apart when `__is_closure` declines to answer.
  // Pinned as a CONTROL so this fix is provably not what moved it.
  it("a plain object's prototype read is unchanged by this fix", async () => {
    expect(
      await run(`
        const o = { x: 1 };
        function probe(e) { return typeof e.prototype; }
        export function run() { return probe(o); }
      `),
    ).toBe("object");
  });

  it("a function value still vivifies its own prototype", async () => {
    expect(
      await run(`
        function f() {}
        function probe(e) { return typeof e.prototype; }
        export function run() { return probe(f); }
      `),
    ).toBe("object");
  });

  it("the statically-resolved read is unchanged", async () => {
    expect(
      await run(`
        class C { m() { return 1; } }
        export function run() { return typeof C.prototype; }
      `),
    ).toBe("object");
  });
});
