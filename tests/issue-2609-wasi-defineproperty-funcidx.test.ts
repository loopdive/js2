// #2609 — `--target wasi` hard emit error
//   "Codegen error: function index out of range — undefined ... at function
//    '__defineProperty_value'"
//   (re-allocated off the hand-picked #2588/#2602 id collisions — #2531)
//
// Reported by an external user (loopdive/js2wasm#389) compiling an esbuild-bundled
// Native Messaging host with `--target wasi --wit`. The bundle pulls in the
// native `$Object` runtime (via `process.stdin.read(buf, offset)` into a typed
// buffer, plus the esbuild interop prelude's `Object.defineProperty` getter
// descriptors).
//
// ROOT CAUSE: `ensureObjectRuntime` registers the native `__defineProperty_value`
// helper UNCONDITIONALLY, and its #2042-S4 ValidateAndApplyPropertyDescriptor
// preflight bakes a direct `call __object_is` (SameValue value-change check).
// But `__object_is` was registered under `if (ctx.standalone)` only. WASI is
// host-free too — `--target wasi` sets `ctx.wasi` but leaves `ctx.standalone`
// false — so in WASI `__object_is` was never registered, `funcMap.get(...)`
// returned `undefined`, and the define helper baked an undefined funcIdx →
// invalid wasm / hard emit error.
//
// FIX: register `__object_is` whenever the module is host-free
// (`ctx.standalone || ctx.wasi`), matching the unconditional native define
// helper that depends on it. Host mode (`!standalone && !wasi`) still owns
// `__object_is` via its JS import, so its output stays byte-identical.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

const DECL = `declare const process: {
  stdout: { write(c: Uint8Array): void };
  stderr: { write(c: string): void };
};`;

// A WASI source that pulls in the native $Object runtime the same way the
// reported esbuild bundle did: a typed-buffer `process.stdout.write` (#2633 —
// the hallucinated `process.stdin.read` loop was removed; the Uint8Array write
// alone still reaches the unconditionally-registered native
// `__defineProperty_value` block whose S4 preflight calls __object_is), so it
// reproduces the funcIdx crash without any esbuild dependency.
const FRAMED_STDIN = `${DECL}
  export function main(): void {
    const header = new Uint8Array(4);
    header[0] = 1;
    process.stdout.write(header);
  }`;

// A bundle-like source that inlines a small esbuild-style interop prelude
// (__defProp / __export with getter descriptors, the `__esModule` marker) and
// an explicit Object.defineProperty data descriptor, exercising the native
// data-descriptor define path (the SameValue / S4 preflight) directly.
const ESBUILD_PRELUDE_LIKE = `${DECL}
  const __defProp = Object.defineProperty;
  function __export(target: any, all: any): void {
    __defProp(target, "x", { value: 42, enumerable: true, configurable: false, writable: false });
  }
  export function main(): void {
    const exportsObj: any = {};
    __defProp(exportsObj, "__esModule", { value: true });
    __export(exportsObj, {});
    const out = new Uint8Array(1);
    out[0] = exportsObj.x;
    process.stdout.write(out);
  }`;

describe("#2609 WASI native defineProperty funcIdx (loopdive/js2wasm#389)", () => {
  it("compiles a framed process.stdin.read loop under --target wasi without a funcIdx emit error", async () => {
    const result = await compile(FRAMED_STDIN, { fileName: "nm.ts", target: "wasi" });
    // Before the fix this failed with a hard emit error rather than producing a
    // binary, so `success` would be false and `errors` would carry the message.
    const errMsg = result.errors?.map((e) => e.message).join("\n") ?? "";
    expect(errMsg).not.toMatch(/function index out of range/);
    expect(errMsg).not.toMatch(/__defineProperty_value/);
    expect(result.success).toBe(true);
    expect(result.binary).toBeInstanceOf(Uint8Array);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  it("compiles an esbuild-prelude-like bundle (Object.defineProperty + process) under --target wasi", async () => {
    const result = await compile(ESBUILD_PRELUDE_LIKE, { fileName: "bundle.ts", target: "wasi" });
    const errMsg = result.errors?.map((e) => e.message).join("\n") ?? "";
    expect(errMsg).not.toMatch(/function index out of range/);
    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("still compiles the same Object.defineProperty data descriptor under --target standalone", async () => {
    // Regression guard for the host-free helper set: the standalone path already
    // registered __object_is, so this must keep working (and the S4 SameValue
    // path must still execute correctly).
    const src = `export function test(): number {
      const o: any = {};
      Object.defineProperty(o, "x", { value: 42, writable: false, enumerable: true, configurable: false });
      return o.x;
    }`;
    const result = await compile(src, { fileName: "s.ts", target: "standalone" });
    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as { test: () => number }).test()).toBe(42);
  });

  it("leaves host-mode output unaffected (Object.defineProperty stays a JS import)", async () => {
    const src = `export function test(): number {
      const o: any = {};
      Object.defineProperty(o, "x", { value: 42 });
      return o.x;
    }`;
    const result = await compile(src, { fileName: "h.ts" });
    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });
});
