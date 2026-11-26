// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4517 — the recognised char-read loop (#3931 / #2682) kept an f64 loop
// CONDITION: `i < recv.length` lowered generically as
// `f64.lt(f64.convert_i32_s(i), f64.convert_i32_s(len))`, so every iteration of
// a ~10-instruction loop paid two int→float converts plus a float compare, and
// the `.length` struct read was never hoisted.
//
// V8 folds all of that away, so the cost was invisible on every locally
// runnable lane; Cranelift does no LICM and no strength reduction, so wasmtime
// executed it literally — measured as a 5.4x regression (238 → ~1,260 µs) on
// the landing `String build + hash` warm lane on x64 after #4557 landed.
//
// The fix hoists `recv.length` into a preheader i32 slot next to the flatten
// the recogniser already hoists, and emits the condition as `i32.lt_s`. What is
// asserted here:
//
//   (a) the emitted shape — a `__cca_len` preheader slot, an `i32.lt_s` test,
//       and NO `f64.lt` anywhere in the function (the loop test was the only
//       float compare it had);
//   (b) results stay byte-faithful, including the receivers where the compare
//       boundary matters (empty string, single char, long string);
//   (c) the default lane hashes byte-faithfully. It used to assert that
//       host-string mode kept the generic condition; since #6708 S6
//       (612cea9864) the default JS environment runs on native strings, so
//       that lane no longer exists and the default lane takes the native fix.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";
import { jsFacingExports } from "./helpers/compile.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

const HASH_SRC = `
  export function hashStr(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }
`;

function refHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** The WAT of one named function (the recogniser only ever touches one fn). */
async function watOf(source: string, fnName: string, opts: Record<string, unknown> = {}): Promise<string> {
  const r = await compile(source, { emitWat: true, fileName: "issue-4517-wat.ts", ...opts });
  if (!r.success) {
    const errors = Array.isArray(r.errors) ? r.errors.map((err) => err.message).join("; ") : "no errors array";
    throw new Error(`compile failed: ${errors}`);
  }
  const lines = (r.wat ?? "").split("\n");
  const out: string[] = [];
  let cap = false;
  for (const l of lines) {
    if (l.includes(`(func $${fnName} `)) cap = true;
    if (cap) {
      out.push(l);
      if (out.length > 1 && /^\s*\(func /.test(l) && !l.includes(`$${fnName} `)) {
        out.pop();
        break;
      }
    }
  }
  return out.join("\n");
}

const NATIVE_CONFIGURATIONS: Array<{ tag: string; opts: Record<string, unknown> }> = [
  { tag: "fast+nativeStrings", opts: { fast: true, nativeStrings: true } },
  { tag: "nativeStrings", opts: { nativeStrings: true } },
  { tag: "standalone", opts: { target: "standalone" } },
  { tag: "wasi", opts: { target: "wasi" } },
];

describe("#4517 the recognised char-read loop tests its bound in i32", () => {
  for (const config of NATIVE_CONFIGURATIONS) {
    it(`${config.tag}: the condition is an i32 compare against a hoisted length`, async () => {
      const wat = await watOf(HASH_SRC, "hashStr", config.opts);
      // Precondition: this is still the recognised loop (#3931's hoist fired).
      expect(wat).toContain("$$slot___cca_flat");
      // The length is parked in a preheader slot alongside the flatten …
      expect(wat).toContain("$$slot___cca_len");
      // … and the loop test is a native i32 compare.
      expect(wat).toContain("i32.lt_s");
      // The loop test was this function's ONLY float compare, so its absence is
      // the structural proof that the per-iteration f64 round-trip is gone.
      // (This is what the x64 runner pays and V8 optimizes away — it cannot be
      // observed by running the artifact on this box.)
      expect(wat).not.toContain("f64.lt");
    });
  }

  // Was "host mode keeps the generic condition": with no options the default
  // JS environment now runs on native strings (#6708 S6, 612cea9864), so its
  // shape is the nativeStrings lane above. What it adds is the default lane's
  // runtime result across the compare boundary.
  it("the default lane (no options) hashes byte-faithfully across the compare boundary", async () => {
    const r = await compile(HASH_SRC, { testRuntime: true, fileName: "issue-4517-default.ts" });
    expect(r.success).toBe(true);
    const built = buildImports(r.imports, ENV_STUB, r.stringPool);
    const { instance } = await instantiateWasm(r.binary, built.env, built.string_constants);
    built.setExports?.(instance.exports as Record<string, Function>);
    const hashStr = jsFacingExports(r, instance).hashStr as (s: string) => number;
    for (const s of ["", "a", "ab", "z".repeat(300)]) expect(hashStr(s)).toBe(refHash(s));
  });

  it("hash results stay byte-faithful across the compare boundary", async () => {
    const subjects = [
      "", // len 0 — the loop must not execute once
      "a", // len 1 — the compare's only true iteration
      "ab",
      "hello world",
      "héllo ☃ unicode",
      "￿￾�", // high code units — the read is unsigned
      "z".repeat(300),
    ];
    for (const opts of [{ fast: true }, {}] as Array<Record<string, unknown>>) {
      const r = await compile(HASH_SRC, {
        nativeStrings: true,
        testRuntime: true,
        fileName: "issue-4517.ts",
        ...opts,
      });
      if (!r.success) {
        const errors = Array.isArray(r.errors) ? r.errors.map((err) => err.message).join("; ") : "no errors array";
        throw new Error(`compile failed: ${errors}`);
      }
      const built = buildImports(r.imports, ENV_STUB, r.stringPool);
      const { instance } = await instantiateWasm(r.binary, built.env, built.string_constants);
      built.setExports?.(instance.exports as Record<string, Function>);
      // Strings cross through the JS value adapter (#6708); the test-only
      // `__test_str_from_externref` export needs `wasm:js-string` imports,
      // which the native JS environment no longer requests (#6979).
      const hashStr = jsFacingExports(r, instance).hashStr as (s: string) => number;
      for (const s of subjects) expect(hashStr(s)).toBe(refHash(s));
    }
  });

  it("a substring view (non-zero `.off`) still reads the right code units", async () => {
    // The hoisted length must be the VIEW's length, not the backing string's.
    const src = `
      export function hashTail(s: string, from: number): number {
        const v = s.substring(from);
        let h = 0;
        for (let i = 0; i < v.length; i++) h = (h * 31 + v.charCodeAt(i)) | 0;
        return h;
      }
    `;
    const r = await compile(src, { nativeStrings: true, testRuntime: true, fileName: "issue-4517-sub.ts" });
    expect(r.success).toBe(true);
    const built = buildImports(r.imports, ENV_STUB, r.stringPool);
    const { instance } = await instantiateWasm(r.binary, built.env, built.string_constants);
    built.setExports?.(instance.exports as Record<string, Function>);
    const hashTail = jsFacingExports(r, instance).hashTail as (s: string, from: number) => number;
    const subject = "The quick brown fox 0123456789!";
    for (const from of [0, 1, 7, subject.length - 1, subject.length]) {
      expect(hashTail(subject, from)).toBe(refHash(subject.substring(from)));
    }
  });
});
