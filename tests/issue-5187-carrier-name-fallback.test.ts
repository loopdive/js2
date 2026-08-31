// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5187 — an ad-hoc property written onto an ARRAY must read back.
//
// #5204 (`8f161cbf15`) gave `resolveStructNameForExpr` a last-resort fallback:
// when the checker cannot name a receiver's struct, answer with the name of the
// WasmGC carrier the receiver lowers to. A JS array lowers to a `__vec_<elem>`
// carrier whose only fields are `length` and `data`, so `a.foo = 7; a.foo` had
// its READ diverted onto the struct path while the WRITE stayed dynamic — the
// read came back `null`.
//
// The test262 fixture that made this visible is `__expected = ["1"];
// __expected.index = 0`, used by the whole `RegExp/prototype/exec` family.
//
// The guard is "does the carrier actually HAVE this member", not a name screen:
// `__regexp_match_vec` is a vec too and `m.index` on an exec result is a real
// field read that must keep resolving.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string, fileName: string): Promise<unknown> {
  const result = await compile(source, {
    fileName,
    allowJs: fileName.endsWith(".js"),
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  const errors = result.errors.filter((e) => e.severity !== "warning");
  expect(errors.map((e) => e.message).join("\n")).toBe("");
  expect(result.binary.length).toBeGreaterThan(0);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#5187 — ad-hoc properties on array receivers", () => {
  it("reads back a property assigned onto an array literal", async () => {
    const out = await runStandalone(
      `export function test() {
         var a = ["1"];
         a.foo = 7;
         var r = a.foo;
         return r === 7 ? 1 : r === null ? -1 : r === undefined ? -2 : -3;
       }`,
      "issue-5187-array-adhoc.js",
    );
    expect(out).toBe(1);
  });

  it("reads back the exec-fixture shape used by the RegExp/exec family", async () => {
    const out = await runStandalone(
      `export function test() {
         var expected = ["1"];
         expected.index = 0;
         expected.input = "123";
         var ok = 0;
         if (expected.index === 0) ok += 1;
         if (expected.input === "123") ok += 2;
         if (expected.length === 1) ok += 4;
         if (expected[0] === "1") ok += 8;
         return ok;
       }`,
      "issue-5187-exec-fixture.js",
    );
    expect(out).toBe(15);
  });

  it("keeps a genuine carrier field read working (exec result index/input)", async () => {
    const out = await runStandalone(
      `export function test() {
         var m = /b/.exec("abc");
         if (m === null) return -1;
         return (m.index === 1 ? 1 : 0) + (m.input === "abc" ? 2 : 0);
       }`,
      "issue-5187-exec-result.js",
    );
    expect(out).toBe(3);
  });

  it("leaves plain-object ad-hoc properties alone", async () => {
    const out = await runStandalone(
      `export function test() {
         var o = {};
         o.index = 7;
         return o.index === 7 ? 1 : 0;
       }`,
      "issue-5187-object-adhoc.js",
    );
    expect(out).toBe(1);
  });
});
