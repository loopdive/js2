// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3665 — Unicode 17 properties of strings and finite v-set algebra.
 */
import { describe, expect, it } from "vitest";
import { parseFlags } from "../src/codegen/regex/bytecode.js";
import { compilePattern } from "../src/codegen/regex/compile.js";
import { search } from "../src/codegen/regex/vm.js";
import { compile } from "../src/index.js";

function matches(pattern: string, flags: string, input: string): boolean {
  const compiled = compilePattern(pattern, parseFlags(flags));
  return search(compiled.prog, compiled.classTable, compiled.nGroups, input, 0, false, compiled.nScratch ?? 0) !== null;
}

describe("#3665 Unicode properties of strings", () => {
  const cases: Array<[string, string]> = [
    ["Basic_Emoji", "©️"],
    ["Emoji_Keycap_Sequence", "9️⃣"],
    ["RGI_Emoji", "👨‍❤️‍👨"],
    ["RGI_Emoji_Flag_Sequence", "🇩🇪"],
    ["RGI_Emoji_Modifier_Sequence", "☝🏻"],
    ["RGI_Emoji_Tag_Sequence", "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}"],
    ["RGI_Emoji_ZWJ_Sequence", "👨‍❤️‍👨"],
  ];

  for (const [property, sample] of cases) {
    it(`matches a multi-code-point ${property} member`, () => {
      const pattern = `^\\p{${property}}$`;
      expect(matches(pattern, "v", sample)).toBe(true);
      expect(matches(pattern, "v", "not emoji")).toBe(false);
    });
  }

  it("tries longer string members before a one-code-point prefix", () => {
    expect(matches("^\\p{Basic_Emoji}$", "v", "©️")).toBe(true);
    expect(matches("^\\p{RGI_Emoji}$", "v", "©️")).toBe(true);
  });

  it("shares finite-string prefixes before bytecode emission", () => {
    const rgi = compilePattern("^\\p{RGI_Emoji}+$", parseFlags("v"));
    const zwj = compilePattern("^\\p{RGI_Emoji_ZWJ_Sequence}+$", parseFlags("v"));
    expect(rgi.prog.length / 3).toBeLessThan(2_000);
    expect(zwj.prog.length / 3).toBeLessThan(1_500);
  });
});

describe("#3665 finite v-set algebra", () => {
  it("intersects both code-point and multi-code-point members", () => {
    const pattern = "^[\\q{0|2|4|9\\uFE0F\\u20E3}&&\\p{Emoji_Keycap_Sequence}]$";
    expect(matches(pattern, "v", "9️⃣")).toBe(true);
    expect(matches(pattern, "v", "9")).toBe(false);
    expect(matches(pattern, "v", "8️⃣")).toBe(false);
  });

  it("subtracts one-code-point and string members independently", () => {
    expect(matches("^[\\q{0|2|4|9\\uFE0F\\u20E3}--\\d]$", "v", "9️⃣")).toBe(true);
    expect(matches("^[\\q{0|2|4|9\\uFE0F\\u20E3}--\\d]$", "v", "2")).toBe(false);
    expect(matches("^[\\p{Emoji_Keycap_Sequence}--\\q{9\\uFE0F\\u20E3}]$", "v", "8️⃣")).toBe(true);
    expect(matches("^[\\p{Emoji_Keycap_Sequence}--\\q{9\\uFE0F\\u20E3}]$", "v", "9️⃣")).toBe(false);
  });

  it("unions nested code-point classes with finite strings", () => {
    const pattern = "^[\\p{Emoji_Keycap_Sequence}[0-9]]$";
    expect(matches(pattern, "v", "5")).toBe(true);
    expect(matches(pattern, "v", "5️⃣")).toBe(true);
    expect(matches(pattern, "v", "_")).toBe(false);
  });

  it("retains an empty q member through intersection", () => {
    expect(matches("^[\\q{|ab}&&\\q{|x}]$", "v", "")).toBe(true);
    expect(matches("^[\\q{|ab}&&\\q{|x}]$", "v", "ab")).toBe(false);
  });
});

describe("#3665 standalone lowering", () => {
  it("validates and instantiates with no imports", async () => {
    const source = String.raw`
export function run(): boolean {
  return /^\p{Emoji_Keycap_Sequence}$/v.test("9️⃣")
    && /^\p{RGI_Emoji}$/v.test("👨‍❤️‍👨")
    && /^[\q{0|2|4|9\uFE0F\u20E3}&&\p{Emoji_Keycap_Sequence}]$/v.test("9️⃣")
    && !/^[\p{Emoji_Keycap_Sequence}--\q{9\uFE0F\u20E3}]$/v.test("9️⃣");
}
`;
    const result = await compile(source, { fileName: "issue-3665.ts", target: "standalone" });
    expect(result.success, result.errors?.[0]?.message).toBe(true);
    expect(result.imports).toHaveLength(0);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as { run(): number }).run()).toBe(1);
  }, 120_000);
});
