// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1539 Phase 2a — pure-WasmGC standalone RegExp engine, `.test` slice.
 *
 * Each case compiles a `RegExp.prototype.test` call under `--target standalone`
 * (pure WasmGC, no JS host), instantiates with an EMPTY import object (proving
 * genuine standalone — no `env.RegExp_new`), runs it, and asserts the boolean
 * result matches the native JS `RegExp.prototype.test`. This is the dual-run
 * equivalence gate the architect required for Phase 2a.
 *
 * The matcher itself (parse → bytecode → VM) is unit-tested in pure TS by
 * tests/regex-bytecode.test.ts; this file validates the Wasm codegen + the
 * standalone routing end-to-end.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile + run `/<pattern>/<flags>.test("<input>")` under --target standalone.
 *
 * The input is embedded as a string literal in the module (standalone exports
 * take/return WasmGC NativeStrings, not JS strings, so we cannot marshal a JS
 * string across the boundary — the matcher runs entirely in-Wasm on a literal,
 * and we read back the boolean as an i32). Mirrors tests/issue-1321-standalone.
 */
async function standaloneTest(pattern: string, flags: string, input: string): Promise<boolean> {
  const inLit = JSON.stringify(input); // safe JS/TS string literal
  const src = `export function run(): boolean { return /${pattern}/${flags}.test(${inLit}); }`;
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  // No JS-host RegExp import should be emitted.
  const mod = await WebAssembly.compile(r.binary);
  const hostRegex = WebAssembly.Module.imports(mod).filter((i) => /RegExp/.test(i.name));
  expect(hostRegex, "no RegExp_new host import in standalone").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const run = (instance.exports as { run(): number }).run;
  return run() !== 0;
}

function nativeTest(pattern: string, flags: string, input: string): boolean {
  return new RegExp(pattern, flags).test(input);
}

// `p` holds the literal regex source (single backslashes in JS string form,
// e.g. "\\d+" === the regex source `\d+`). The same `p` drives both the
// standalone-compiled `/p/` and the native `new RegExp(p)` reference.
const CASES: Array<{ p: string; f: string; inputs: string[] }> = [
  { p: "abc", f: "", inputs: ["abc", "xabcy", "ab", "ABC"] },
  { p: "a.c", f: "", inputs: ["abc", "a c", "ac", "a\nc"] },
  { p: "a+", f: "", inputs: ["", "a", "baaab"] },
  { p: "a*b", f: "", inputs: ["b", "aaab", "xb", "c"] },
  { p: "colou?r", f: "", inputs: ["color", "colour", "coluor"] },
  { p: "[abc]", f: "", inputs: ["a", "d", "xby"] },
  { p: "[^abc]", f: "", inputs: ["a", "d", "abc"] },
  { p: "[a-z]+", f: "", inputs: ["hello", "HELLO", "12abc"] },
  { p: "[0-9]{2,4}", f: "", inputs: ["1", "12", "12345"] },
  { p: "\\d+", f: "", inputs: ["abc123", "no digits"] },
  { p: "\\w+", f: "", inputs: ["foo_bar9", "!!!"] },
  { p: "cat|dog", f: "", inputs: ["i have a dog", "fish", "cat"] },
  { p: "^abc", f: "", inputs: ["abc", "xabc"] },
  { p: "abc$", f: "", inputs: ["abc", "abcx"] },
  { p: "^abc$", f: "", inputs: ["abc", "abcd"] },
  { p: "(ab)+", f: "", inputs: ["ababab", "ba"] },
  { p: "(?:ab)+c", f: "", inputs: ["ababc", "c"] },
  { p: "abc", f: "i", inputs: ["ABC", "AbC", "xyz"] },
  { p: "[a-c]+", f: "i", inputs: ["ABC", "aBcD", "xyz"] },
  // #1539 Phase 2c — dotAll `s`: `.` matches line terminators too.
  { p: "a.c", f: "s", inputs: ["a\nc", "a\rc", "abc"] },
  { p: "a.*z", f: "s", inputs: ["a\nbz", "az", "abc"] },
  // #1539 Phase 2c — multiline `m`: `^`/`$` match at line boundaries.
  { p: "^abc", f: "m", inputs: ["x\nabc", "abc", "xabc"] },
  { p: "abc$", f: "m", inputs: ["abc\ny", "abc", "abcx"] },
  { p: "^abc$", f: "m", inputs: ["x\nabc\ny", "abc", "xabc"] },
  // Non-multiline `^`/`$` unaffected by interior newlines.
  { p: "^abc", f: "", inputs: ["x\nabc", "abc"] },
  // Combined `m` + `s`.
  { p: "^a.b$", f: "ms", inputs: ["a\nb", "x\na\nb\ny", "ab"] },
];

describe("#1539 standalone RegExp.test — no JS host, matches native", () => {
  for (const { p, f, inputs } of CASES) {
    for (const input of inputs) {
      it(`/${p}/${f} on ${JSON.stringify(input)}`, async () => {
        const expected = nativeTest(p, f, input);
        expect(await standaloneTest(p, f, input)).toBe(expected);
      });
    }
  }
});

// #1539 Phase 2b — `String.prototype.search(/re/)`: returns the match index or
// -1, routed through the same pure-WasmGC matcher. The subject is embedded as a
// string literal and the RegExp is the call argument; we read back the f64
// index as a number and compare to native `String.prototype.search`.
async function standaloneSearch(pattern: string, flags: string, input: string): Promise<number> {
  const inLit = JSON.stringify(input);
  const src = `export function run(): number { return ${inLit}.search(/${pattern}/${flags}); }`;
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const hostRegex = WebAssembly.Module.imports(mod).filter((i) => /RegExp/.test(i.name));
  expect(hostRegex, "no RegExp_new host import in standalone").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const run = (instance.exports as { run(): number }).run;
  return run();
}

describe("#1539 standalone String.prototype.search — no JS host, matches native", () => {
  // Reuse the .test corpus: search returns the index of the first match, or -1.
  for (const { p, f, inputs } of CASES) {
    for (const input of inputs) {
      it(`"${input}".search(/${p}/${f})`, async () => {
        const expected = input.search(new RegExp(p, f));
        expect(await standaloneSearch(p, f, input)).toBe(expected);
      });
    }
  }

  it("var-bound RegExp argument (const re = /…/)", async () => {
    const src = `export function run(): number { const re = /\\d+/; return "ab12cd".search(re); }`;
    const r = await compile(src, { fileName: "test.ts", target: "standalone" });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { run(): number }).run()).toBe(2);
  });

  it("new RegExp(...) argument", async () => {
    const src = `export function run(): number { return "xxbx".search(new RegExp("b")); }`;
    const r = await compile(src, { fileName: "test.ts", target: "standalone" });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { run(): number }).run()).toBe(2);
  });
});

async function readStandaloneStringSlots(src: string): Promise<Array<string | undefined> | null> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const hostRegex = WebAssembly.Module.imports(mod).filter((i) =>
    /RegExp|string_match|__make_iterable|__extern_get/.test(i.name),
  );
  expect(hostRegex, "no RegExp/string_match/iterable/extern_get host import in standalone").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as {
    matched(): number;
    count(): number;
    isUndef(i: number): number;
    len(i: number): number;
    at(i: number, j: number): number;
  };
  if (ex.matched() === 0) return null;
  const out: Array<string | undefined> = [];
  for (let i = 0; i < ex.count(); i++) {
    if (ex.isUndef(i) !== 0) {
      out.push(undefined);
      continue;
    }
    let part = "";
    for (let j = 0; j < ex.len(i); j++) part += String.fromCharCode(ex.at(i, j));
    out.push(part);
  }
  return out;
}

async function standaloneExecSlots(
  pattern: string,
  flags: string,
  input: string,
): Promise<Array<string | undefined> | null> {
  const inLit = JSON.stringify(input);
  return readStandaloneStringSlots(`
    export function matched(): boolean { const m = /${pattern}/${flags}.exec(${inLit}); return m !== null; }
    export function count(): number { const m = /${pattern}/${flags}.exec(${inLit}); return m === null ? -1 : m.length; }
    export function isUndef(i: number): boolean {
      const m = /${pattern}/${flags}.exec(${inLit})!;
      return m[i] === undefined;
    }
    export function len(i: number): number {
      const m = /${pattern}/${flags}.exec(${inLit})!;
      return m[i] === undefined ? -1 : m[i]!.length;
    }
    export function at(i: number, j: number): number {
      const m = /${pattern}/${flags}.exec(${inLit})!;
      return m[i]!.charCodeAt(j);
    }
  `);
}

async function standaloneMatchSlots(
  pattern: string,
  flags: string,
  input: string,
): Promise<Array<string | undefined> | null> {
  const inLit = JSON.stringify(input);
  return readStandaloneStringSlots(`
    export function matched(): boolean { const m = ${inLit}.match(/${pattern}/${flags}); return m !== null; }
    export function count(): number { const m = ${inLit}.match(/${pattern}/${flags}); return m === null ? -1 : m.length; }
    export function isUndef(i: number): boolean {
      const m = ${inLit}.match(/${pattern}/${flags})!;
      return m[i] === undefined;
    }
    export function len(i: number): number {
      const m = ${inLit}.match(/${pattern}/${flags})!;
      return m[i] === undefined ? -1 : m[i]!.length;
    }
    export function at(i: number, j: number): number {
      const m = ${inLit}.match(/${pattern}/${flags})!;
      return m[i]!.charCodeAt(j);
    }
  `);
}

function nativeExecSlots(pattern: string, flags: string, input: string): Array<string | undefined> | null {
  const m = new RegExp(pattern, flags).exec(input);
  return m === null ? null : Array.from(m, (s) => s);
}

describe("#1539 standalone RegExp.exec/String.match — capture vec, no JS host", () => {
  const captureCases: Array<{ p: string; f: string; input: string }> = [
    { p: "(ab)(\\d+)", f: "", input: "xxab123yy" },
    { p: "(a)?b", f: "", input: "b" },
    { p: "([a-z]+)|(\\d+)", f: "", input: "42" },
    { p: "([a-z]+)", f: "i", input: "ABC" },
    { p: "^([a-z]+)$", f: "m", input: "x\nabc\ny" },
    { p: "z+", f: "", input: "abc" },
  ];

  for (const { p, f, input } of captureCases) {
    it(`/${p}/${f}.exec(${JSON.stringify(input)})`, async () => {
      expect(await standaloneExecSlots(p, f, input)).toEqual(nativeExecSlots(p, f, input));
    });
    it(`${JSON.stringify(input)}.match(/${p}/${f})`, async () => {
      expect(await standaloneMatchSlots(p, f, input)).toEqual(nativeExecSlots(p, f, input));
    });
  }

  it("var-bound RegExp.exec argument", async () => {
    const out = await readStandaloneStringSlots(`
      const re = /(x+)(y)/;
      export function matched(): boolean { const m = re.exec("axxy"); return m !== null; }
      export function count(): number { const m = re.exec("axxy"); return m === null ? -1 : m.length; }
      export function isUndef(i: number): boolean { const m = re.exec("axxy")!; return m[i] === undefined; }
      export function len(i: number): number { const m = re.exec("axxy")!; return m[i]!.length; }
      export function at(i: number, j: number): number { const m = re.exec("axxy")!; return m[i]!.charCodeAt(j); }
    `);
    expect(out).toEqual(["xxy", "xx", "y"]);
  });

  it("new RegExp(...).exec argument", async () => {
    const out = await readStandaloneStringSlots(`
      export function matched(): boolean { const m = new RegExp("(a+)(b)").exec("aaab"); return m !== null; }
      export function count(): number { const m = new RegExp("(a+)(b)").exec("aaab"); return m === null ? -1 : m.length; }
      export function isUndef(i: number): boolean { const m = new RegExp("(a+)(b)").exec("aaab")!; return m[i] === undefined; }
      export function len(i: number): number { const m = new RegExp("(a+)(b)").exec("aaab")!; return m[i]!.length; }
      export function at(i: number, j: number): number { const m = new RegExp("(a+)(b)").exec("aaab")!; return m[i]!.charCodeAt(j); }
    `);
    expect(out).toEqual(["aaab", "aaa", "b"]);
  });
});

async function standaloneSplit(pattern: string, flags: string, input: string): Promise<string[]> {
  const inLit = JSON.stringify(input);
  const src = `
    const __parts: string[] = ${inLit}.split(/${pattern}/${flags});
    export function count(): number { return __parts.length; }
    export function len(i: number): number { return __parts[i]!.length; }
    export function at(i: number, j: number): number { return __parts[i]!.charCodeAt(j); }
  `;
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const hostRegex = WebAssembly.Module.imports(mod).filter((i) => /RegExp|string_split|__make_iterable/.test(i.name));
  expect(hostRegex, "no RegExp/string_split/iterable host import in standalone").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as { count(): number; len(i: number): number; at(i: number, j: number): number };
  const out: string[] = [];
  for (let i = 0; i < ex.count(); i++) {
    let part = "";
    for (let j = 0; j < ex.len(i); j++) part += String.fromCharCode(ex.at(i, j));
    out.push(part);
  }
  return out;
}

describe("#1539 standalone String.prototype.split — no JS host, matches native", () => {
  const splitCases: Array<{ p: string; f: string; input: string }> = [
    { p: ",", f: "", input: "a,b,c" },
    { p: "[;,] *", f: "", input: "a, b; c" },
    { p: "-+", f: "", input: "one--two---three" },
    { p: "\\d+", f: "", input: "abc123def45" },
    { p: "x", f: "i", input: "startXmidXend" },
    { p: "^b$", f: "m", input: "a\nb\nc" },
  ];
  for (const { p, f, input } of splitCases) {
    it(`${JSON.stringify(input)}.split(/${p}/${f})`, async () => {
      expect(await standaloneSplit(p, f, input)).toEqual(input.split(new RegExp(p, f)));
    });
  }

  it("var-bound RegExp argument", async () => {
    const src = `
      const re = /,+/;
      const __parts: string[] = "a,,b,c".split(re);
      export function run(): number { return __parts.length * 10 + __parts[1]!.length; }
    `;
    const r = await compile(src, { fileName: "test.ts", target: "standalone" });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { run(): number }).run()).toBe(31);
  });

  it("new RegExp(...) argument", async () => {
    const src = `
      const __parts: string[] = "a--b-c".split(new RegExp("-+"));
      export function run(): number { return __parts.length * 10 + __parts[2]!.length; }
    `;
    const r = await compile(src, { fileName: "test.ts", target: "standalone" });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { run(): number }).run()).toBe(31);
  });
});

describe("#1539 standalone runtime constructor and unicode support", () => {
  it("supports a runtime string passed to new RegExp(var)", async () => {
    const src = `
      function matches(pattern: string, input: string): boolean {
        return new RegExp(pattern).test(input);
      }
      export function run(): boolean {
        return matches("x", "xx") && !matches("y", "xx");
      }
    `;
    const r = await compile(src, { fileName: "test.ts", target: "standalone" });
    expect(r.success, r.success ? "" : r.errors?.[0]?.message).toBe(true);
    const mod = await WebAssembly.compile(r.binary);
    expect(WebAssembly.Module.imports(mod).filter((i) => /RegExp/.test(i.name))).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { run(): number }).run()).toBe(1);
  });
  // #1912 Phase 2b landed backreferences, word boundaries, and the class
  // compatibility forms; #1911 Phase 2d Slice A landed lookarounds, inline
  // modifiers, and the `d` flag — none are refused anymore (see
  // tests/issue-1912-regex-phase2b.test.ts and
  // tests/issue-1911-regex-phase2d.test.ts for the dual-run coverage). The
  // `u`/`v` (code-point) flags remain deferred to 2d Slice B.
  it("supports the unicode flag (u) on the standalone backend", async () => {
    // Formerly a Phase 2d Slice B refusal; the `u` flag now compiles and runs
    // on the pure-WasmGC engine (no JS-host RegExp import).
    const src = `export function run(): number { return "abc".search(/b/u); }`;
    const r = await compile(src, { fileName: "test.ts", target: "standalone" });
    expect(r.success, r.success ? "" : r.errors?.[0]?.message).toBe(true);
    const mod = await WebAssembly.compile(r.binary);
    expect(
      WebAssembly.Module.imports(mod).filter((i) => /RegExp/.test(i.name)),
      "no host RegExp import in standalone",
    ).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { run(): number }).run()).toBe(1); // index of "b"
  });
});

// #1913 landed g/y lastIndex exec (§22.2.7.2), global String.match
// (§22.2.6.8), and full RegExpSplit (§22.2.6.14 — limits, captures,
// empty-match separators). The former Phase 2a refusals above now compile
// and must match native semantics (deep coverage in tests/issue-1913.test.ts).
describe("#1913 formerly-refused forms now compile and match native", () => {
  it("RegExp.exec with global lastIndex semantics", async () => {
    const src = `
      const re = /a/g;
      export function run(): number {
        let count = 0;
        while (re.exec("banana") !== null) count++;
        return count * 10 + re.lastIndex;
      }
    `;
    const r = await compile(src, { fileName: "test.ts", target: "standalone" });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    // Native: 3 matches; the terminating failed exec resets lastIndex to 0.
    expect((instance.exports as { run(): number }).run()).toBe(30);
  });

  it("String.match with global all-match semantics", async () => {
    expect(await standaloneMatchSlots("an", "g", "banana")).toEqual(["an", "an"]);
    expect(await standaloneMatchSlots("z", "g", "banana")).toEqual(null);
  });

  const splitCases: Array<{ p: string; f: string; limit?: number; input: string }> = [
    { p: "(,)", f: "", input: "a,b,c" }, // capturing group interleaved
    { p: ",", f: "", limit: 2, input: "a,b,c" }, // limit argument
    { p: "a*", f: "", input: "abc" }, // empty-match separators
    { p: "(?:)", f: "", input: "abc" }, // pure-empty separator → chars
  ];
  for (const { p, f, limit, input } of splitCases) {
    const limArg = limit === undefined ? "" : `, ${limit}`;
    it(`${JSON.stringify(input)}.split(/${p}/${f}${limArg})`, async () => {
      const src = `
        const __parts: string[] = ${JSON.stringify(input)}.split(/${p}/${f}${limArg});
        export function count(): number { return __parts.length; }
        export function len(i: number): number { return __parts[i]!.length; }
        export function at(i: number, j: number): number { return __parts[i]!.charCodeAt(j); }
      `;
      const r = await compile(src, { fileName: "test.ts", target: "standalone" });
      expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
      const { instance } = await WebAssembly.instantiate(r.binary, {});
      const ex = instance.exports as { count(): number; len(i: number): number; at(i: number, j: number): number };
      const out: string[] = [];
      for (let i = 0; i < ex.count(); i++) {
        let part = "";
        for (let j = 0; j < ex.len(i); j++) part += String.fromCharCode(ex.at(i, j));
        out.push(part);
      }
      const expected = limit === undefined ? input.split(new RegExp(p, f)) : input.split(new RegExp(p, f), limit);
      expect(out).toEqual(expected);
    });
  }
});
