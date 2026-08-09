// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1539 Phase 2c — pure-WasmGC standalone `String.prototype.replace` /
 * `replaceAll` with a RegExp and a **literal** replacement string.
 *
 * Each case compiles `subject.replace(/re/flags, "repl")` (or `.replaceAll`)
 * under `--target standalone` (pure WasmGC, no JS host), instantiates with an
 * EMPTY import object (proving genuine standalone — no `env.string_replace` and
 * no `env.RegExp_new`), runs it, and asserts the produced string equals native
 * `String.prototype.replace`. The result is read back char-by-char across the
 * Wasm boundary (standalone exports return WasmGC NativeStrings, not JS
 * strings) via a generated `charCodeAt` reader, so both length AND content are
 * verified.
 *
 * `$`-substitution patterns (`$$`/`$&`/`$\``/`$'`/`$n`) landed with #1913's
 * GetSubstitution (§22.2.6.11) — see the positive block below. Function
 * replacers stay the one narrowed refusal of the family.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile + run a standalone `replace`/`replaceAll` and return the full result
 * string by reading each code unit back through an exported `charAt(i)`.
 */
async function standaloneReplace(
  method: "replace" | "replaceAll",
  subject: string,
  pattern: string,
  flags: string,
  replacement: string,
): Promise<string> {
  const subjLit = JSON.stringify(subject);
  const replLit = JSON.stringify(replacement);
  const call = `${subjLit}.${method}(/${pattern}/${flags}, ${replLit})`;
  // Export the length and a per-index code-unit reader so we can rebuild the
  // string on the JS side without marshalling a WasmGC string across the
  // boundary.
  const src = `
    const __r: string = ${call};
    export function len(): number { return __r.length; }
    export function at(i: number): number { return __r.charCodeAt(i); }
  `;
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const hostRegex = WebAssembly.Module.imports(mod).filter((i) => /RegExp|string_replace/.test(i.name));
  expect(hostRegex, "no RegExp/string_replace host import in standalone").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const exports = instance.exports as { len(): number; at(i: number): number };
  const n = exports.len();
  let out = "";
  for (let i = 0; i < n; i++) out += String.fromCharCode(exports.at(i));
  return out;
}

// `p` holds the literal regex source (single backslashes in JS string form).
const CASES: Array<{ method: "replace" | "replaceAll"; subj: string; p: string; f: string; repl: string }> = [
  // replace (first match only when non-global)
  { method: "replace", subj: "banana", p: "a", f: "", repl: "Z" }, // bZnana
  { method: "replace", subj: "a1b2c3", p: "\\d", f: "", repl: "#" }, // a#b2c3
  { method: "replace", subj: "abc", p: "x", f: "", repl: "Q" }, // abc (no match)
  // replace with g flag → all matches
  { method: "replace", subj: "a1b22c333", p: "\\d+", f: "g", repl: "N" }, // aNbNcN
  { method: "replace", subj: "banana", p: "a", f: "g", repl: "Z" }, // bZnZnZ
  { method: "replace", subj: "Hello World", p: "[A-Z]", f: "g", repl: "_" }, // _ello _orld
  // replaceAll (requires global; here all match)
  { method: "replaceAll", subj: "a.b.c", p: "\\.", f: "g", repl: "-" }, // a-b-c
  { method: "replaceAll", subj: "xxx", p: "x", f: "g", repl: "ab" }, // ababab
  // empty-match advance (^ matches once at 0, $ once at end)
  { method: "replace", subj: "hi", p: "^", f: "", repl: ">" }, // >hi
  { method: "replace", subj: "hi", p: "$", f: "", repl: "<" }, // hi<
  // class + anchors
  { method: "replace", subj: "  trim  ", p: "^ +", f: "", repl: "" }, // "trim  "
];

describe("#1539 standalone String.prototype.replace/replaceAll — no JS host, matches native", () => {
  for (const { method, subj, p, f, repl } of CASES) {
    it(`${JSON.stringify(subj)}.${method}(/${p}/${f}, ${JSON.stringify(repl)})`, async () => {
      const expected = subj[method](new RegExp(p, f), repl);
      expect(await standaloneReplace(method, subj, p, f, repl)).toBe(expected);
    });
  }

  it("var-bound RegExp argument (const re = /…/g)", async () => {
    const src = `
      const re = /\\d/g;
      const __r: string = "a1b2".replace(re, "X");
      export function len(): number { return __r.length; }
      export function at(i: number): number { return __r.charCodeAt(i); }
    `;
    const r = await compile(src, { fileName: "test.ts", target: "standalone" });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const ex = instance.exports as { len(): number; at(i: number): number };
    let out = "";
    for (let i = 0; i < ex.len(); i++) out += String.fromCharCode(ex.at(i));
    expect(out).toBe("aXbX");
  });
});

// #1913 landed GetSubstitution (§22.2.6.11): `$$`/`$&`/`$\``/`$'`/`$n`/`$nn`
// replacement patterns now expand at runtime instead of refusing (deep
// coverage in tests/issue-1913.test.ts). Function replacers remain the one
// narrowed refusal of the family.
describe("#1913 $-substitution replace — formerly refused, now matches native", () => {
  const SUBST_CASES: Array<{ subj: string; p: string; f: string; repl: string }> = [
    { subj: "a1b2", p: "\\d", f: "", repl: "[$&]" },
    { subj: "a1b2", p: "(\\d)", f: "g", repl: "$1$1" },
    { subj: "x-y", p: "-", f: "", repl: "($`|$')" },
    { subj: "cost: 5", p: "\\d", f: "", repl: "$$$&" },
  ];
  for (const { subj, p, f, repl } of SUBST_CASES) {
    it(`${JSON.stringify(subj)}.replace(/${p}/${f}, ${JSON.stringify(repl)})`, async () => {
      const expected = subj.replace(new RegExp(p, f), repl);
      expect(await standaloneReplace("replace", subj, p, f, repl)).toBe(expected);
    });
  }
});

describe("#1539/#3567 standalone/WASI replace narrowed refusals (Phase 2c)", () => {
  async function expectRefused(src: string, target: "standalone" | "wasi"): Promise<void> {
    const r = await compile(src, { fileName: "issue-3567.ts", target });
    expect(r.success, `expected refusal for:\n${src}`).toBe(false);
    expect(r.errors.some((e) => /#1539|#1474/.test(e.message))).toBe(true);
    const refusal = r.errors.find((e) => /#1539|#1474/.test(e.message))!;
    expect(refusal.line).toBeGreaterThan(0);
  }

  // (#4224) STANDALONE function replacers are no longer refused — the
  // §22.2.6.11 walk is re-emitted at the call site so the closure can be invoked
  // per match (positive coverage in tests/es5-standalone-replace-fn.test.ts).
  // WASI has no native RegExp lowering on this path and keeps the refusal.
  it("wasi: refuses replace function replacer", async () => {
    await expectRefused(
      `export function f(s: string): string { return s.replace(/\\d/, (m: string) => m + m); }`,
      "wasi",
    );
  });

  it("wasi: refuses replaceAll function replacer", async () => {
    await expectRefused(
      `export function f(s: string): string { return s.replaceAll(/\\d/g, (m: string) => m + m); }`,
      "wasi",
    );
  });

  for (const target of ["standalone", "wasi"] as const) {
    it(`${target}: refuses direct RegExp @@replace function replacer`, async () => {
      await expectRefused(
        `export function f(s: string): string { return /\\d/[Symbol.replace](s, (m: string) => m + m); }`,
        target,
      );
    });
  }

  it("keeps function replacers available in the default host target", async () => {
    const r = await compile(
      `export function f(s: string): string { return s.replace(/\\d/g, (m: string) => m + m); }`,
      { fileName: "issue-3567-host.ts" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  });
});
