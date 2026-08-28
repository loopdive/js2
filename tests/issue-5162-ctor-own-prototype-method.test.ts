// #5162 — a constructor that calls its OWN prototype method.
//
//   function PP(x) { this.v = this.twice(x); }
//   PP.prototype.twice = function (x) { return x + x; };
//   new PP(5).v                                   // spec: 10
//
// The filed hypothesis was COMPILE ORDER — that the prototype assignment had
// not been processed when the constructor body compiled, so method-call
// lowering resolved against an incomplete prototype view (the compile-order
// sibling of #5096's scope-blind `ctx.classSet`). **The matrix below refutes
// it.** Source order does not matter, `.mjs` vs `.ts` does not matter, and
// `new PP(5).v` behaves exactly like the two-step `var p = new PP(5); p.v`.
//
// The two axes that DO matter are LANE and SYNTAX:
//
//   | shape                                   | gc | standalone |
//   | --------------------------------------- | -- | ---------- |
//   | `Ctor.prototype.m = fn`, m after ctor    | 10 | THROWS     |
//   | `Ctor.prototype.m = fn`, m before ctor   | 10 | THROWS     |
//   | `var pp = Ctor.prototype; pp.m = fn`     | 10 | THROWS     |
//   | `class PP { constructor(){…} m(){…} }`   | 10 | 10         |
//   | ctor that does NOT call an own method    | 10 | 10         |
//   | the same call from another proto method  | 10 | 10         |
//
// Root cause (structural, NOT ordering). In STANDALONE a `$__fnctor_F`
// instance is a CLOSED WasmGC struct: `deriveFnctorFields` fixes the field
// list and the expando sidecar that would let a property appear at runtime is
// host-mode-only (`fnctor-escape-gate.ts`). Prototype methods therefore have
// no runtime existence at all — they resolve only through the compile-time
// table keyed by the receiver's STATIC shape. `resolveTypedThisField`
// (`src/codegen/typed-this.ts`) declines for "a function that has no typed
// twin — **a constructor**, or a method with no write-once verdict"
// (`not-in-twin`, #4405 Phase 0's largest census bucket), so `this.m()` in a
// constructor falls through to the dynamic `__call_m_*` /
// `__extern_method_call` path — which in standalone has nothing to find and
// throws `called value is not a function`.
//
// That makes the decline note above `resolveTypedThisField` wrong for this one
// population: it says a decline's "failure mode is only ever 'miss a
// devirtualization'", which holds in gc (the host sidecar still answers) but is
// a HARD RUNTIME FAILURE in standalone.
//
// The decisive evidence is the identity pair in "the gap is static, not
// dynamic" below: the SAME runtime object resolves `twice` through a
// statically-typed variable and fails through an untyped one.
//
// Owner: the `not-in-twin` decline path belongs to #4405 (receiver-type
// specialisation), claimed by `ttraenkler/senior-dev` on
// `impl-4405-receiver-spec`. Not fixed here by dispatch constraint.
//
// WHAT THESE TESTS ARE. The gc cases are ordinary correctness pins. The
// standalone cases are **xfail-style pins of the current gap**: they assert
// that it still throws, so whoever closes the gap sees them go red and
// tightens them to `10` rather than silently leaving the shape unverified.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

type Lane = "gc" | "standalone";

async function run(src: string, lane: Lane): Promise<unknown> {
  const opts: Record<string, unknown> = { fileName: "probe.mjs", skipSemanticDiagnostics: true };
  if (lane === "standalone") opts.target = "standalone";
  const result = (await compile(src, opts as never)) as {
    success?: boolean;
    binary: Uint8Array;
    errors?: Array<{ message: string }>;
    importObject?: Record<string, unknown> & { __setExports?: (e: unknown) => void };
    exportSignatures?: unknown;
  };
  expect(result.success, (result.errors ?? []).map((e) => e.message).join("\n")).not.toBe(false);
  const importObject = (result.importObject ?? {}) as Record<string, unknown> & {
    __setExports?: (e: unknown) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary, importObject as never);
  importObject.__setExports?.(instance.exports);
  const wrapped = wrapExports(instance.exports, { signatures: result.exportSignatures } as never) as {
    test: () => unknown;
  };
  return wrapped.test();
}

/** Did `src` throw in `lane`? The thrown value is a null-prototype wasm payload. */
async function threw(src: string, lane: Lane): Promise<boolean> {
  try {
    await run(src, lane);
    return false;
  } catch {
    return true;
  }
}

const PROTO_TWICE = `PP.prototype.twice = function (x) { return x + x; };`;

/** The filed shape, with the prototype method assigned AFTER the constructor. */
const AFTER = `function PP(x) { this.v = this.twice(x); }
${PROTO_TWICE}
export function test() { return new PP(5).v; }`;

/** …and BEFORE it, which hoisting makes legal and which the matrix proves equivalent. */
const BEFORE = `${PROTO_TWICE}
function PP(x) { this.v = this.twice(x); }
export function test() { return new PP(5).v; }`;

/** The write-once fnctor idiom `var pp = PP.prototype` — acorn's own spelling. */
const FNCTOR = `function PP(x) { this.v = this.twice(x); }
var pp = PP.prototype;
pp.twice = function (x) { return x + x; };
export function test() { return new PP(5).v; }`;

/** Two-step construction, to show `new PP(5).v` is not a member-chain artifact. */
const TWO_STEP = `function PP(x) { this.v = this.twice(x); }
${PROTO_TWICE}
export function test() { var p = new PP(5); return p.v; }`;

const CLASS_SYNTAX = `class PP { constructor(x) { this.v = this.twice(x); } twice(x) { return x + x; } }
export function test() { return new PP(5).v; }`;

const NO_SELF_CALL = `function PP(x) { this.v = x + x; }
${PROTO_TWICE}
export function test() { return new PP(5).v; }`;

const CALL_FROM_METHOD = `function PP(x) { this.n = x; }
${PROTO_TWICE}
PP.prototype.quad = function () { return this.twice(this.n) + this.twice(this.n); };
export function test() { return new PP(5).quad(); }`;

const CALL_FROM_OUTSIDE = `function PP(x) { this.v = x; }
${PROTO_TWICE}
export function test() { var p = new PP(5); return p.twice(p.v); }`;

describe("#5162 constructor → own prototype method", () => {
  // ---------------------------------------------------------------- gc lane
  // These are real correctness pins: the shape works today and must keep working.
  it.each([
    ["method assigned AFTER the constructor (the filed shape)", AFTER],
    ["method assigned BEFORE the constructor", BEFORE],
    ["the write-once `var pp = PP.prototype` idiom", FNCTOR],
    ["two-step `var p = new PP(5); p.v`", TWO_STEP],
    ["class syntax", CLASS_SYNTAX],
  ])("gc: %s returns 10", async (_name, src) => {
    expect(await run(src, "gc")).toBe(10);
  });

  // -------------------------------------------------------- standalone lane
  // Shapes that already work in standalone — these guard the diagnosis itself.
  // If one of them ever starts throwing, the gap is WIDER than this issue says.
  it.each([
    ["class syntax", CLASS_SYNTAX, 10],
    ["a constructor that calls no own prototype method", NO_SELF_CALL, 10],
    ["the same call from another prototype method", CALL_FROM_METHOD, 20],
    ["the same call from outside any method", CALL_FROM_OUTSIDE, 10],
  ])("standalone: %s returns its spec value", async (_name, src, expected) => {
    expect(await run(src, "standalone")).toBe(expected);
  });

  // XFAIL PINS. Each of these SHOULD return 10. They throw today. When the
  // `not-in-twin` decline stops being a hard failure in standalone (#4405 or a
  // successor), these go red — tighten them to `.toBe(10)` rather than deleting.
  it.each([
    ["method assigned AFTER the constructor (the filed shape)", AFTER],
    ["method assigned BEFORE the constructor", BEFORE],
    ["the write-once `var pp = PP.prototype` idiom", FNCTOR],
    ["two-step `var p = new PP(5); p.v`", TWO_STEP],
  ])("standalone XFAIL: %s still throws (spec says 10)", async (_name, src) => {
    expect(await threw(src, "standalone")).toBe(true);
  });

  // Source order is NOT the discriminator — the filed hypothesis, refuted.
  // Both orders behave identically in BOTH lanes, so ordering cannot explain a
  // failure that only one lane has.
  it("source order does not change the outcome in either lane", async () => {
    expect(await run(AFTER, "gc")).toBe(await run(BEFORE, "gc"));
    expect(await threw(AFTER, "standalone")).toBe(await threw(BEFORE, "standalone"));
  });

  // The gap is STATIC, not dynamic — the decisive pair.
  //
  // One program, one runtime object: the constructor stores `this` into a
  // module-level `seen`, and `test` also holds it as `p`. `p` is statically the
  // fnctor shape, so `p.twice` devirtualizes and answers. `seen` is untyped, so
  // the same property on the SAME object falls to the dynamic path — which in
  // standalone finds nothing. A runtime prototype would answer both.
  const IDENTITY = `var seen = null;
function PP(x) { seen = this; this.v = 1; }
${PROTO_TWICE}
export function test() { var p = new PP(5); return (p === seen) ? 1 : 0; }`;
  const VIA_TYPED = `var seen = null;
function PP(x) { seen = this; this.v = 1; }
${PROTO_TWICE}
export function test() { var p = new PP(5); return (typeof p.twice === "function") ? 1 : 0; }`;
  const VIA_UNTYPED = `var seen = null;
function PP(x) { seen = this; this.v = 1; }
${PROTO_TWICE}
export function test() { var p = new PP(5); return (typeof seen.twice === "function") ? 1 : 0; }`;

  it("standalone: the ctor's `this` IS the constructed object", async () => {
    expect(await run(IDENTITY, "standalone")).toBe(1);
    expect(await run(IDENTITY, "gc")).toBe(1);
  });

  it("gc: one object resolves `twice` through either binding", async () => {
    expect(await run(VIA_TYPED, "gc")).toBe(1);
    expect(await run(VIA_UNTYPED, "gc")).toBe(1);
  });

  it("standalone XFAIL: the same object resolves `twice` only through the TYPED binding", async () => {
    expect(await run(VIA_TYPED, "standalone")).toBe(1);
    // Spec says 1 — `seen` and `p` are the same object. Reads 0 because the
    // prototype method has no runtime existence in standalone.
    expect(await run(VIA_UNTYPED, "standalone")).toBe(0);
  });

  // A second, INDEPENDENT hole found while measuring, recorded so it is not
  // re-discovered as this one: the explicit-receiver spelling
  // `this.twice.call(this, x)` fails in the gc lane too, where the plain
  // `this.twice(x)` call succeeds. Different lane, different mechanism (a null
  // receiver read, not a missing prototype), so it is NOT covered by the fix
  // that closes the standalone gap above.
  const DOT_CALL = `function PP(x) { this.v = this.twice.call(this, x); }
${PROTO_TWICE}
export function test() { return new PP(5).v; }`;

  it("XFAIL both lanes: `this.twice.call(this, x)` in a ctor throws (spec says 10)", async () => {
    expect(await threw(DOT_CALL, "gc")).toBe(true);
    expect(await threw(DOT_CALL, "standalone")).toBe(true);
  });
});
