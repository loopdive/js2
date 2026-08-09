// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2161 fresh-harvest family fixes (standalone) — three bounded root causes
 * behind ~150 host-pass/standalone-fail RegExp-bucket rows:
 *
 * B0 — null native-string = the `undefined` sentinel must FLOW, not trap.
 *   The non-strict checker erases `undefined` from unions, so
 *   `["a", undefined, "c"]` types as `string[]` while its lowered array
 *   legitimately stores a null slot; an unmatched capture group in a match
 *   result is a null slot too. Three sinks mis-handled that null:
 *     (a) coerceType `ref_null → ref` asserted non-null for native-string
 *         targets → "dereferencing a null pointer" (every sputnik
 *         exec-vs-expected-array test);
 *     (b) the mixed `any === string` strict-equality arm reported
 *         `undefined === undefined` unequal (ref.test is false for null);
 *     (c) `$__regexp_match_vec` → `any[]` param conversion fell into
 *         struct-narrowing, which ref-casts the data array to an unrelated
 *         array type → null → trap (every `assert.compareArray(s.match(re),
 *         […])` harness call).
 *
 * B2 — §22.1.3.23 undefined separator / limit:
 *   `s.split()` / `s.split(undefined)` returns `[S]` (or `[]` with limit 0);
 *   a statically-`undefined` LIMIT means 2^32-1, not ToUint32(NaN) = 0.
 *
 * B4 — never-reassigned `var`/`let` pattern-fold (extends slice 9's
 *   const-only fold): `var __re = "d+"; RegExp(__re, "i")`, the var-bound
 *   regex-literal / ctor copy source, `void 0` / never-written-uninitialised
 *   flags, and diamond concat chains (`a + "x" + a`).
 *
 * All standalone with an empty importObject (zero host-import leak).
 */
async function runStandalone(src: string): Promise<{ leaks: string[]; main: () => unknown }> {
  // skipSemanticDiagnostics mirrors the test262 runner (where these families
  // manifest): sputnik sources are JS, so `string | undefined` flows into
  // `string` slots without checker complaints — exactly the shape under test.
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const leaks = r.imports.map((i) => `${i.module}::${i.name}`).filter((l) => !l.startsWith("wasm:js-string::"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return { leaks, main: instance.exports.main as () => unknown };
}

describe("#2161 B0 — null native-string undefined sentinel flows (standalone)", () => {
  it("(string|undefined)[] element read into a string local does not trap", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var a = ["ac", "a", undefined, "c"];
        var s: string = a[2];
        return s === undefined ? 1 : 0;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(1);
  });

  it("undefined element passed to a string param compares equal to an undefined any", async () => {
    // The test262 harness shape: assert_sameValue_str(actual: any, expected: string)
    const { leaks, main } = await runStandalone(
      `function eq(actual: any, expected: string): number {
        return actual !== expected ? 0 : 1;
      }
      export function main(): number {
        var m = /(a)(b)?(c)/.exec("ac");
        var expArr = ["ac", "a", undefined, "c"];
        for (var i = 0; i < 4; i++) {
          if (eq(m![i], expArr[i]) !== 1) return 100 + i;
        }
        return 1;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(1);
  });

  it("unmatched capture group is undefined, matched ones compare by content", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var m = /(a)(b)?(c)/.exec("ac");
        if (m === null) return 90;
        if (m.length !== 4) return 91;
        if (m[1] !== "a") return 92;
        if (m[2] !== undefined) return 93;
        if (m[3] !== "c") return 94;
        return 1;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(1);
  });

  it("match result passed to an any[] param element-copies (compareArray harness shape)", async () => {
    const { leaks, main } = await runStandalone(
      `function cmp(actual: any[], expected: any[]): number {
        if (actual.length !== expected.length) return 0;
        for (let i: number = 0; i < actual.length; i++) {
          if (actual[i] !== expected[i]) return 0;
        }
        return 1;
      }
      export function main(): number {
        if (cmp("foo".match(/^foo(?<=foo)$/)!, ["foo"]) !== 1) return 90;
        if (cmp("ac".match(/(a)(b)?(c)/)!, ["ac", "a", undefined, "c"]) !== 1) return 91;
        return 1;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(1);
  });

  it("control: fully-defined string[] element reads/compares are unchanged", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var a = ["x", "y"];
        var s: string = a[1];
        if (s !== "y") return 90;
        if (a[0] === "y") return 91;
        return 1;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(1);
  });

  it("control: one-null-one-value stays strictly unequal through the any/string arm", async () => {
    const { leaks, main } = await runStandalone(
      `function eq(actual: any, expected: string): number {
        return actual === expected ? 1 : 0;
      }
      export function main(): number {
        var a = ["x", undefined];
        if (eq("x", a[1]) !== 0) return 90;
        if (eq(a[1], "x") !== 0) return 91;
        if (eq("x", a[0]) !== 1) return 92;
        return 1;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(1);
  });
});

describe("#2161 B2 — split undefined separator / limit (§22.1.3.23)", () => {
  it("s.split() returns [S]", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var r = "abc".split();
        return r.length === 1 && r[0] === "abc" ? 1 : 0;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(1);
  });

  it("s.split(undefined) returns [S]; s.split(void 0, 0) returns []", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var r = "abc".split(undefined);
        if (r.length !== 1 || r[0] !== "abc") return 90;
        var e = "a b".split(void 0, 0);
        if (e.length !== 0) return 91;
        return 1;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(1);
  });

  it("statically-undefined LIMIT is unbounded for string and regex separators", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var s = "abab".split("a", undefined);
        if (s.length !== 3) return 90;
        var r = "a1b2c".split(/\\d/, void 0);
        if (r.length !== 3 || r[0] !== "a" || r[2] !== "c") return 91;
        return 1;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(1);
  });

  it("control: numeric limits still apply", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var r = "a b c".split(" ", 2);
        return r.length === 2 && r[1] === "b" ? 1 : 0;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(1);
  });
});

describe("#2161 B4 — never-reassigned var/let pattern fold (standalone)", () => {
  it("var-bound pattern in the RegExp(...) call form folds", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var p = "d+";
        var re = RegExp(p, "i");
        return re.test("DD") ? 1 : 0;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(1);
  });

  it("var-bound regex-literal copy-constructor folds (inherits flags)", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var p = /./i;
        var re = new RegExp(p);
        return re.test("X") && re.flags === "i" ? 1 : 0;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(1);
  });

  it("void 0 / never-written uninitialised var flags take the spec default", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var re1 = new RegExp(/[a-b]/g, void 0);
        if (!re1.global) return 90;
        var x;
        var re2 = new RegExp(/\\t/m, x);
        if (!re2.multiline) return 91;
        return 1;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(1);
  });

  it("a ctor-created RegExp is a valid copy source (new RegExp(regObj, 'g'))", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var regObj = new RegExp();
        var re = new RegExp(regObj, "g");
        return re.global ? 1 : 0;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(1);
  });

  it("diamond concat chains fold (same binding referenced twice)", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var a = "[^-]*-";
        var b = a + "([^-]" + a + ")*-";
        var re = new RegExp(b);
        return re.test("xx--") ? 1 : 0;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(1);
  });

  it("guard: a reassigned var is NOT mis-folded to its initial value", async () => {
    // p is reassigned, so the static fold must decline and the runtime compiler
    // must observe the final value rather than silently retaining "a".
    const r = await compile(
      `export function main(): number {
        var p = "a";
        p = "b";
        var re = new RegExp(p);
        return re.test("b") ? 1 : 0;
      }`,
      { target: "standalone" },
    );
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const main = instance.exports.main as () => unknown;
    expect(main()).toBe(1);
  });
});
