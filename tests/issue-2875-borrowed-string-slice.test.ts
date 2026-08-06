// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2875 slice C — borrowed `String.prototype.slice` on a non-string receiver.
//
// `emitStringProtoMemberBody` wired `substring` to a real reflective body but
// left `slice` to fall through to `emitProtoMemberBodyRefusal`, so
// `x.slice = String.prototype.slice; x.slice(0, 1)` threw
// "String.prototype.slice is not yet implemented in --target standalone".
//
// The two differ only in §22.1.3.22-vs-§22.1.3.24 index resolution (slice
// resolves negative indices; substring swaps reversed bounds), and that
// difference lives entirely inside the native helper: `__str_slice` and
// `__str_substring` share the signature
// `(ref $NativeString, i32 start, i32 end) -> ref $NativeString` and the same
// `0x7fffffff` absent-end sentinel. So `slice` reuses the substring body with
// the helper swapped.
//
// Compile through the SAME lane the test262 standalone runner uses — literal
// JavaScript with `allowJs`. A `.ts` probe does NOT reproduce this: an
// annotated receiver takes a different, statically-typed member-call route.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, {
    target: "standalone",
    allowJs: true,
    fileName: "test.js",
    skipSemanticDiagnostics: true,
  });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  expect(r.imports ?? []).toEqual([]); // host-free
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2875 slice C — borrowed String.prototype.slice (standalone)", () => {
  // The exact shape of test262 built-ins/String/prototype/slice/S15.5.4.13_A1_T1.
  it("new Object(true).slice(false, true) === 't'", async () => {
    expect(
      await runStandalone(
        `export function test() {
           var x = new Object(true);
           x.slice = String.prototype.slice;
           return x.slice(false, true) === "t" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("value-erased .call('abcde', 1, 3) === 'bc'", async () => {
    expect(
      await runStandalone(
        `export function test() {
           var f = String.prototype.slice;
           return f.call("abcde", 1, 3) === "bc" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  // The behaviour that makes slice NOT substring: a negative index counts back
  // from the end instead of clamping to 0. If this passed while the previous
  // case also passed, the helper swap would be unproven.
  it("negative indices resolve from the end — .call('abcde', -3, -1) === 'cd'", async () => {
    expect(
      await runStandalone(
        `export function test() {
           var f = String.prototype.slice;
           return f.call("abcde", -3, -1) === "cd" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  // Reversed bounds must yield "" (slice), NOT the swapped substring result.
  it("reversed bounds give '' rather than substring's swap", async () => {
    expect(
      await runStandalone(
        `export function test() {
           var f = String.prototype.slice;
           return f.call("abcde", 3, 1) === "" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("absent end runs to the end — .call('abcde', 2) === 'cde'", async () => {
    expect(
      await runStandalone(
        `export function test() {
           var f = String.prototype.slice;
           return f.call("abcde", 2) === "cde" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("RequireObjectCoercible: .call(null) throws a catchable TypeError", async () => {
    expect(
      await runStandalone(
        `export function test() {
           try { String.prototype.slice.call(null, 0, 1); return 0; }
           catch (e) { return (e instanceof TypeError) ? 1 : 2; }
         }`,
      ),
    ).toBe(1);
  });

  // Guard the sibling: routing slice through the shared body must not change
  // substring's swap behaviour.
  it("substring is unaffected — .call('abcde', 3, 1) still swaps to 'bc'", async () => {
    expect(
      await runStandalone(
        `export function test() {
           var f = String.prototype.substring;
           return f.call("abcde", 3, 1) === "bc" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });
});
