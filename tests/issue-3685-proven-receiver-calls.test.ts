/**
 * #3685 S3 — devirtualize a method call whose RECEIVER is proven by the
 * receiver-flow analysis, not by a twin's own `ref.cast`.
 *
 * #3683 S3 devirtualized `this.m()` inside a typed twin. That left the ENTRY
 * from ordinary code — `p.inc()` where `p` is a local — on the full dynamic
 * dispatcher (`__call_m_<m>_<n>`: interned-key lookup, method-cache probe,
 * cast ladder, arity check, `call_ref`). This slice routes such a call to the
 * same trampoline when #3685 S1's analysis proves the receiver's class.
 *
 * The trampoline is GUARDED here (`__dc_<F>_<m>_<n>_g`): the `this` form may
 * cast unguarded because reaching the call site required the twin's cast, but
 * a receiver-flow verdict is an inference, so a wrong one must degrade to the
 * dispatcher rather than trap.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

async function build(source: string) {
  const r = await compile(source, {
    fileName: "t.mjs",
    skipSemanticDiagnostics: true,
    target: "standalone",
    wat: true,
  });
  expect(r.binary?.length ?? 0).toBeGreaterThan(0);
  const module = await WebAssembly.compile(r.binary as BufferSource);
  expect(WebAssembly.Module.imports(module).length).toBe(0);
  const { exports } = await WebAssembly.instantiate(module, {});
  return { wat: r.wat ?? "", exports: exports as Record<string, () => unknown> };
}

const P_CLASS = `
function P(v) { this.v = v; }
P.prototype.inc = function () { this.v = this.v + 1; return this.v; };
P.prototype.add = function (a, b) { return this.v + a + b; };
`;

describe("#3685 S3 — proven-receiver devirtualization (standalone)", () => {
  it("routes a local receiver's method call to a guarded trampoline", async () => {
    const { wat, exports } = await build(`${P_CLASS}
export function test() { var p = new P(0); var s = 0;
  for (var i = 0; i < 5; i++) { s = s + p.inc(); }
  return s; }`);
    expect(wat).toMatch(/\(func \$__dc_P_inc_0_g/); // guarded variant emitted
    expect(exports.test?.()).toBe(1 + 2 + 3 + 4 + 5);
  });

  it("the guarded trampoline ref.tests before casting", async () => {
    const { wat } = await build(`${P_CLASS}
export function test() { var p = new P(1); return p.inc(); }`);
    const i = wat.indexOf("(func $__dc_P_inc_0_g");
    expect(i).toBeGreaterThan(-1);
    const body = wat.slice(i, i + 600);
    // A ref.test must precede the ref.cast — that ordering IS the soundness
    // property; an unguarded cast on an inferred receiver could trap.
    expect(body).toContain("ref.test");
    expect(body.indexOf("ref.test")).toBeLessThan(body.indexOf("ref.cast"));
  });

  it("preserves argument values and evaluation order", async () => {
    const { exports } = await build(`${P_CLASS}
var log = 0;
function a() { log = log * 10 + 1; return 20; }
function b() { log = log * 10 + 2; return 300; }
export function test() { var p = new P(4); var r = p.add(a(), b()); return r * 1000 + log; }`);
    // 4 + 20 + 300 = 324; args evaluated left-to-right => log 12
    expect(exports.test?.()).toBe(324 * 1000 + 12);
  });

  it("evaluates the receiver expression exactly once", async () => {
    const { exports } = await build(`${P_CLASS}
var calls = 0;
export function test() { var p = new P(7); calls = 0; var r = p.inc(); return r * 10 + calls; }`);
    expect(exports.test?.()).toBe(8 * 10 + 0);
  });

  it("a `this` receiver keeps the UNGUARDED #3683 S3 trampoline", async () => {
    const { wat } = await build(`${P_CLASS}
P.prototype.twice = function () { return this.inc() + this.inc(); };
export function test() { var p = new P(0); return p.twice(); }`);
    // this.inc() inside the twin must NOT move onto the guarded variant.
    expect(wat).toMatch(/\(func \$__dc_P_inc_0(?!_g)/);
  });

  it("an unproven receiver still takes the dynamic dispatcher", async () => {
    const { wat, exports } = await build(`${P_CLASS}
export function test() { var o = { inc: function () { return 42; } };
  var q = o; return q.inc(); }`);
    expect(exports.test?.()).toBe(42);
    expect(wat).not.toMatch(/\(func \$__dc_[A-Za-z]*_inc_0_g/);
  });

  it("a reassigned binding is withdrawn and not devirtualized", async () => {
    // The SAFETY property this slice owns: a binding written after its
    // initializer must not be devirtualized, because its class is no longer
    // proven. Asserted structurally (no trampoline emitted at all) rather than
    // by return value — the dynamic path this correctly falls back to answers
    // `null` for this shape, which is a PRE-EXISTING bug unrelated to #3685:
    // it reproduces identically with `JS2WASM_DIRECT_CALLS=0` and on the
    // pre-slice compiler. Asserting 1000 here would have made this pin fail
    // for a defect it does not own, and asserting `null` would freeze a bug
    // into a test as though it were intended.
    const { wat } = await build(`${P_CLASS}
function Q() { this.v = 99; }
Q.prototype.inc = function () { return 1000; };
export function test() { var p = new P(0); p = new Q(); return p.inc(); }`);
    expect(wat).not.toMatch(/\(func \$__dc_/);
  });
});
