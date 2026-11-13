// #6958 — call-site parameter inference narrowed a parameter to a user object
// struct (`$__fnctor_F` / a class struct) from the argument types at its call
// sites, but the parameter's runtime domain was wider: the body reassigned it
// (`if (p === undefined) p = OUT;`, Octane earley-boyer's `sc_display`), or the
// fnctor also has a native `$Object` representation (#2660 S3a reconstruction of
// a top-level `var OUT = new Port()`). The guarded externref→struct cast at the
// boundary then produced a silent null and `p.append(...)` threw "Cannot read
// properties of undefined". Expected values are node's.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string, watFns?: string[]): Promise<{ value: unknown; wat?: string }> {
  const result = await compile(src, {
    fileName: "issue-6958.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    ...(watFns ? { emitWatOnlyFunctions: watFns } : {}),
  });
  expect(result.success, (result.errors ?? []).map((e) => String(e.message)).join("; ")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const value = (instance.exports as { main: () => unknown }).main();
  return { value, wat: result.wat };
}

const PROTO_AB = `
function A() { this.a = 1; }
A.prototype.append = function (s) { return s.length; };
function B() { this.b = 2; }
B.prototype.append = function (s) { return s.length * 10; };
var OUT = new A();
`;

describe("#6958 struct-typed param inference respects the param's real runtime domain (standalone)", () => {
  it("body reassigns the param with another fnctor's instance (earley-boyer sc_display shape)", async () => {
    const src = `${PROTO_AB}
function keep(x) { return x; }
keep(OUT);
function display(o, p) { if (p === undefined) p = OUT; return p.append(o); }
function fmt() { var p = new B(); return display("xy", p); }
/** @returns {number} */
export function main() { return fmt() + display("xyz"); }`;
    expect((await runStandalone(src)).value).toBe(23);
  });

  it("body reassigns a class-typed param with another class's instance", async () => {
    const src = `
class C { constructor() { this.x = 1; } m() { return this.x; } }
class D { constructor() { this.y = 2; } m() { return 20; } }
var OUT = new C();
function f(p) { if (p === undefined) p = OUT; return p.m(); }
/** @returns {number} */
export function main() { return f(new D()) + f(); }`;
    expect((await runStandalone(src)).value).toBe(21);
  });

  it("a destructuring write to the param also counts as a write", async () => {
    const src = `${PROTO_AB}
function keep(x) { return x; }
keep(OUT);
function display(o, p) { if (p === undefined) [p] = [OUT]; return p.append(o); }
/** @returns {number} */
export function main() { return display("xy", new B()) + display("xyz"); }`;
    expect((await runStandalone(src)).value).toBe(23);
  });

  it("an empty-body fnctor reconstructed as $Object at a top-level var reaches a param", async () => {
    const src = `
function Port() {}
Port.prototype.append = function (s) { return s.length; };
var OUT = new Port();
function viaParam(p) { return p.append("abcd"); }
/** @returns {number} */
export function main() { return viaParam(OUT); }`;
    expect((await runStandalone(src)).value).toBe(4);
  });

  it("under-applied call next to a reconstructed-instance argument", async () => {
    const src = `
function Port() {}
Port.prototype.append = function (s) { return String(s).length; };
var OUT = new Port();
function display(o, p) { if (p === undefined) p = OUT; p.append(o); }
/** @returns {number} */
export function main() { display("a", OUT); display("x"); return 1; }`;
    expect((await runStandalone(src)).value).toBe(1);
  });

  // ── controls: unchanged behaviour ────────────────────────────────────────
  it("control: instance built inside main and passed to an untyped param", async () => {
    const src = `
function Port() {}
Port.prototype.append = function (s) { return s.length; };
function viaParam(p) { return p.append("abcd"); }
/** @returns {number} */
export function main() { var o = new Port(); return viaParam(o); }`;
    expect((await runStandalone(src)).value).toBe(4);
  });

  it("control: non-empty ctor body at a top-level var (no $Object reconstruction)", async () => {
    const src = `
function Port() { this.pad = 0; }
Port.prototype.append = function (s) { return s.length; };
var OUT = new Port();
function viaParam(p) { return p.append("abcd"); }
/** @returns {number} */
export function main() { return viaParam(OUT); }`;
    expect((await runStandalone(src)).value).toBe(4);
  });

  it("control: a missing trailing externref argument is undefined, not null", async () => {
    const src = `
var OUT = { k: 1 };
function probe(o, p) { return (p === undefined ? 1 : 0) + (p === null ? 10 : 0) + (typeof p === "undefined" ? 100 : 0) + (p == null ? 1000 : 0); }
/** @returns {number} */
export function main() { return probe("a", OUT) * 10000 + probe("x"); }`;
    expect((await runStandalone(src)).value).toBe(1101);
  });

  it("control: a struct-typed param with no body write keeps its struct signature", async () => {
    const src = `
function P() { this.v = 3; }
function get(p) { return p.v; }
/** @returns {number} */
export function main() { return get(new P()) + get(new P()); }`;
    const { value, wat } = await runStandalone(src, ["get"]);
    expect(value).toBe(6);
    expect(wat).toMatch(/\(func \$get \(param \(ref null \d+\)\)/);
  });
});
