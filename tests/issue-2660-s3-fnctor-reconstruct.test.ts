// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2660 S3a — reconstruct an APPROVED, EMPTY-BODY `new F()` as a native
// `$Object` (standalone) — the value-rep CANARY slice.
//
// A `new F()` instance is normally lowered to a bespoke closed WasmGC struct
// `$__fnctor_<Name>` that has NO `$proto` field, so inherited-prototype reads on
// it (`c.foo` where `foo` lives on `F.prototype`) miss every dynamic lookup and
// resolve to 0/undefined. S3a reconstructs the instance as a real `$Object` whose
// `$proto` is seeded from F's per-fnctor prototype `$Object` (S2,
// `ctx.fnctorPrototypeObject[F]`) via `__object_create`, so inherited reads
// resolve through the ONE `$Object.$proto` walk.
//
// SCOPE (the narrow canary gate — see new-super.ts `compileNewFunctionDeclaration`):
// reconstruct fires ONLY on  standalone ∩ S1-escape-gate-approved ∩ empty body ∩
// no ctor args ∩ the instance's result-externref flows into an externref slot
// (an `any`/`unknown` function-local binding, or an inline `new F().x`/`[i]`
// receiver). It banks ~0 of the test262 cluster BY DESIGN — that cluster's
// bindings are the nominal `(ref $__fnctor_F)` instance type and need the broad
// binding-retype (S3b), NOT this slice. S3a only PROVES the alloc + `$proto`-seed
// mechanism on the floor. Every non-approved / typed / struct-bound site keeps the
// bespoke struct lowering byte-identically (#1888 hot-path protection); host/WASI
// never enter the reconstruct arm at all (gated on `ctx.standalone`).

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "invalid wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#2660 S3a — reconstruct approved empty-body new F() as $Object (standalone)", () => {
  it("canary: function Con(){}; Con.prototype={foo:7}; const c:any=new Con(); c.foo (was 0)", async () => {
    expect(
      await runStandalone(
        `function Con(){}; Con.prototype = {foo:7}; export function test():number{ const c:any = new Con(); return c.foo; }`,
      ),
    ).toBe(7);
  });

  it("bare-identifier prototype reassign (no cast), any binding", async () => {
    expect(
      await runStandalone(
        `function Con(){}; Con.prototype = {foo:7}; export function test():number{ const c:any = new Con(); const v:number = c.foo; return v; }`,
      ),
    ).toBe(7);
  });

  it("inline new Con().foo (no binding) routes through the dynamic proto walk", async () => {
    expect(
      await runStandalone(
        `function Con(){}; Con.prototype = {foo:7}; export function test():number{ return (new Con() as any).foo; }`,
      ),
    ).toBe(7);
  });

  it("per-prop prototype accumulates multiple keys, any binding", async () => {
    expect(
      await runStandalone(
        `function Con(){}; Con.prototype.a = 5; Con.prototype.b = 7; export function test():number{ const c:any = new Con(); const x:number = c.a; const y:number = c.b; return x + y; }`,
      ),
    ).toBe(12);
  });

  it("indexed prototype key resolves on the reconstructed instance", async () => {
    expect(
      await runStandalone(
        `function Con(){}; (Con as any).prototype = {5:99}; export function test():number{ const c:any = new Con(); return c[5]; }`,
      ),
    ).toBe(99);
  });

  it("function-expression fnctor (var Con = function(){}) reconstructs", async () => {
    expect(
      await runStandalone(
        `var Con = function(){}; (Con as any).prototype = {foo:7}; export function test():number{ const c:any = new Con(); return c.foo; }`,
      ),
    ).toBe(7);
  });

  it("two approved sites of the same empty fnctor both reconstruct independently", async () => {
    // Both bindings are USED dynamically → both sites are `reconstruct`, so the
    // first reconstructs (early-returns, building NO funcConstructorMap cache)
    // and the second still reaches the gate (cache empty) and reconstructs too.
    // Reads are coerced to `number` before the `+` because `any + any` is a
    // separate pre-existing standalone arithmetic gap (returns 0) unrelated to
    // reconstruction.
    expect(
      await runStandalone(
        `function Con(){}; Con.prototype = {foo:7}; export function test():number{ const a:any = new Con(); const b:any = new Con(); const x:number = a.foo; const y:number = b.foo; return x + y; }`,
      ),
    ).toBe(14);
  });

  // ── REGRESSION GUARDS (status quo MUST be preserved) ──────────────────────

  it("HOT-PATH GUARD: typed own-field new C(){this.x=3} stays the bespoke struct (3, not regressed)", async () => {
    // `this.x` makes the fnctor `keep-typed` (clause B) AND non-empty-body, so
    // BOTH the S1 gate and the empty-body gate decline reconstruction. The read
    // stays a `struct.get $__fnctor_C` — the #1888 hot path that must NOT move
    // to `__extern_get`.
    expect(
      await runStandalone(`function C(){this.x=3}; export function test():number{ const c = new C(); return c.x; }`),
    ).toBe(3);
  });

  it("STRUCT-BINDING GUARD: nominal instance is not reconstructed and a missing read stays undefined", async () => {
    // The binding's ALLOCATED local is `(ref $__fnctor_Con)`, not externref, so
    // G4 declines — returning externref into a struct-ref local would
    // ref.cast-trap. S3a leaves this to S3b (binding-retype). The inherited
    // read therefore misses, and the numeric export observes Number(undefined)
    // as NaN; the module remains valid and does not trap. A result of 7 would
    // mean this site had been reconstructed despite the guard.
    expect(
      await runStandalone(
        `function Con(){}; Con.prototype = {foo:7}; export function test():number{ const c = new Con(); return (c as any).foo; }`,
      ),
    ).toBeNaN();
  });

  it("no F.prototype assignment → reconstructed instance has an empty proto, no trap (0)", async () => {
    expect(
      await runStandalone(
        `function Con(){}; export function test():number{ const c:any = new Con(); return c.foo ? 1 : 0; }`,
      ),
    ).toBe(0);
  });
});
