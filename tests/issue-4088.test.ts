// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4088 — permanent probe (#2093) for the uncatchable
// `dereferencing a null pointer in __module_init()` trap.
//
// Split out of #3593, which was filed as an
// `Iterator.zip`-over-object-literal-iterators defect that "needs the real
// test262 harness module shape", where hand-written snippets supposedly could
// not reproduce it. Ablation through the real runner refuted every part of
// that — the defect is general array-literal lowering, so it lives under its
// own id rather than behind an Iterator title nobody would search:
//
//   * `assert.throws` is NOT required
//   * the `includes:` harness injection is NOT required
//   * `Iterator.zip` is NOT required — the trap fires from the ARRAY LITERAL
//     alone, with no iterator helper anywhere in the program
//   * a plain `compileAndInstantiate` snippet DOES reproduce it
//
// Measured rule: an array literal traps iff two of its object-literal elements
// have DIFFERENT NON-ZERO member counts. Symmetric (1-then-2 traps exactly as
// 2-then-1 does), independent of member NAMES (2-vs-2 with different names
// passes), and independent of data-vs-method properties. An empty `{}` element
// is exempt.
//
// ⚠ INSTRUMENT NOTE — the first version of this file was VACUOUS and passed all
// nine cases while the defect was live. It called `WebAssembly.instantiate(bin,
// {})`, so every program died at `Import #0 "string_constants"` before running
// and the `not.toBe("trap")` assertions passed trivially. Use
// `compileAndInstantiate`, which builds the real import object, and keep the
// `ok`-returning controls below — they are what prove this file can still tell
// a trap from a pass.
import { describe, expect, it } from "vitest";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

type Verdict = "TRAP" | "ok" | string;

async function moduleInit(body: string): Promise<Verdict> {
  let exports: WebAssembly.Exports;
  try {
    exports = await compileAndInstantiate(`${body}\nexport function test(): number { return 1; }`);
  } catch (e) {
    const m = String((e as Error)?.message ?? e);
    return /null pointer/.test(m) ? "TRAP" : `SETUP-FAILED: ${m.slice(0, 120)}`;
  }
  try {
    (exports as { test: () => number }).test();
    return "ok";
  } catch (e) {
    const m = String((e as Error)?.message ?? e);
    return /null pointer/.test(m) ? "TRAP" : `RUN-THREW: ${m.slice(0, 120)}`;
  }
}

const len2 = (expr: string) => `var arr = ${expr}; if (arr.length !== 2) throw new Error("len");`;

describe("#4088 instrument controls (these must keep discriminating)", () => {
  it("a same-arity heterogeneous array instantiates and runs", async () => {
    // Positive control: proves the harness really runs the program. If this
    // ever reports SETUP-FAILED, every `it.fails` below is meaningless.
    expect(await moduleInit(len2(`[{ a() {}, b() {} }, { c() {}, d() {} }]`))).toBe("ok");
  });

  it("equal member counts with the same names runs", async () => {
    expect(await moduleInit(len2(`[{ a() {}, b() {} }, { a() {}, b() {} }]`))).toBe("ok");
  });

  it("an empty object-literal element is exempt and runs", async () => {
    expect(await moduleInit(len2(`[{ a() {}, b() {} }, {}]`))).toBe("ok");
  });

  it("a single object literal runs", async () => {
    expect(await moduleInit(`var arr = [{ a() {}, b() {} }]; if (arr.length !== 1) throw new Error("len");`)).toBe(
      "ok",
    );
  });
});

// LIVE DEFECT. `it.fails` passes while the body throws, and turns RED the
// moment the trap is fixed — at which point flip these to plain `it`.
describe("#4088 array literal, differing object-literal member counts — LIVE DEFECT", () => {
  it.fails("[{a,b},{c}] — the minimal repro, no Iterator, no Symbol, no harness", async () => {
    expect(await moduleInit(len2(`[{ a() {}, b() {} }, { c() {} }]`))).toBe("ok");
  });

  it.fails("[{c},{a,b}] — reversed; the rule is symmetric", async () => {
    expect(await moduleInit(len2(`[{ c() {} }, { a() {}, b() {} }]`))).toBe("ok");
  });

  it.fails("[{a:1,b:2},{c:3}] — data properties, not methods", async () => {
    expect(await moduleInit(len2(`[{ a: 1, b: 2 }, { c: 3 }]`))).toBe("ok");
  });

  it.fails("3-vs-1 member counts", async () => {
    expect(await moduleInit(len2(`[{ a() {}, b() {}, e() {} }, { c() {} }]`))).toBe("ok");
  });

  it.fails("the original #3593 spelling (the file that surfaced it): [{next,return},{[Symbol.iterator]}]", async () => {
    expect(await moduleInit(len2(`[{ next() {}, return() {} }, { [Symbol.iterator]() {} }]`))).toBe("ok");
  });
});
