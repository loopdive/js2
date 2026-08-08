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
