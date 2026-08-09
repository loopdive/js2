// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1474/#1539 — standalone native RegExp boundary.
 *
 * RegExp used to delegate entirely to the JS host engine. In `--target
 * standalone` (pure WasmGC, no JS host), forms outside #682's reduced native
 * literal-substring subset must still fail at compile time with a clear `#1474`
 * message and a source location — rather than emitting an `env::RegExp_new`
 * import that fails at `wasmtime instantiate`.
 *
 * Dynamic literal and Acorn word-alternation patterns compile to the in-module
 * bytecode VM. Residual unsupported symbol-protocol forms remain loud.
 */

async function expectRefused(src: string): Promise<ReturnType<typeof compile>> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, `expected compile failure, got success for:\n${src}`).toBe(false);
  expect(r.errors.length).toBeGreaterThan(0);
  // #1539 narrowed the standalone-RegExp refusals; the residual ones cite
  // either #1474 (String-method gate) or #1539 (engine subset).
  const cite = /#1474|#1539/;
  expect(r.errors.some((e) => cite.test(e.message))).toBe(true);
  // Source location must be reported (line > 0).
  const refusal = r.errors.find((e) => cite.test(e.message))!;
  expect(refusal.line).toBeGreaterThan(0);
  return r;
}

async function compileAndRunAcornCarrier(source: string): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-3507.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
    experimentalIR: false,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(
    result.imports.map((entry) => `${entry.module}::${entry.name}`).filter((name) => /(^|::)RegExp_/.test(name)),
  ).toEqual([]);
  const module = await WebAssembly.compile(result.binary);
  const instance = await WebAssembly.instantiate(module, {});
  return (instance.exports as { test(): number }).test();
}

// #1539 Phase 2a and #1712 narrowed these refusals: static patterns and the
// bounded runtime-pattern grammar now compile to the pure-WasmGC backtracking
// VM (see tests/issue-1539-standalone-regex.test.ts). The residual refusal
// cases below are unsupported symbol-protocol and RegExp grammar surfaces.
describe("#1474/#1539 --target standalone native RegExp", () => {
  it("preserves an Acorn-mode RegExp through a typed function parameter", async () => {
    expect(
      await compileAndRunAcornCarrier(`
        function accepts(re: RegExp, value: string): boolean {
          return re.test(value);
        }
        export function test(): number {
          return accepts(/\\p{ASCII}+/u, "ASCII") ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("routes Acorn-mode untyped helper and object-property carriers by runtime brand", async () => {
    expect(
      await compileAndRunAcornCarrier(`
        function verify(record, value) {
          return record.regExp.test(value);
        }
        export function test(): number {
          const record = { regExp: /^(?:[\\q{ab|cd}])+$/v };
          return verify(record, "abcd") ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("preserves Acorn-mode RegExp identity through array and for-of carriers", async () => {
    expect(
      await compileAndRunAcornCarrier(`
        export function test(): number {
          const regexps = [/^\\d+$/, /^\\d+$/u, /^\\d+$/v];
          let matched = 0;
          for (const regexp of regexps) {
            if (regexp.test("123")) matched++;
          }
          return matched;
        }
      `),
    ).toBe(3);
  });

  it("keeps Acorn-mode global carrier lastIndex semantics", async () => {
    expect(
      await compileAndRunAcornCarrier(`
        function next(re, value) { return re.test(value); }
        export function test(): number {
          const re = /a/g;
          const a = next(re, "aa");
          const b = next(re, "aa");
          const c = next(re, "aa");
          return a && b && !c && re.lastIndex === 0 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("keeps Acorn-mode dynamic constructor patterns on the native carrier", async () => {
    expect(
      await compileAndRunAcornCarrier(`
        function matches(pattern: string): boolean { return new RegExp(pattern).test("x"); }
        export function test(): number { return matches("x") && !matches("y") ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("executes a dynamic literal constructor without host imports", async () => {
    const r = await compile(
      `function f(p: string): boolean { return new RegExp(p).test("x"); } export function run(): number { return f("x") ? 1 : 0; }`,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const mod = await WebAssembly.compile(r.binary);
    expect(WebAssembly.Module.imports(mod).filter((entry) => entry.kind === "function")).toEqual([]);
    const instance = await WebAssembly.instantiate(mod, {});
    expect((instance.exports as { run(): number }).run()).toBe(1);
  });

  it("executes RegExp(dynamicPattern) called without new", async () => {
    const r = await compile(
      `function f(p: string): boolean { const r = RegExp(p); return r.test("x"); } export function run(): number { return f("y") ? 1 : 0; }`,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.run as () => number)()).toBe(0);
  });

  it("executes Acorn's dynamic anchored word alternation", async () => {
    const r = await compile(
      `
        function wordsRegexp(words: string): RegExp {
          return new RegExp("^(?:" + words.replace(/ /g, "|") + ")$");
        }
        export function run(): number {
          const re = wordsRegexp("break case catch");
          return re.test("case") && !re.test("cas") && !re.test("other") ? 1 : 0;
        }
      `,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const mod = await WebAssembly.compile(r.binary);
    expect(WebAssembly.Module.imports(mod).filter((entry) => entry.kind === "function")).toEqual([]);
    const instance = await WebAssembly.instantiate(mod, {});
    expect((instance.exports as { run(): number }).run()).toBe(1);
  });

  it("executes a dynamic wildcard without an OOB trap", async () => {
    const r = await compile(
      `function make(p: string): RegExp { return new RegExp(p); } export function run(): number { return make(".").test("x") ? 1 : 0; }`,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.run as () => number)()).toBe(1);
  });

  it("throws catchable errors for invalid and unsupported dynamic patterns", async () => {
    const r = await compile(
      `
        function invalid(p: string): number {
          try { new RegExp(p); return 0; }
          catch (e) { return e instanceof SyntaxError ? 1 : 2; }
        }
        function unsupported(p: string): number {
          try { new RegExp(p); return 0; }
          catch (e) { return e instanceof TypeError ? 1 : 2; }
        }
        export function run(): number { return invalid("[") * 10 + unsupported("a+"); }
      `,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.run as () => number)()).toBe(11);
  });

  it("uses runtime g/y flag bits for lastIndex semantics", async () => {
    const r = await compile(
      `
        function make(p: string, f: string): RegExp { return new RegExp(p, f); }
        export function run(): number {
          const re = make("a", "g");
          return (re.test("aa") ? 100 : 0) + (re.test("aa") ? 10 : 0) + (re.test("aa") ? 1 : 0);
        }
      `,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.run as () => number)()).toBe(110);
  });

  it("escapes the dynamic empty source and copies runtime RegExp carriers", async () => {
    const r = await compile(
      `
        function make(p: string, f: string): RegExp { return new RegExp(p, f); }
        function clone(re: RegExp): RegExp { return new RegExp(re); }
        export function run(): number {
          const empty = make("", "");
          const copied = clone(make("a", "g"));
          return empty.source.length * 100 + (copied.test("aa") ? 10 : 0) + (copied.test("aa") ? 1 : 0);
        }
      `,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.run as () => number)()).toBe(411);
  });

  it("compiles non-global s.match(regexLiteral) — capture-array Phase 2b slice", async () => {
    const r = await compile(`export function f(s: string): boolean { return s.match(/\\d+/) !== null; }`, {
      target: "standalone",
    });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  });

  // #1913 landed global String.match (§22.2.6.8 step 6) on the pure-WasmGC
  // matcher — it now compiles instead of refusing. (Equivalence vs native
  // global match lives in tests/issue-1913.test.ts.)
  it("compiles global s.match(regexLiteral) — all-match semantics (#1913)", async () => {
    const r = await compile(
      `export function f(s: string): number { const m = s.match(/\\d+/g); return m === null ? -1 : m.length; }`,
      { target: "standalone" },
    );
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  });

  // #2161 landed global String.matchAll(/re/g) on the pure-WasmGC matcher as an
  // iterable vec of capture-arrays — the for-of form now compiles instead of
  // refusing. (Behavior coverage lives in tests/issue-2161-matchall.test.ts.)
  it("compiles global s.matchAll(/re/g) for-of — iterable of capture arrays (#2161)", async () => {
    const r = await compile(
      `export function f(s: string): number { let n = 0; for (const m of s.matchAll(/\\d/g)) n++; return n; }`,
      { target: "standalone" },
    );
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  });

  it("rejects non-global s.matchAll(/re/) — runtime TypeError per §22.1.3.13 (#2161 narrowed)", async () => {
    await expectRefused(
      `export function f(s: string): number { let n = 0; for (const m of s.matchAll(/\\d/)) n++; return n; }`,
    );
  });

  // #1539 Phase 2b landed `String.prototype.search(/re/)` on the pure-WasmGC
  // matcher — it now compiles instead of refusing. (Equivalence vs native
  // `search` lives in tests/issue-1539-standalone-regex.test.ts.)
  it("compiles s.search(regexLiteral) — String method (Phase 2b)", async () => {
    const r = await compile(`export function f(s: string): number { return s.search(/\\d/); }`, {
      target: "standalone",
    });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  });

  it("compiles s.split(regexArg) — non-capturing Phase 2c slice", async () => {
    const r = await compile(`export function f(s: string): number { const r = /,/; return s.split(r).length; }`, {
      target: "standalone",
    });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  });

  it("compiles s.replace(regexArg, literal) — Phase 2c slice", async () => {
    const r = await compile(`export function f(s: string): string { const r = /a/g; return s.replace(r, "b"); }`, {
      target: "standalone",
    });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  });

  it("preserves the guarded native-string receiver for untyped replace", async () => {
    const r = await compile(
      `
        function rewrite(s) { return s.replace(/a/g, "b"); }
        export function run(): number {
          const out = rewrite("aax");
          return out.charCodeAt(0) * 10000 + out.charCodeAt(1) * 100 + out.charCodeAt(2);
        }
      `,
      { target: "standalone", skipSemanticDiagnostics: true },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const mod = await WebAssembly.compile(r.binary);
    expect(WebAssembly.Module.imports(mod).filter((entry) => entry.kind === "function")).toEqual([]);
    const instance = await WebAssembly.instantiate(mod, {});
    expect((instance.exports as { run(): number }).run()).toBe(989920);
  });

  it("preserves the guarded native-string receiver for untyped match", async () => {
    const r = await compile(
      `
        function prefixLength(s) { return s.match(/^[0-7]+/)[0].length; }
        export function run(): number { return prefixLength("123x"); }
      `,
      { target: "standalone", skipSemanticDiagnostics: true },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const mod = await WebAssembly.compile(r.binary);
    expect(WebAssembly.Module.imports(mod).filter((entry) => entry.kind === "function")).toEqual([]);
    const instance = await WebAssembly.instantiate(mod, {});
    expect((instance.exports as { run(): number }).run()).toBe(3);
  });

  it("emits no env::RegExp_new import for dynamic patterns", async () => {
    const r = await compile(`export function f(p: string): boolean { return new RegExp(p, "g").test("x"); }`, {
      target: "standalone",
    });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const labels = r.imports.map((i) => `${i.module}::${i.name}`);
    expect(labels.some((l) => /RegExp_new/.test(l))).toBe(false);
  });
});

describe("#1474 default (JS-host) mode unchanged", () => {
  it("compiles a regex literal in default mode", async () => {
    const r = await compile(`export function f(s: string): boolean { return /\\d+/.test(s); }`, {});
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  });

  it("compiles s.replace(regex, ...) in default mode", async () => {
    const r = await compile(`export function f(s: string): string { return s.replace(/a/g, "b"); }`, {});
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  });

  it("compiles new RegExp(...) in default mode", async () => {
    const r = await compile(`export function f(p: string): boolean { return new RegExp(p, "g").test("x"); }`, {});
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  });

  it("standalone string methods without regex still compile", async () => {
    const r = await compile(`export function f(s: string): string { return s.replace("a", "b").split(",")[0]!; }`, {
      target: "standalone",
    });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  });
});
