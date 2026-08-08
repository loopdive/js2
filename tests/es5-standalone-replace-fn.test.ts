// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4224 — `String.prototype.replace(/re/, fn)` and non-string replacements in
 * `--target standalone` (pure WasmGC, no JS host).
 *
 * Every case compiles host-free, instantiates with an EMPTY import object
 * (which is the real proof of standalone: a `env.string_replace` or
 * `env.RegExp_new` import would fail instantiation), runs, and compares against
 * what the SAME source produces on the JS engine running the test. Reading the
 * result back one code unit at a time is deliberate — a standalone export
 * returns a WasmGC `$AnyString`, not a JS string, so length alone would hide a
 * content bug.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function standaloneString(src: string): Promise<string> {
  const wrapped = `
    ${src}
    export function len(): number { return __r.length; }
    export function at(i: number): number { return __r.charCodeAt(i); }
  `;
  const r = await compile(wrapped, {
    fileName: "issue-4224.ts",
    target: "standalone",
  });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const hostImports = WebAssembly.Module.imports(mod).filter((i) => /RegExp|string_replace/.test(i.name));
  expect(hostImports, "no RegExp/string_replace host import in standalone").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as { len(): number; at(i: number): number };
  let out = "";
  for (let i = 0, n = ex.len(); i < n; i++) out += String.fromCharCode(ex.at(i));
  return out;
}

describe("#4224 standalone replace — function replacer", () => {
  it("declared-param replacer receives (matched, …captures, offset, string)", async () => {
    const out = await standaloneString(`
      const __r: string = "abc12 def34".replace(/([a-z]+)([0-9]+)/, function (m: any, p1: any, p2: any, off: any, s: any): string {
        return "" + m + "|" + p1 + "|" + p2 + "|" + off + "|" + s.length;
      });
    `);
    expect(out).toBe(
      "abc12 def34".replace(/([a-z]+)([0-9]+)/, (m, p1, p2, off, s) => `${m}|${p1}|${p2}|${off}|${String(s).length}`),
    );
  });

  it("under-arity replacer still sees every argument via `arguments`", async () => {
    // test262's S15.5.4.11_A4_* shape: zero declared params, reads `arguments`.
    const out = await standaloneString(`
      function __replFN(): string { return "" + arguments[2] + arguments[1]; }
      const __r: string = "abc12 def34".replace(/([a-z]+)([0-9]+)/, __replFN);
    `);
    expect(out).toBe("12abc def34");
  });

  it("global flag replaces every match", async () => {
    const out = await standaloneString(`
      function __replFN(): string { return "" + arguments[2] + arguments[1]; }
      const __r: string = "abc12 def34".replace(/([a-z]+)([0-9]+)/g, __replFN);
    `);
    expect(out).toBe("12abc 34def");
  });

  it("replaceAll with a global pattern", async () => {
    const out = await standaloneString(`
      const __r: string = "a1b2".replaceAll(/(\\d)/g, function (m: any, p1: any): string { return "[" + p1 + "]"; });
    `);
    expect(out).toBe("a1b2".replaceAll(/(\d)/g, (_m, p1) => `[${p1}]`));
  });

  it("a replacer returning a non-string is ToString-ed", async () => {
    const out = await standaloneString(`
      const __r: string = "a1b".replace(/\\d/, function (): any { return 42; });
    `);
    expect(out).toBe("a42b");
  });

  it("a non-participating capture group arrives as undefined", async () => {
    const out = await standaloneString(`
      const __r: string = "xb".replace(/(a)?(b)/, function (m: any, p1: any, p2: any): string { return "" + p1 + p2; });
    `);
    expect(out).toBe("xb".replace(/(a)?(b)/, (_m, p1, p2) => `${p1}${p2}`));
  });

  it("no match leaves the subject untouched", async () => {
    const out = await standaloneString(`
      const __r: string = "abc".replace(/z/, function (): string { return "Q"; });
    `);
    expect(out).toBe("abc");
  });

  it("empty-match advance terminates (AdvanceStringIndex)", async () => {
    const out = await standaloneString(`
      const __r: string = "abc".replace(/x*/g, function (): string { return "-"; });
    `);
    expect(out).toBe("abc".replace(/x*/g, () => "-"));
  });
});

describe("#4224 standalone replace — non-callable replacement is ToString-ed", () => {
  it("undefined replacement (§22.2.6.11 step 2)", async () => {
    const out = await standaloneString(`const __r: string = "undefined".replace(/e/g, void 0);`);
    expect(out).toBe("undefined".replace(/e/g, undefined as unknown as string));
  });

  it("number replacement", async () => {
    const out = await standaloneString(`const __r: string = "a77b".replace(/77/, 1 as any);`);
    expect(out).toBe("a1b");
  });

  it("null replacement", async () => {
    const out = await standaloneString(`const __r: string = "axb".replace(/x/, null as any);`);
    expect(out).toBe("anullb");
  });

  it("$-substitution still expands in a string replacement", async () => {
    const out = await standaloneString(`const __r: string = "a1b".replace(/(\\d)/, "[$1]");`);
    expect(out).toBe("a[1]b");
  });
});

// (#4224) The STRING search-value lane. Before this, `string-ops.ts` compiled
// the replacement straight into a `ref $AnyString` slot with no gate at all: a
// function replacer trapped with `illegal cast` at runtime and a numeric one
// produced a module that failed `WebAssembly.compile` — both after a GREEN
// compile, which is why these are regression tests and not feature tests.
describe("#4224 standalone replace — string search value", () => {
  it("function replacer on a string search (first occurrence only)", async () => {
    const out = await standaloneString(
      `const __r: string = "abcb".replace("b", function (m: string): string { return m + m; });`,
    );
    expect(out).toBe("abcb".replace("b", (m) => m + m));
  });

  it("replaceAll walks every occurrence", async () => {
    const out = await standaloneString(
      `const __r: string = "abcb".replaceAll("b", function (m: string): string { return "[" + m + "]"; });`,
    );
    expect(out).toBe("abcb".replaceAll("b", (m) => `[${m}]`));
  });

  it("the replacer receives (matched, position, string)", async () => {
    const out = await standaloneString(`
      const __r: string = "xxbyy".replace("b", function (m: any, off: any, s: any): string {
        return "" + m + off + s.length;
      });
    `);
    expect(out).toBe("xxbyy".replace("b", (m, off, s) => `${m}${off}${String(s).length}`));
  });

  it("an under-arity replacer sees its arguments", async () => {
    const out = await standaloneString(`
      function __f(): string { return "" + arguments[1]; }
      const __r: string = "xxbyy".replace("b", __f);
    `);
    expect(out).toBe("xx2yy");
  });

  it("numeric replacement is ToString-ed (was invalid Wasm)", async () => {
    const out = await standaloneString(`const __r: string = "abc".replace("b", 1 as any);`);
    expect(out).toBe("a1c");
  });

  it("non-string search value is ToString-ed", async () => {
    const out = await standaloneString(`const __r: string = "a1b".replace(1 as any, "X");`);
    expect(out).toBe("aXb");
  });

  it("a search string that is absent leaves the subject untouched", async () => {
    const out = await standaloneString(`const __r: string = "abc".replace("z", function (): string { return "Q"; });`);
    expect(out).toBe("abc");
  });

  it("an empty search string terminates (matches once at 0)", async () => {
    const out = await standaloneString(`const __r: string = "ab".replaceAll("", function (): string { return "-"; });`);
    expect(out).toBe("ab".replaceAll("", () => "-"));
  });

  it("string search + string replacement is unchanged", async () => {
    const out = await standaloneString(`const __r: string = "abc".replace("b", "Z");`);
    expect(out).toBe("aZc");
  });
});

// (#4224) The replacement-value gate is ASYMMETRIC with the search-value one,
// and both halves matter. A type carrying a call signature already classifies as
// `function`, so an `object` fact PROVES `IsCallable` is false — enough for
// §22.2.6.11 step 2. A SEARCH value gets no such proof: `@@replace` can be
// installed after the type is fixed, so an object search value must keep
// reaching the #1474 refusal rather than silently taking the ToString path.
describe("#4224 standalone replace — replacement/search gate asymmetry", () => {
  it("an object replacement runs its own toString exactly once", async () => {
    const out = await standaloneString(`
      let calls = 0;
      const replaceValue = { toString: function (): string { calls += 1; return "b"; } };
      const replaced: string = "xax".replace("a", replaceValue as any);
      const __r: string = replaced + ":" + calls;
    `);
    expect(out).toBe("xbx:1");
  });

  it("an object SEARCH value still refuses (it could carry @@replace)", async () => {
    const r = await compile(
      `
        const searchValue: any = {};
        searchValue[Symbol.replace] = function (): string { return "hit"; };
        export function f(): string { return "".replace(searchValue, "x"); }
      `,
      { fileName: "issue-4224-cstm.ts", target: "standalone" },
    );
    expect(r.success).toBe(false);
    expect(r.errors.some((e) => /#1474/.test(e.message))).toBe(true);
  });
});
