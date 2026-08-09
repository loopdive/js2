/**
 * #3683 S2 — typed-`this` twin compilation for fnctor prototype methods.
 *
 * An admitted write-once prototype method is compiled TWICE: the generic body
 * (dynamic `this` via `__current_this`) gains a `ref.test $__fnctor_F` shim
 * that tail-forwards to a TWIN whose prologue casts the receiver once into a
 * typed local, after which `this.<field>` reads/writes/updates lower to bare
 * `struct.get`/`struct.set`.
 *
 * These pins cover the two things that can go wrong:
 *   (1) the twin must be OBSERVATIONALLY identical to the generic body —
 *       including for the carve-outs it declines (presence-tracked fields,
 *       accessor props, deleted slots, detached receivers); and
 *   (2) the shim must actually be taken for a normal instance, otherwise the
 *       whole slice is dead weight (`JS2WASM_TYPED_THIS=0` reproduces the
 *       pre-S2 output for a differential check).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

async function runStandalone(source: string, env?: Record<string, string>): Promise<unknown> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const r = await compile(source, { fileName: "t.ts", skipSemanticDiagnostics: true, target: "standalone" });
    expect(r.binary?.length ?? 0).toBeGreaterThan(0);
    const module = await WebAssembly.compile(r.binary as BufferSource);
    expect(WebAssembly.Module.imports(module).length).toBe(0);
    const { exports } = await WebAssembly.instantiate(module, {});
    return (exports as { test?: () => unknown }).test?.();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  }
}

/** Run the same program with twins ON and OFF; both must agree. */
async function bothLanes(source: string): Promise<{ twin: unknown; generic: unknown }> {
  const twin = await runStandalone(source);
  const generic = await runStandalone(source, { JS2WASM_TYPED_THIS: "0" });
  return { twin, generic };
}

describe("#3683 S2 — typed-`this` twin", () => {
  it("emits a twin for a write-once prototype method and keeps the result", async () => {
    const r = await compile(
      `var P = function P(n) { this.pos = n; this.acc = 0; };
var pp = P.prototype;
pp.step = function (k) { this.pos = this.pos + k; return this.pos; };
var p = new P(3);
export function test(): number { return p.step(4); }`,
      { fileName: "t.ts", skipSemanticDiagnostics: true, target: "standalone" },
    );
    expect(r.success).toBe(true);
    // The twin is a real second function, named after its generic sibling.
    expect(r.wat).toMatch(/__typed_this/);
    const module = await WebAssembly.compile(r.binary as BufferSource);
    const { exports } = await WebAssembly.instantiate(module, {});
    expect((exports as { test: () => unknown }).test()).toBe(7);
  });

  it("no twin when JS2WASM_TYPED_THIS=0 (kill-switch reproduces pre-S2 output)", async () => {
    const saved = process.env.JS2WASM_TYPED_THIS;
    process.env.JS2WASM_TYPED_THIS = "0";
    try {
      const r = await compile(
        `var P = function P(n) { this.pos = n; };
var pp = P.prototype;
pp.get = function () { return this.pos; };
var p = new P(3);
export function test(): number { return p.get(); }`,
        { fileName: "t.ts", skipSemanticDiagnostics: true, target: "standalone" },
      );
      expect(r.success).toBe(true);
      expect(r.wat).not.toMatch(/__typed_this/);
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TYPED_THIS");
      else process.env.JS2WASM_TYPED_THIS = saved;
    }
  });

  it("read / write / compound / inc-dec all agree with the generic lowering", async () => {
    const src = `var P = function P(n) { this.pos = n; this.acc = 0; };
var pp = P.prototype;
pp.exercise = function (k) {
  this.acc = this.pos;      // plain write
  this.acc += k;            // compound
  this.pos++;               // postfix update
  --this.acc;               // prefix update
  this.acc = this.acc * 2;  // write from a read
  return this.acc + this.pos;
};
var p = new P(10);
export function test(): number { return p.exercise(5); }`;
    // acc: 10 → 15 → 14 → 28 ; pos: 10 → 11 ; result 39
    const { twin, generic } = await bothLanes(src);
    expect(twin).toBe(39);
    expect(generic).toBe(39);
  });

  it("postfix `this.x++` yields the OLD value, prefix yields the NEW one", async () => {
    const src = `var P = function P() { this.a = 5; this.b = 5; };
var pp = P.prototype;
pp.probe = function () { var post = this.a++; var pre = ++this.b; return post * 100 + pre; };
var p = new P();
export function test(): number { return p.probe(); }`;
    const { twin, generic } = await bothLanes(src);
    expect(twin).toBe(506); // post = 5, pre = 6
    expect(generic).toBe(506);
  });

  it("`this.x = v` evaluates to the assigned value", async () => {
    const src = `var P = function P() { this.a = 0; };
var pp = P.prototype;
pp.probe = function () { var got = (this.a = 42); return got + this.a; };
var p = new P();
export function test(): number { return p.probe(); }`;
    const { twin, generic } = await bothLanes(src);
    expect(twin).toBe(84);
    expect(generic).toBe(84);
  });

  it("a CONDITIONALLY-assigned (presence-tracked) field reads identically in both lanes", async () => {
    // `maybe` is only assigned on one branch ⇒ presence-tracked ⇒ the inline
    // struct.get carve-out must DECLINE and keep the presence-aware dispatcher.
    // The invariant under test is twin ≡ generic; whether an unset slot reads
    // as `undefined` at all is a separate, pre-existing question (both lanes
    // currently answer the same non-`undefined` way here).
    const src = `var P = function P(f) { this.base = 1; if (f) { this.maybe = 9; } };
var pp = P.prototype;
pp.probe = function () { return this.maybe === undefined ? 1 : 0; };
var set = new P(1);
var unset = new P(0);
export function test(): number { return unset.probe() * 10 + set.probe(); }`;
    const { twin, generic } = await bothLanes(src);
    expect(twin).toBe(generic);
  });

  it("a DELETED own field reads the same through the twin as through the generic body", async () => {
    const src = `var P = function P() { this.a = 7; this.b = 1; };
var pp = P.prototype;
pp.readA = function () { return this.a === undefined ? -1 : this.a; };
var p = new P();
var before = p.readA();
delete p.a;
var after = p.readA();
export function test(): number { return before * 10 + (after === -1 ? 0 : 1); }`;
    const { twin, generic } = await bothLanes(src);
    expect(twin).toBe(generic);
  });

  it("a DETACHED receiver falls back to the generic body (shim miss)", async () => {
    // `pp.get.call(plain)` runs the method with a non-`$__fnctor_P` receiver:
    // `ref.test` must fail and the generic dynamic body must handle it.
    const src = `var P = function P() { this.v = 1; };
var pp = P.prototype;
pp.get = function () { return this.v; };
var p = new P();
var plain = { v: 99 };
export function test(): number { return p.get() * 100 + pp.get.call(plain); }`;
    // twin ≡ generic is the S2 invariant. The absolute value is the
    // JS-correct 199 (1*100 + 99): the sibling `Function.prototype.call/
    // apply on a closure` fix (merged after this pin was written against a
    // base where the detached read answered 0) makes `.call(plain)` read the
    // real receiver — in BOTH lanes.
    const { twin, generic } = await bothLanes(src);
    expect(twin).toBe(generic);
    expect(twin).toBe(199);
  });

  it("params, defaults and locals survive the second compilation", async () => {
    const src = `var P = function P() { this.n = 0; };
var pp = P.prototype;
pp.addAll = function (a, b) {
  if (b === undefined) { b = 100; }
  var total = 0;
  for (var i = 0; i < 3; i++) { total = total + a + b; }
  this.n = total;
  return this.n;
};
var p = new P();
export function test(): number { return p.addAll(1) + p.addAll(1, 2); }`;
    const { twin, generic } = await bothLanes(src);
    expect(twin).toBe(312); // 3*(1+100) + 3*(1+2) = 303 + 9
    expect(generic).toBe(312);
  });

  it("a method containing a nested function is NOT twinned (no re-minted closures)", async () => {
    const r = await compile(
      `var P = function P() { this.n = 2; };
var pp = P.prototype;
pp.viaNested = function () { var self = this.n; var f = function (x) { return x * 3; }; return f(self); };
var p = new P();
export function test(): number { return p.viaNested(); }`,
      { fileName: "t.ts", skipSemanticDiagnostics: true, target: "standalone" },
    );
    expect(r.success).toBe(true);
    expect(r.wat).not.toMatch(/__typed_this/);
    const module = await WebAssembly.compile(r.binary as BufferSource);
    const { exports } = await WebAssembly.instantiate(module, {});
    expect((exports as { test: () => unknown }).test()).toBe(6);
  });

  it("a REASSIGNED prototype method is NOT twinned (write-once verdict absent)", async () => {
    const r = await compile(
      `var P = function P() { this.n = 1; };
var pp = P.prototype;
pp.m = function () { return this.n; };
pp.m = function () { return this.n + 10; };
var p = new P();
export function test(): number { return p.m(); }`,
      { fileName: "t.ts", skipSemanticDiagnostics: true, target: "standalone" },
    );
    expect(r.success).toBe(true);
    expect(r.wat).not.toMatch(/__typed_this/);
    const module = await WebAssembly.compile(r.binary as BufferSource);
    const { exports } = await WebAssembly.instantiate(module, {});
    expect((exports as { test: () => unknown }).test()).toBe(11);
  });

  it("host (non-standalone) mode is untouched — twins are standalone-only", async () => {
    const r = await compile(
      `var P = function P() { this.n = 4; };
var pp = P.prototype;
pp.m = function () { return this.n; };
var p = new P();
export function test(): number { return p.m(); }`,
      { fileName: "t.ts", skipSemanticDiagnostics: true },
    );
    expect(r.success).toBe(true);
    expect(r.wat).not.toMatch(/__typed_this/);
  });
});
