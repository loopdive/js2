// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3652 — compact Unicode code-point classes.
 *
 * Unicode property escapes used to be lowered into BMP classes plus one
 * surrogate-pair branch per astral range. Large complement properties thereby
 * spent the RegExp step budget navigating bytecode structure rather than
 * consuming input. CPCLASS preserves the enumerated ranges and consumes one
 * Unicode code point in either VM direction.
 */
import { describe, expect, it } from "vitest";
import { buildImports } from "../src/runtime.js";
import { compile } from "../src/index.js";
import { ReOp, parseFlags } from "../src/codegen/regex/bytecode.js";
import { compilePattern } from "../src/codegen/regex/compile.js";
import { search } from "../src/codegen/regex/vm.js";

function matches(pattern: string, flags: string, input: string): boolean {
  const compiled = compilePattern(pattern, parseFlags(flags));
  return search(compiled.prog, compiled.classTable, compiled.nGroups, input, 0, false, compiled.nScratch ?? 0) !== null;
}

describe("#3652 compact Unicode code-point bytecode", () => {
  it("keeps a large property class as one CPCLASS instruction", () => {
    const compiled = compilePattern("\\P{Script=Unknown}", parseFlags("u"));
    const ops = compiled.prog.filter((_, index) => index % 3 === 0);

    expect(ops).toContain(ReOp.CPCLASS);
    expect(ops).not.toContain(ReOp.SPLIT);
  });

  it("matches BMP, astral, and lone-surrogate code points without splitting pairs", () => {
    expect(matches("[A😀]", "u", "A")).toBe(true);
    expect(matches("[A😀]", "u", "😀")).toBe(true);
    expect(matches("[A😀]", "u", "B")).toBe(false);

    expect(matches("[\\uD800]", "u", "\ud800")).toBe(true);
    expect(matches("[\\uD800]", "u", "😀")).toBe(false);
    expect(matches("[\\uDC00]", "u", "\udc00")).toBe(true);
    expect(matches("[\\uDC00]", "u", "😀")).toBe(false);
  });

  it("consumes an astral code point backwards in lookbehind", () => {
    expect(matches("(?<=[A😀])x", "u", "Ax")).toBe(true);
    expect(matches("(?<=[A😀])x", "u", "😀x")).toBe(true);
    expect(matches("(?<=[A😀])x", "u", "Bx")).toBe(false);
    expect(matches("(?<=[\\uD800])", "u", "😀")).toBe(false);
  });

  it("preserves Unicode ignore-case folding in compact classes", () => {
    expect(matches("k", "iu", "\u212a")).toBe(true);
    expect(matches("(?<=k)x", "iu", "\u212ax")).toBe(true);
  });
});

describe("#3652 standalone native RegExp VM", () => {
  it("validates CPCLASS Wasm and completes a formerly step-limited property match", async () => {
    const source = String.raw`
if (!/[A😀]/u.test("A")) throw new Error("BMP CPCLASS failed");
if (!/[A😀]/u.test("😀")) throw new Error("astral CPCLASS failed");
if (/[\uD800]/u.test("😀")) throw new Error("surrogate pair was split");
if (!/[\uD800]/u.test("\uD800")) throw new Error("lone surrogate failed");
if (/[\uDC00]/u.test("😀")) throw new Error("trail half was treated as lone");
if (!/(?<=[A😀])x/u.test("😀x")) throw new Error("reverse CPCLASS failed");
if (/(?<=[\uD800])/u.test("😀")) throw new Error("lead half was treated as lone");

var chunk = "abcdefghijklmnop";
var subject = chunk;
for (var i = 0; i < 16; i++) subject += subject;
if (subject.length !== 1048576) throw new Error("bad subject length");
if (!/^\P{Script=Unknown}+$/u.test(subject)) throw new Error("large property failed");
`;
    const result = await compile(source, {
      allowJs: true,
      fileName: "issue-3652.js",
      skipSemanticDiagnostics: true,
      target: "standalone",
      deferTopLevelInit: true,
    });

    expect(result.success).toBe(true);
    expect(result.imports).toHaveLength(0);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const imports = buildImports(result.imports, undefined, result.stringPool) as WebAssembly.Imports;
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const init = (instance.exports as Record<string, unknown>).__module_init;
    expect(typeof init).toBe("function");
    (init as () => void)();
  }, 120_000);
});
