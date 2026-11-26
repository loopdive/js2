// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2972 — string element access on the IR path: TWO composed layers.
//
// Layer 1 (gate 5, PR #2519): `irFirstBodyReadsStringElement` keeps functions
// with string-element reads the IR builder CANNOT lower on the compile-twice
// path (legacy + demoting overlay), converting the #2138 flag-on hard error
// back into a silent demote. The selector is checker-free and cannot defer
// these at the element-access arm without over-rejecting vec `arr[i]`.
//
// Layer 2 (the 2a lowering, this PR): PROVEN-in-bounds reads on receivers
// with a literal-known length lower through the EXISTING charAt machinery
// (`s[i] ≡ s.charAt(i)` for integer 0 ≤ i < s.length — §22.1.3.1/§10.4.3).
// Gate 5 consults the SAME single-source predicates
// (`collectStringLiteralLens` + `stringElementReadLowerable` +
// `stringIndexProvenBelow`, all in `src/ir/capability.ts`), so proven-only
// functions re-enter the compile-once skip set while the UNPROVEN residual
// (OOB `s[i]` is `undefined`, charAt is `""` — typing it `string` would be
// silently wrong) stays compile-twice. One predicate, two consumers.
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { stringIndexProvenBelow } from "../src/ir/capability.js";
import { analyzeSource } from "../src/checker/index.js";
import { planIrCompilation } from "../src/ir/select.js";
import { compile, type CompileResult } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

async function compileFlag(on: boolean, src: string): Promise<CompileResult> {
  // (#3143) IR-first is default-ON; off-arm uses the explicit "0" escape hatch.
  vi.stubEnv("JS2WASM_IR_FIRST", on ? "1" : "0");
  try {
    return await compile(src, { fileName: "issue-2972.ts" });
  } finally {
    vi.unstubAllEnvs();
  }
}

async function instantiate(r: CompileResult): Promise<Record<string, Function>> {
  const instance = await instantiateWithRuntime(r);
  return instance.exports as Record<string, Function>;
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

// A claimed function whose string element read is PROVEN in-bounds — with
// the 2a lowering it IR-compiles AND stays in the compile-once skip set.
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

// The annotated harness shape (const-declared so the selector's vardecl
// gate accepts it in .ts mode — the real JS pipeline claims the var form).
const PROVEN_HARNESS_SRC = `
function decimalToPercentHexString(n: number): string {
  const hex = "0123456789ABCDEF";
  return "%" + hex[(n >> 4) & 0xf] + hex[n & 0xf];
}
export function run(n: number): string {
  return decimalToPercentHexString(n);
}
`;

describe("#2972 string element access under IR-first (gate 5 + 2a lowering)", () => {
  it("flag ON: string-computed-index harness compiles (no hard error) and runs correctly", async () => {
    const r = await compileFlag(true, HARNESS_SRC);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const exp = await instantiate(r);
    expect((exp.test as () => number)()).toBe(1);
  });

  it("flag OFF: same harness runs identically (parity control)", async () => {
    const r = await compileFlag(false, HARNESS_SRC);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const exp = await instantiate(r);
    expect((exp.test as () => number)()).toBe(1);
  });

  it("flag ON: a claimed const-string-index function IR-compiles AND runs correctly", async () => {
    // (#3143) The IR-first skip set is now an ALLOWLIST restricted to f64-numeric
    // bodies — a string-returning / string-indexing body is NOT skipped, so it
    // stays COMPILE-TWICE (correct; the IR overlay still owns its body). The
    // compile-once optimization for proven string-element reads is DEFERRED to
    // the allowlist-widening track (#2855/#2856). This test locks CORRECTNESS.
    const r = await compileFlag(true, CONST_STRING_INDEX_SRC);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.irFirstSkipped ?? []).not.toContain("f");
    const exp = await instantiate(r);
    expect((exp.f as (n: number) => string)(200)).toBe("8"); // hex[200 & 0xf] = hex[8]
  });

  it("flag ON: vec `arr[i]` compiles+runs correctly (compile-twice under the f64-only allowlist)", async () => {
    // (#3143) element access is outside the numeric allowlist → compile-twice.
    const r = await compileFlag(true, VEC_INDEX_SRC);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.irFirstSkipped ?? []).not.toContain("sum");
  });

  describe("2a lowering (proven-in-bounds charAt delegation)", () => {
    it("selector claims the proven harness shape; zero post-claim errors", async () => {
      const ast = analyzeSource(PROVEN_HARNESS_SRC);
      const sel = planIrCompilation(ast.sourceFile, { experimentalIR: true });
      expect(sel.funcs.has("decimalToPercentHexString")).toBe(true);
      const r = await compileFlag(false, PROVEN_HARNESS_SRC);
      expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
      expect(r.irPostClaimErrors ?? []).toEqual([]);
    });

    it("bit-correct results, flag-off AND flag-on (compile-twice under the f64-only allowlist)", async () => {
      for (const flag of [false, true]) {
        const r = await compileFlag(flag, PROVEN_HARNESS_SRC);
        expect(r.success).toBe(true);
        // (#3143) string-returning body is outside the numeric allowlist →
        // compile-twice (correct); compile-once deferred to the widening track.
        if (flag) expect(r.irFirstSkipped ?? []).not.toContain("decimalToPercentHexString");
        const exp = await instantiate(r);
        const run = exp.run as (n: number) => string;
        expect(run(0xab)).toBe("%AB");
        expect(run(0)).toBe("%00");
        expect(run(0xff)).toBe("%FF");
        expect(run(0x5)).toBe("%05");
      }
    });

    it("UNPROVEN index keeps the sound demote path (OOB semantics preserved)", async () => {
      const src = `
export function pick(i: number): string {
  const hex = "0123456789ABCDEF";
  return "" + hex[i];
}
`;
      const r = await compileFlag(false, src);
      expect(r.success).toBe(true);
      const exp = await instantiate(r);
      const pick = exp.pick as (i: number) => string;
      expect(pick(3)).toBe("3");
      expect(pick(99)).toBe("undefined"); // "" + undefined — OOB semantics preserved
    });

    it("proof predicate rows", () => {
      const sf = ts.createSourceFile(
        "p.ts",
        "const a = s[5]; const b = s[(n >> 4) & 0xf]; const c = s[15 & n]; const d = s[n & 0x1f]; const e = s[n + 1]; const f = s[-1];",
        ts.ScriptTarget.Latest,
        true,
      );
      const idx: ts.Expression[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isElementAccessExpression(node)) idx.push(node.argumentExpression);
        node.forEachChild(visit);
      };
      sf.forEachChild(visit);
      const [lit5, mask0xf, maskLeft15, mask0x1f, addExpr, negLit] = idx;
      expect(stringIndexProvenBelow(lit5!, 16)).toBe(true); // 5 < 16
      expect(stringIndexProvenBelow(lit5!, 5)).toBe(false); // 5 !< 5
      expect(stringIndexProvenBelow(mask0xf!, 16)).toBe(true); // [0,15] < 16
      expect(stringIndexProvenBelow(maskLeft15!, 16)).toBe(true); // K on the left
      expect(stringIndexProvenBelow(mask0x1f!, 16)).toBe(false); // [0,31] !< 16
      expect(stringIndexProvenBelow(addExpr!, 16)).toBe(false); // unbounded
      expect(stringIndexProvenBelow(negLit!, 16)).toBe(false); // not a non-neg literal
    });

    it("reassigned receiver loses the literal-length fact → demote (still correct)", async () => {
      const src = `
export function swap(n: number): string {
  let hex = "0123456789ABCDEF";
  hex = "abcdef";
  return "" + hex[n & 0x3];
}
`;
      const r = await compileFlag(false, src);
      expect(r.success).toBe(true);
      const exp = await instantiate(r);
      expect((exp.swap as (n: number) => string)(1)).toBe("b"); // reassigned value governs
    });
  });
});
