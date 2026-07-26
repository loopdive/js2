// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2161 — standalone `new RegExp(...)` with a **compile-time-constant** pattern.
 *
 * The standalone native RegExp engine prefers compiling known patterns to
 * bytecode at compile time and routes genuinely runtime strings through its
 * bounded in-module compiler. The constructor's static-pattern
 * recovery used a helper (`staticStringValue`) that only accepted a bare string
 * literal — so patterns that ARE compile-time-constant and CAN be lowered to the
 * native engine were rejected and lowered to a placeholder that **runtime-trapped**:
 *
 *   - `new RegExp("a" + "b")`        — string-literal concatenation,
 *   - `const p = "ab"; new RegExp(p)` — `const`-bound literal,
 *   - `new RegExp(/ab/g)` / `new RegExp(/ab/, "i")` — §22.2.3.1 copy-constructor.
 *
 * This slice folds those constants (`staticConstStringValue`) and handles the
 * regex-literal copy form (`staticRegExpLiteralCopy`), routing them to the
 * existing native `compileStandaloneRegExpPattern`. Zero new host imports, zero
 * substrate dependency, behaviour-preserving for every existing static form. A
 * genuinely-dynamic pattern (function param, `let`, reassigned binding) is NOT
 * folded and retains its runtime value.
 *
 * Spec: ECMA-262 §22.2.3.1 RegExp(pattern, flags) — when pattern is a RegExp,
 * inherit `[[OriginalFlags]]` if flags is `undefined`, else use flags.
 *
 * Still open under #2161 (NOT this slice): `RegExp.prototype` reflection
 * (#2175-gated builtin-prototype-object substrate) and fully dynamic/`any`-typed
 * regex receiver generalisation.
 */
async function runStandalone(src: string): Promise<{ leaks: string[]; main: () => unknown }> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const leaks = r.imports.map((i) => `${i.module}::${i.name}`).filter((l) => !l.startsWith("wasm:js-string::"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return { leaks, main: instance.exports.main as () => unknown };
}

describe("#2161 const-foldable new RegExp() patterns (standalone)", () => {
  it("string-literal concatenation pattern compiles natively", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number { const re = new RegExp("a" + "b", "g"); return "abab".match(re)!.length; }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(2);
  });

  it("const-bound literal pattern compiles natively", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number { const p = "ab"; const re = new RegExp(p, "g"); return "abab".match(re)!.length; }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(2);
  });

  it("const-bound + concat (chained fold) pattern compiles natively", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number { const a = "a"; const re = new RegExp(a + "b", "g"); return "abab".match(re)!.length; }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(2);
  });

  it("regex-literal copy-constructor inherits the literal's flags", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number { const re = new RegExp(/ab/g); return "abab".match(re)!.length; }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(2);
  });

  it("regex-literal copy-constructor overrides flags when provided (§22.2.3.1)", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number { const re = new RegExp(/AB/, "gi"); return "abAB".match(re)!.length; }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(2);
  });

  it("folds the source getter of a static RegExp without host imports", async () => {
    const { leaks, main } = await runStandalone(
      String.raw`export function main(): number { const lineBreak = /\r\n?|\n|\u2028|\u2029/; const re = new RegExp(lineBreak.source, "g"); return "a\r\nb\nc".match(re)!.length; }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(2);
  });

  it("does not recurse while resolving a self-referential source binding", async () => {
    const r = await compile(
      `let re: RegExp; re = new RegExp(re.source); export function main(): number { return 1; }`,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  });

  it("const-folded ctor binding flows to a downstream re.test", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number { const re = new RegExp("a" + "b"); return re.test("xabx") ? 7 : 3; }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(7);
  });

  it("control: static string-literal pattern still works (no regression)", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number { const re = new RegExp("ab", "g"); return "abab".match(re)!.length; }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(2);
  });

  it("regex literal (no ctor) still works (no regression)", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number { return "abab".match(/ab/g)!.length; }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(2);
  });

  it("routes a genuinely-dynamic param through the runtime compiler", async () => {
    const r = await compile(
      `function mk(p: string): RegExp { return new RegExp(p, "g"); } export function main(): number { return "abab".match(mk("ab"))!.length; }`,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.main as () => unknown)()).toBe(2);
  });
});
