// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

function assertNoJsonHostImports(result) {
  const labels = result.imports.map((i) => i.module + "::" + i.name);
  expect(labels.filter((l) => /env::JSON_(parse|stringify)/.test(l))).toEqual([]);
}

async function runStandalone(body) {
  const src = "export function test(): number {\n" + body + "\n}";
  const result = await compile(src, { target: "standalone" });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  assertNoJsonHostImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return instance.exports.test();
}

describe("#1599 Phase 2 — runtime JSON.stringify(string) standalone", () => {
  it("quotes a plain runtime string", async () => {
    const r = await runStandalone(`
      let s: string = "hel";
      s = s + "lo";
      return JSON.stringify(s) === '"hello"' ? 1 : 0;
    `);
    expect(r).toBe(1);
  });

  it("escapes quote and backslash", async () => {
    // build 'a"b\c' at runtime: 'a"' + 'b' + '\\' + 'c'
    const r = await runStandalone(`
      let s: string = 'a"';
      s = s + 'b' + '\\\\' + 'c';
      return JSON.stringify(s) === '"a\\\\"b\\\\\\\\c"' ? 1 : 0;
    `);
    expect(r).toBe(1);
  });

  it("escapes the short control chars b t n f r", async () => {
    const r = await runStandalone(`
      let s: string = "\\b\\t";
      s = s + "\\n\\f\\r";
      return JSON.stringify(s) === '"\\\\b\\\\t\\\\n\\\\f\\\\r"' ? 1 : 0;
    `);
    expect(r).toBe(1);
  });

  it("escapes other control chars as uXXXX", async () => {
    const r = await runStandalone(`
      let s: string = "\\u0000\\u0001";
      s = s + "\\u001f";
      return JSON.stringify(s) === '"\\\\u0000\\\\u0001\\\\u001f"' ? 1 : 0;
    `);
    expect(r).toBe(1);
  });

  it("returns just quotes for the empty runtime string", async () => {
    const r = await runStandalone(`
      let s: string = "x";
      s = s.slice(1);
      return JSON.stringify(s) === '""' ? 1 : 0;
    `);
    expect(r).toBe(1);
  });

  it("does not pull in env::JSON_stringify for runtime string stringify", async () => {
    const result = await compile("export function test(s: string): string { return JSON.stringify(s); }", {
      target: "standalone",
    });
    expect(result.success).toBe(true);
    assertNoJsonHostImports(result);
  });
});

// (#1599 Phase 2) Runtime JSON.parse(s) of a primitive — number / true / false
// / null — in --target standalone, lowered to the pure-Wasm `__json_parse_text`
// codec (no env::JSON_parse host import). The primitive-only
// `__json_parse_primitive` helper it superseded was deleted by #7350 B2c-2.
describe("#1599 Phase 2 — runtime JSON.parse(primitive) standalone", () => {
  it("routes through __json_parse_text and never emits __json_parse_primitive", async () => {
    const result = await compile("export function test(s: string): number { return JSON.parse(s); }", {
      target: "standalone",
    });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(result.wat).toContain("$__json_parse_text");
    expect(result.wat).not.toContain("__json_parse_primitive");
  });

  it("parses a runtime JSON number", async () => {
    const r = await runStandalone(`
      let s: string = "123";
      s = s + ".45";
      const n: number = JSON.parse(s);
      return n === 123.45 ? 1 : 0;
    `);
    expect(r).toBe(1);
  });

  it("parses a negative number with an exponent", async () => {
    const r = await runStandalone(`
      let s: string = "-7";
      s = s + "e2";
      const n: number = JSON.parse(s);
      return n === -700 ? 1 : 0;
    `);
    expect(r).toBe(1);
  });

  it("parses a leading-zero fraction", async () => {
    const r = await runStandalone(`
      let s: string = "0.";
      s = s + "5";
      const n: number = JSON.parse(s);
      return n === 0.5 ? 1 : 0;
    `);
    expect(r).toBe(1);
  });

  it("parses true and false", async () => {
    const t = await runStandalone(`
      let s: string = "tr";
      s = s + "ue";
      const b: boolean = JSON.parse(s);
      return b ? 1 : 0;
    `);
    expect(t).toBe(1);
    const f = await runStandalone(`
      let s: string = "fa";
      s = s + "lse";
      const b: boolean = JSON.parse(s);
      return b ? 1 : 0;
    `);
    expect(f).toBe(0);
  });

  it("parses null (typeof object)", async () => {
    // The parsed null boxes as a tag-0 $AnyValue, which `typeof` reports as
    // "object" per ECMA-262. (`=== null` against a boxed AnyValue is a separate
    // pre-existing comparison concern tracked under #1599 Phase 2 string work.)
    const r = await runStandalone(`
      let s: string = "nu";
      s = s + "ll";
      const v = JSON.parse(s);
      return typeof v === "object" ? 1 : 0;
    `);
    expect(r).toBe(1);
  });

  it("skips leading/trailing whitespace around a number", async () => {
    const r = await runStandalone(`
      let s: string = " 4";
      s = s + "2 ";
      const n: number = JSON.parse(s);
      return n === 42 ? 1 : 0;
    `);
    expect(r).toBe(1);
  });

  it("does not pull in env::JSON_parse for runtime primitive parse", async () => {
    const result = await compile(
      "export function test(s: string): number { const n: number = JSON.parse(s); return n; }",
      { target: "standalone" },
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoJsonHostImports(result);
  });

  it("works under --target wasi too", async () => {
    const result = await compile(
      "export function test(s: string): number { const n: number = JSON.parse(s); return n; }",
      { target: "wasi" },
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoJsonHostImports(result);
  });
});
