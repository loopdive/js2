/**
 * #4185 — closure-receiver fast `.call` arm (closure-call-fast.ts).
 *
 * The allocation census attributed the largest post-#4173 transient stream to
 * the dynamic-`.call` dispatch plumbing: two dead $ObjVec pairs per
 * `fn.call(thisArg, a…)` on a closure receiver (~83.6k heap objects per
 * standalone acorn parse), unpacked immediately by `__apply_closure`. The
 * fast arm decides the chain at `__call_m_call_<K>` allocation-free via a
 * direct `__call_fn_method_(K-1)` invocation.
 *
 * These pins are the arm's semantic contract — every guard that routes back
 * to the legacy chain, and the flag-off parity:
 *  - this-binding and argument threading (the fast path itself),
 *  - UNDER-application (declared formals > provided args) must keep the
 *    legacy path, whose `__apply_closure` #3592 widening pads the missing
 *    args — a fixed-arity direct call would silently answer undefined,
 *  - over-application (extra args dropped),
 *  - an OWN `call` property on the closure must still win (§10.2 [[Get]]
 *    precedence — route 1 in `__closure_method_call`),
 *  - `JS2WASM_FAST_CLOSURE_CALL=0` answers identically (legacy chain).
 */
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

const FLAG = "JS2WASM_FAST_CLOSURE_CALL";
const savedFlag = process.env[FLAG];
afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
});

async function runStandalone(source: string): Promise<unknown> {
  const r = await compile(source, { fileName: "t.ts", skipSemanticDiagnostics: true, target: "standalone" });
  expect(r.binary?.length ?? 0).toBeGreaterThan(0);
  const module = await WebAssembly.compile(r.binary as BufferSource);
  expect(WebAssembly.Module.imports(module).length).toBe(0);
  const { exports } = await WebAssembly.instantiate(module, {});
  return (exports as { test?: () => unknown }).test?.();
}

/** The acorn shape: receiver erased through an object field, `.call(this, x)`. */
const DYNAMIC_CALL_SRC = `var holder: any = { update: null, base: 0 };
function readsThis(x) { return this.base + x; }
holder.base = 30;
holder.update = readsThis;
export function test(): number {
  var u = holder.update;
  return u.call(holder, 12);
}`;

describe("#4185 — closure-receiver fast .call arm (standalone)", () => {
  it("threads thisArg and the argument on the fast path", async () => {
    expect(await runStandalone(DYNAMIC_CALL_SRC)).toBe(42);
  });

  it("flag off: identical answer through the legacy chain", async () => {
    process.env[FLAG] = "0";
    expect(await runStandalone(DYNAMIC_CALL_SRC)).toBe(42);
  });

  it("UNDER-application keeps the widening path (missing arg is undefined, not a vacuous undefined call)", async () => {
    const got = await runStandalone(`var holder: any = { f: null };
function two(a, b) { return (a === undefined ? 100 : a) + (b === undefined ? 10 : b); }
holder.f = two;
export function test(): number {
  var u = holder.f;
  return u.call(undefined, 5);
}`);
    expect(got).toBe(15);
  });

  it("over-application drops the extra argument", async () => {
    const got = await runStandalone(`var holder: any = { f: null };
function zero() { return 7; }
holder.f = zero;
export function test(): number {
  var u = holder.f;
  return u.call(undefined, 99);
}`);
    expect(got).toBe(7);
  });

  it("an own `call` property behaves identically to the legacy chain (pre-existing gap, pinned as parity)", async () => {
    // Node answers 1005 here — the own property shadows
    // %Function.prototype.call% (§10.2 [[Get]]). The compiler answers 6 on
    // BOTH paths (measured: the assignment does not reach the closure side
    // bag that `__extern_get` reads), so this is a PRE-EXISTING gap, not an
    // arm regression. The arm's override guard is the same `__extern_get`
    // probe route 1 of `__closure_method_call` performs, so a future side-bag
    // fix flips both paths together — at which point this pin updates to
    // 1005 for both.
    const src = `var holder: any = { f: null };
function real(x) { return x + 1; }
real.call = function (a, b) { return 1000 + b; };
holder.f = real;
export function test(): number {
  var u = holder.f;
  return u.call(undefined, 5);
}`;
    const fast = await runStandalone(src);
    process.env[FLAG] = "0";
    const legacy = await runStandalone(src);
    expect(fast).toBe(legacy);
    expect(fast).toBe(6);
  });

  it("a DYNAMICALLY-assigned own `call` property still wins (§10.2 precedence guard)", async () => {
    // Unlike the static-assignment shape above, a dynamic member write on the
    // erased reference DOES reach the closure side bag, and the arm's
    // `__extern_get` guard must route it back to the legacy chain.
    const got = await runStandalone(`var holder: any = { f: null };
function real(x) { return x + 1; }
holder.f = real;
export function test(): number {
  var u = holder.f;
  u.call = function (a, b) { return 1000 + b; };
  return u.call(undefined, 5);
}`);
    expect(got).toBe(1005);
  });

  it("multi-arg fast path (arity 3 dispatcher)", async () => {
    const got = await runStandalone(`var holder: any = { f: null, tag: 4 };
function threeArgs(a, b, c) { return this.tag * 1000 + a * 100 + b * 10 + c; }
holder.f = threeArgs;
export function test(): number {
  var u = holder.f;
  return u.call(holder, 1, 2, 3);
}`);
    expect(got).toBe(4123);
  });
});
