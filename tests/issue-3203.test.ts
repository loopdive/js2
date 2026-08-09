// #3203 — IR-first allowlist widen: f64 -> f64 + boolean.
//
// The #3143 flip's v1 allowlist skipped legacy body emission only for pure-f64
// functions. This widens the proven-lowerable subset to add a `bool` value
// domain (bool params/returns/locals/literals, logical ops, comparisons, bool
// equality, bool ternary), tracked structurally so number-vs-bool operand mixes
// stay COMPILE-TWICE (safe-by-construction: a missed shape is never a
// skipped-slot hard error). This test locks:
//   1. The predicate accepts bool-domain bodies when the caller passes bool
//      param/return domains, and rejects cross-domain mixes.
//   2. The f64-only defaults (2-arg call) are unchanged (parity with #3143).
//   3. End-to-end: a bool-predicate program compiles with ZERO hard errors
//      under the IR-first default, runs correctly, and matches the escape-hatch
//      legacy order (behavior-preserving).
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { irFirstBodyIsProvenLowerable, type ValueDomain } from "../src/codegen/ir-first-gate.js";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

function fnDecl(src: string): ts.FunctionDeclaration {
  const sf = ts.createSourceFile("t.ts", src, ts.ScriptTarget.Latest, true);
  const fn = sf.statements.find(ts.isFunctionDeclaration);
  if (!fn) throw new Error("no function declaration in source");
  return fn;
}

async function instantiate(r: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
    instance.exports as Record<string, Function>,
  );
  return instance.exports as Record<string, Function>;
}

const NO_CALLS = new Map<string, number>();

describe("#3203 — irFirstBodyIsProvenLowerable bool-domain widen", () => {
  // [label, src, paramDomains, returnDomain]
  it.each<[string, string, ValueDomain[], ValueDomain | "void"]>([
    [
      "f64 param -> bool return (predicate)",
      `function isPos(n: number): boolean { return n > 0; }`,
      ["number"],
      "bool",
    ],
    [
      "bool params, logical && / ||",
      `function both(a: boolean, b: boolean): boolean { return a && b || !a; }`,
      ["bool", "bool"],
      "bool",
    ],
    ["bool literal return", `function t(): boolean { return true; }`, [], "bool"],
    [
      "bool local from comparison, used in condition",
      `function f(n: number): number { const big = n > 10; if (big) return 1; return 0; }`,
      ["number"],
      "number",
    ],
    [
      "bool ternary branches",
      `function pick(p: boolean, a: boolean): boolean { return p ? a : false; }`,
      ["bool", "bool"],
      "bool",
    ],
    [
      "bool equality (matched domain)",
      `function eq(a: boolean, b: boolean): boolean { return a === b; }`,
      ["bool", "bool"],
      "bool",
    ],
    [
      "bool local mutation via =",
      `function f(n: number): boolean { let r = false; if (n > 0) { r = true; } return r; }`,
      ["number"],
      "bool",
    ],
  ])("accepts (skip-eligible): %s", (_label, src, pd, rd) => {
    expect(irFirstBodyIsProvenLowerable(fnDecl(src), NO_CALLS, pd, rd)).toBe(true);
  });

  it.each<[string, string, ValueDomain[], ValueDomain | "void"]>([
    // number-vs-bool operand mixes and domain mismatches — stay compile-twice.
    [
      "number + bool (arith over mixed domain)",
      `function f(a: number, b: boolean): number { return a + (b as unknown as number); }`,
      ["number", "bool"],
      "number",
    ],
    ["bool operand in numeric arithmetic", `function f(a: boolean): number { return a * 2; }`, ["bool"], "number"],
    [
      "return domain mismatch (bool body, number return)",
      `function f(a: boolean, b: boolean): number { return a && b; }`,
      ["bool", "bool"],
      "number",
    ],
    [
      "equality across domains (number === bool)",
      `function f(n: number, b: boolean): boolean { return n === b; }`,
      ["number", "bool"],
      "bool",
    ],
    [
      "relational over bools",
      `function f(a: boolean, b: boolean): boolean { return a < b; }`,
      ["bool", "bool"],
      "bool",
    ],
    [
      "ternary branches differ in domain",
      `function f(p: boolean, n: number): number { return p ? n : true; }`,
      ["bool", "number"],
      "number",
    ],
    ["++ on a bool local", `function f(): boolean { let r = true; r++; return r; }`, [], "bool"],
    ["numeric literal in bool return", `function f(): boolean { return 1; }`, [], "bool"],
  ])("rejects (compile-twice): %s", (_label, src, pd, rd) => {
    expect(irFirstBodyIsProvenLowerable(fnDecl(src), NO_CALLS, pd, rd)).toBe(false);
  });

  it("f64-only defaults unchanged (2-arg call, parity with #3143)", () => {
    expect(
      irFirstBodyIsProvenLowerable(fnDecl(`function add(a: number, b: number): number { return a + b; }`), NO_CALLS),
    ).toBe(true);
    // a bool return with the default number returnDomain is a mismatch -> reject
    expect(irFirstBodyIsProvenLowerable(fnDecl(`function f(): boolean { return true; }`), NO_CALLS)).toBe(false);
  });
});

describe("#3203 — end-to-end bool predicates under IR-first default", () => {
  // All four are within the widened subset and are leaf/exported → the IR-first
  // default SKIPS every one (validated below). `classifyNum` keeps a pure-number
  // body with bool *conditions* (already lowerable pre-widen); the three
  // predicates exercise the new bool params/returns/logic paths. Deliberately
  // avoids the `const b = boolReturningCall(); if (b && …)` shape, which trips a
  // PRE-EXISTING from-ast overlay verify bug (unrelated to this widen — it is
  // never skipped and reproduces with JS2WASM_IR_FIRST=0).
  const SRC = `
    export function isEven(n: number): boolean { return n % 2 === 0; }
    export function inRange(n: number): boolean { return n > 0 && n < 100; }
    export function nand(a: boolean, b: boolean): boolean { return !(a && b); }
    export function classifyNum(n: number): number {
      let c = 0;
      if (n % 2 === 0) c = c + 1;
      if (n > 100) c = c + 2;
      return c;
    }
  `;

  // Wasm surfaces `boolean` returns as i32 0/1.
  const checkAll = (e: Record<string, Function>): void => {
    expect(Boolean(e.isEven(4))).toBe(true);
    expect(Boolean(e.isEven(3))).toBe(false);
    expect(Boolean(e.inRange(50))).toBe(true);
    expect(Boolean(e.inRange(200))).toBe(false);
    expect(Boolean(e.nand(1, 1))).toBe(false);
    expect(Boolean(e.nand(1, 0))).toBe(true);
    expect(e.classifyNum(200)).toBe(3); // even + >100
    expect(e.classifyNum(3)).toBe(0);
  };

  it("SKIPS the bool functions under the IR-first default, ZERO hard errors, VALID binary", async () => {
    const r = await compile(SRC, { fileName: "bool.ts", experimentalIR: true });
    const hard = (r.errors ?? []).filter((e) => e.severity === "error");
    expect(hard.map((e) => e.message)).toEqual([]);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    // The widen's whole point: these legacy bodies are skipped (IR owns them).
    expect([...(r.irFirstSkipped ?? [])].sort()).toEqual(["classifyNum", "inRange", "isEven", "nand"]);
  });

  it("runs correctly under the IR-first default", async () => {
    const r = await compile(SRC, { fileName: "bool.ts", experimentalIR: true });
    checkAll(await instantiate(r));
  });

  it("parity: escape-hatch legacy order (JS2WASM_IR_FIRST=0) gives the same results", async () => {
    const prev = process.env.JS2WASM_IR_FIRST;
    process.env.JS2WASM_IR_FIRST = "0";
    try {
      const r = await compile(SRC, { fileName: "bool.ts", experimentalIR: true });
      const hard = (r.errors ?? []).filter((e) => e.severity === "error");
      expect(hard.map((e) => e.message)).toEqual([]);
      checkAll(await instantiate(r));
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_FIRST");
      else process.env.JS2WASM_IR_FIRST = prev;
    }
  });
});
