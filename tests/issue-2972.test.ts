// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2972 — IR selector accepts string element access with a computed index, but
// `from-ast.ts` has no string-element-read lowering (constant OR computed) and
// throws "element access on string with index … not in slice 12". Flag-off that
// throw silently demotes to legacy; flag-on (`JS2WASM_IR_FIRST=1`) a claimed
// function whose lowering throws is promoted to a HARD compile error — turning
// the test262 `decimalToHexString` / `decimalToPercentHexString` harness
// (`hex[(n>>4)&0xf]`) into `pass → compile_error` regressions.
//
// The selector is checker-free (`scope: ReadonlySet<string>`), so it cannot
// distinguish a string receiver from a vec receiver and cannot defer this at the
// element-access arm without over-rejecting vec `arr[i]`. Gate 5 of
// `computeIrFirstSkipSet` (`irFirstBodyReadsStringElement`) therefore keeps any
// string-element-reading function on the compile-twice path (legacy + silently
// demoting overlay) — restoring flag-on/flag-off parity — until an actual
// string-element-read lowering is proven in the IR builder.
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { irFirstBodyReadsStringElement } from "../src/codegen/ir-first-gate.js";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileFlag(on: boolean, src: string): Promise<CompileResult> {
  vi.stubEnv("JS2WASM_IR_FIRST", on ? "1" : "");
  try {
    return await compile(src, { fileName: "issue-2972.ts" });
  } finally {
    vi.unstubAllEnvs();
  }
}

async function instantiate(r: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, Function>;
}

function fnDecl(src: string): ts.FunctionDeclaration {
  const sf = ts.createSourceFile("t.ts", src, ts.ScriptTarget.Latest, true);
  const fn = sf.statements.find(ts.isFunctionDeclaration);
  if (!fn) throw new Error("no function declaration in source");
  return fn;
}

// The exact test262 encoding harness (test262/harness/decimalToHexString.js).
// Both functions index a local `string` variable by a computed index.
const HARNESS_SRC = `
function decimalToHexString(n) {
  var hex = "0123456789ABCDEF";
  n >>>= 0;
  var s = "";
  while (n) { s = hex[n & 0xf] + s; n >>>= 4; }
  while (s.length < 4) { s = "0" + s; }
  return s;
}
function decimalToPercentHexString(n) {
  var hex = "0123456789ABCDEF";
  return "%" + hex[(n >> 4) & 0xf] + hex[n & 0xf];
}
export function test(): number {
  if (decimalToPercentHexString(200) !== "%C8") return 10;
  if (decimalToPercentHexString(0) !== "%00") return 11;
  if (decimalToHexString(65535) !== "FFFF") return 12;
  if (decimalToHexString(43981) !== "ABCD") return 13;
  return 1;
}
`;

// A minimal claimed function whose ONLY unclaimable shape is the string
// element read — with the gate removed this is the exact #2138 hard error.
const CONST_STRING_INDEX_SRC = `
export function f(n: number): string {
  const hex = "0123456789ABCDEF";
  return hex[n & 0xf];
}
`;

// A vec `arr[i]` read (computed index) — must STILL be IR-first-skipped
// (compile-once) flag-on; gate 5 must not touch it.
const VEC_INDEX_SRC = `
export function sum(arr: number[], i: number): number {
  return arr[i] + arr[i + 1];
}
`;

describe("#2972 string element access under IR-first (gate 5)", () => {
  it("flag ON: string-computed-index harness compiles (no hard error) and runs correctly", async () => {
    const r = await compileFlag(true, HARNESS_SRC);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // Kept on the compile-twice path (NOT the IR-first compile-once set).
    expect(r.irFirstSkipped).not.toContain("decimalToHexString");
    expect(r.irFirstSkipped).not.toContain("decimalToPercentHexString");
    const exp = await instantiate(r);
    expect((exp.test as () => number)()).toBe(1);
  });

  it("flag OFF: same harness runs identically (parity control)", async () => {
    const r = await compileFlag(false, HARNESS_SRC);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const exp = await instantiate(r);
    expect((exp.test as () => number)()).toBe(1);
  });

  it("flag ON: a claimed const-string-index function no longer hard-errors", async () => {
    const r = await compileFlag(true, CONST_STRING_INDEX_SRC);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.irFirstSkipped).not.toContain("f");
    const exp = await instantiate(r);
    expect((exp.f as (n: number) => string)(200)).toBe("8"); // hex[200 & 0xf] = hex[8]
  });

  it("flag ON: vec `arr[i]` is unaffected — still IR-first compile-once", async () => {
    const r = await compileFlag(true, VEC_INDEX_SRC);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.irFirstSkipped).toContain("sum");
  });

  describe("irFirstBodyReadsStringElement predicate", () => {
    it.each([
      [
        "var string-literal receiver, computed index",
        `function f(n){ var hex="0123456789ABCDEF"; return "%"+hex[(n>>4)&0xf]+hex[n&0xf]; }`,
      ],
      ["const string-literal receiver, computed index", `function f(n){ const hex="ABCDEF"; return hex[n&1]; }`],
      ["string-typed parameter receiver", `function f(s: string, i: number){ return s[i]; }`],
      ["string-literal receiver in place", `function f(i){ return "abcdef"[i]; }`],
    ])("fires: %s", (_label, src) => {
      expect(irFirstBodyReadsStringElement(fnDecl(src))).toBe(true);
    });

    it.each([
      ["vec (number[]) receiver", `function f(arr: number[], i: number){ return arr[i]; }`],
      ["numeric-var-indexed vec receiver", `function f(a: number[]){ var j=0; return a[j]; }`],
      ["object string-literal key", `function f(o){ return o["k"]; }`],
      ["untyped/any local receiver", `function f(o){ var x = o.thing; return x[0]; }`],
      ["optional element access (out of IR scope anyway)", `function f(s: string, i){ return s?.[i]; }`],
    ])("does not fire: %s", (_label, src) => {
      expect(irFirstBodyReadsStringElement(fnDecl(src))).toBe(false);
    });
  });
});
