// (#3087) A USER-DEFINED `__`-prefixed function referenced as a VALUE must
// compile to its closure wrapper, not the graceful null default. The old
// internal-helper name filter in compileIdentifier (`!name.startsWith("__")`)
// silently compiled `var f: any = __foo` to `ref.null.extern`, so the dynamic
// dispatch of `f(x)` matched no candidate and DROPPED the call. This was the
// dominant honest-fail of the test262 TypedArray harness cluster: the runner
// shim passes `__ta_makeCtorArgPassthrough` positionally into every callback,
// so `makeCtorArg(...)` returned null and `new TA(null)` built a length-0 view.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runBoth(src: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const target of ["gc", "standalone"] as const) {
    const r = await compile(src, { fileName: "test.ts", ...(target === "standalone" ? { target } : {}) });
    if (!r.success) {
      out[target] = "CE:" + (r.errors?.map((e) => e.message).join("; ") ?? "");
      continue;
    }
    const impObj = (r as { importObject?: WebAssembly.Imports }).importObject ?? {};
    const { instance } = await WebAssembly.instantiate(r.binary!, impObj);
    (impObj as { __setExports?: (e: unknown) => void }).__setExports?.(instance.exports);
    out[target] = (instance.exports as { test?: () => unknown }).test?.();
  }
  return out;
}

describe("#3087 __-prefixed user function as a value", () => {
  it("dynamic call of a __-named module function value invokes with intact args/return", async () => {
    const src = `
let invoked: number = 0;
function __ta_pass(x: any): any { invoked = 1; return x; }
export function test(): number {
  var f: any = __ta_pass;
  var arg = f([5, 6, 7]);
  // invoked proves the body ran; arg.length proves the arg + return survived.
  return invoked * 1000 + (arg.length as number); // want 1003
}`;
    const res = await runBoth(src);
    expect(res.gc).toBe(1003);
    expect(res.standalone).toBe(1003);
  });

  it("__-named function passed positionally through a HOF dispatches when called (harness shape)", async () => {
    const src = `
function __mk_pass(x: any): any { return x; }
function harness(fn: any): void {
  const vals = [Int8Array];
  for (let i = 0; i < vals.length; i++) { fn(vals[i], __mk_pass); }
}
let out: number = -1;
export function test(): number {
  harness(function (TA: any, makeCtorArg: any) {
    var arg = makeCtorArg([0, 0, 0]);
    out = arg === null ? -2 : (arg.length as number);
  });
  return out; // want 3
}`;
    const r = await compile(src, { fileName: "test.ts" });
    expect(r.success, r.errors?.[0]?.message).toBe(true);
    const impObj = (r as { importObject?: WebAssembly.Imports }).importObject ?? {};
    const { instance } = await WebAssembly.instantiate(r.binary!, impObj);
    (impObj as { __setExports?: (e: unknown) => void }).__setExports?.(instance.exports);
    expect((instance.exports as { test?: () => unknown }).test?.()).toBe(3);
  });

  it("end-to-end TypedArray harness chain: new TA(makeCtorArg([0,0,0])).fill(8,0,1) (gc lane)", async () => {
    // Mirrors fill-values-relative-end.js — the representative of the
    // converted cluster. Requires: __-named fn value (this fix), HOF-callback
    // dispatch (#3074), dynamic new on an any ctor + bare-TA-ctor value
    // (PR #2800), and dynamic method calls on the host TA result.
    const src = `
function __ta_pass(x: any): any { return x; }
function compareArray(a: any[], b: any[]): number {
  if (a.length !== b.length) return 0;
  for (let i: number = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return 0;
  }
  return 1;
}
function testWithTypedArrayConstructors(fn: any): void {
  const constructors = [Int8Array, Uint8Array];
  for (let i = 0; i < constructors.length; i++) {
    fn(constructors[i], __ta_pass);
  }
}
let ok: number = 0;
export function test(): number {
  testWithTypedArrayConstructors(function (TA: any, makeCtorArg: any) {
    var filled = new TA(makeCtorArg([0, 0, 0])).fill(8, 0, 1);
    if (compareArray(filled, [8, 0, 0])) { ok = ok + 1; }
  });
  return ok; // want 2 (both ctors)
}`;
    const r = await compile(src, { fileName: "test.ts" });
    expect(r.success, r.errors?.[0]?.message).toBe(true);
    const impObj = (r as { importObject?: WebAssembly.Imports }).importObject ?? {};
    const { instance } = await WebAssembly.instantiate(r.binary!, impObj);
    (impObj as { __setExports?: (e: unknown) => void }).__setExports?.(instance.exports);
    expect((instance.exports as { test?: () => unknown }).test?.()).toBe(2);
  });

  it("non-__ function values keep working (control)", async () => {
    const src = `
let invoked: number = 0;
function taPass(x: any): any { invoked = 1; return x; }
export function test(): number {
  var f: any = taPass;
  var arg = f([5, 6, 7]);
  return invoked * 1000 + (arg.length as number); // want 1003
}`;
    const res = await runBoth(src);
    expect(res.gc).toBe(1003);
    expect(res.standalone).toBe(1003);
  });
});
