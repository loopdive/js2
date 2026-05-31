import { describe, it, expect } from "vitest";
import { compile } from "./src/index.js";

// #1606 — Internal compiler crash on object-literal expressions parsed from a
// statically-inlined `eval("...")` body.
//
// When `eval(<constant string>)` is inlined at compile time (#1163), the
// parsed statements come from a foreign SourceFile that the TypeScript checker
// has no bindings for. Object-literal codegen then made checker calls
// (`getSignatureFromDeclaration` for get/set accessors, `getTypeAtLocation`
// for duplicate-key data literals) that crash *inside* TypeScript with
// "Cannot read properties of undefined (reading 'declarations' | 'flags' |
// 'escapedName')". The fix guards those checker calls so the literal degrades
// to a graceful diagnostic / externref fallback instead of an internal crash.
//
// This test asserts the crash no longer surfaces. We do NOT assert successful
// compilation — wiring full getter/setter accessor support through the
// eval-inline path is out of scope; the contract is "no internal compiler
// crash".

async function internalCrashErrors(src: string): Promise<string[]> {
  const result = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true });
  const msgs = (result.errors ?? []).map((e) => e.message);
  return msgs.filter(
    (m) =>
      /Internal error compiling/.test(m) ||
      /Codegen error: Cannot read properties of undefined/.test(m) ||
      /Cannot read properties of undefined \(reading '(declarations|flags|escapedName)'\)/.test(m),
  );
}

describe("#1606 — no internal crash on eval-inlined object literals", () => {
  it("get/set accessor pair in inlined eval does not crash the compiler", async () => {
    const src = `
      var s1 = "g";
      var o: any;
      eval("o = {get foo(){ return s1;},set foo(arg){ s1 = arg; }};");
    `;
    expect(await internalCrashErrors(src)).toEqual([]);
  });

  it("set-only accessor in inlined eval does not crash the compiler", async () => {
    const src = `
      var o: any;
      eval("o = {set foo(arg){}};");
    `;
    expect(await internalCrashErrors(src)).toEqual([]);
  });

  it("get-only accessor in inlined eval does not crash the compiler", async () => {
    const src = `
      var o: any;
      eval("o = {get foo(){ return 1; }};");
    `;
    expect(await internalCrashErrors(src)).toEqual([]);
  });

  it("duplicate data-property keys in inlined eval do not crash the compiler", async () => {
    const src = `
      var o: any = eval("({foo:0,foo:1});");
    `;
    expect(await internalCrashErrors(src)).toEqual([]);
  });
});
