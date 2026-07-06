import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

// #3069 — pure-Wasm Annex B §B.2.2 HTML string-wrapper methods
// (`String.prototype.{anchor, big, blink, bold, fixed, fontcolor, fontsize,
// italics, link, small, strike, sub, sup}`) for the standalone / WASI
// (no-JS-host) lane. In JS-host mode these dispatch through
// `__extern_method_call`; under `--target standalone`/`wasi` there is no host,
// so the call site fell through and returned the wrong string / null-derefed.
// This completes the dual-mode pair with a WasmGC-native lowering (the
// CreateHTML §B.2.2.2.1 concatenation, incl. the step-4.b `"`→`&quot;` value
// escaping). We verify each transform in-Wasm (string `===` on the native
// result, returned as a 1/0 number) with an EMPTY imports object, so no host
// string-marshalling is involved.

async function eq(call: string, expected: string): Promise<number> {
  const src = `export function test(): number { return (${call}) === (${expected}) ? 1 : 0; }`;
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  // No imports object — a genuine standalone module must instantiate host-free.
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#3069 standalone HTML string-wrapper methods (§B.2.2)", () => {
  it("wraps the no-argument tags", async () => {
    expect(await eq(`"foo".big()`, `"<big>foo</big>"`)).toBe(1);
    expect(await eq(`"foo".blink()`, `"<blink>foo</blink>"`)).toBe(1);
    expect(await eq(`"foo".bold()`, `"<b>foo</b>"`)).toBe(1);
    expect(await eq(`"foo".fixed()`, `"<tt>foo</tt>"`)).toBe(1);
    expect(await eq(`"foo".italics()`, `"<i>foo</i>"`)).toBe(1);
    expect(await eq(`"foo".small()`, `"<small>foo</small>"`)).toBe(1);
    expect(await eq(`"foo".strike()`, `"<strike>foo</strike>"`)).toBe(1);
    expect(await eq(`"foo".sub()`, `"<sub>foo</sub>"`)).toBe(1);
    expect(await eq(`"foo".sup()`, `"<sup>foo</sup>"`)).toBe(1);
  });

  it("wraps the attribute tags (anchor/fontcolor/fontsize/link)", async () => {
    expect(await eq(`"foo".anchor("bar")`, `'<a name="bar">foo</a>'`)).toBe(1);
    expect(await eq(`"foo".fontcolor("red")`, `'<font color="red">foo</font>'`)).toBe(1);
    expect(await eq(`"foo".link("u")`, `'<a href="u">foo</a>'`)).toBe(1);
  });

  it("coerces the fontsize argument via ToString (number → string)", async () => {
    expect(await eq(`"foo".fontsize(3)`, `'<font size="3">foo</font>'`)).toBe(1);
    expect(await eq(`"foo".fontsize("4")`, `'<font size="4">foo</font>'`)).toBe(1);
  });

  it("escapes each '\"' in the attribute value to &quot; (CreateHTML step 4.b)", async () => {
    expect(await eq(`"foo".anchor('a"b"c')`, `'<a name="a&quot;b&quot;c">foo</a>'`)).toBe(1);
    expect(await eq(`"x".link('"')`, `'<a href="&quot;">x</a>'`)).toBe(1);
    // A value with no quote is copied through unchanged.
    expect(await eq(`"x".fontcolor("navy")`, `'<font color="navy">x</font>'`)).toBe(1);
  });

  it("stringifies an absent attribute argument as 'undefined'", async () => {
    // CreateHTML step 4.b runs ToString(value); an omitted arg → undefined.
    expect(await eq(`"foo".anchor()`, `'<a name="undefined">foo</a>'`)).toBe(1);
  });

  it("handles the empty receiver and empty attribute value", async () => {
    expect(await eq(`"".bold()`, `"<b></b>"`)).toBe(1);
    expect(await eq(`"".anchor("")`, `'<a name=""></a>'`)).toBe(1);
  });
});

describe("#3069 standalone HTML wrappers are host-free", () => {
  it("emits no env import", async () => {
    const r = await compile(`export function test(): string { return "x".bold().anchor("y"); }`, {
      target: "standalone",
    });
    expect(r.success).toBe(true);
    // A genuine standalone module must carry no JS-host `env` imports.
    const envImports = (r.imports ?? []).filter((i: { module?: string }) => i.module === "env");
    expect(envImports).toEqual([]);
  });
});
