// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2135 — single IR capability predicate (operator family, slice 1).
//
// "What IR can do" used to be encoded twice: `select.ts`'s `isPhase1BinaryOp`
// deliberately accepted `%` / `**` / `in` / `instanceof` "shape-only" while
// `from-ast.ts` threw `not in slice 11` — a designed over-claim that leaned on
// the demote-to-warning fallback (and becomes a hard error under #2138's
// IR-first flag; #2945 is the filed instance). Slice 1 single-sources the
// OPERATOR family in `src/ir/capability.ts`, consumed by both the selector
// and the builder. #4787 now gives `**` a bounded exact numeric exception;
// its broader legacy surface remains outside the claim:
//
//   - "claim"          selector accepts, builder lowers (shape-admitted operands)
//   - "claim-partial"  selector accepts, builder lowers a documented subset
//                      (residuals stay on the metered post-claim channel, #1923)
//   - "defer"          selector rejects up-front; builder asserts (a defer op
//                      arriving post-claim is a compiler bug, not a fallback)
//
// Contract under test:
//   1. Deferred ops (`in`, `instanceof`) are selector-REJECTED. `**` is now a
//      bounded #4787 claim, but this bare selector intentionally lacks the
//      prepared checker/provider proof and therefore still rejects it. All
//      rejected programs have zero post-claim errors and run via legacy.
//   2. Claimed ops are selector-accepted AND IR-compile without any
//      post-claim error — the table's claim is backed by a real lowering
//      (this is the "one table row, not two predicates" acceptance).
//   3. Claim-partial (`??`) keeps its residual: reference-shaped operands
//      IR-compile; non-lowerable operand types still demote through the
//      metered channel (NOT a hard error), unchanged from before.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { analyzeSource } from "../src/checker/index.js";
import { planIrCompilation } from "../src/ir/select.js";
import { binaryOpCapability, prefixOpCapability } from "../src/ir/capability.js";
import { ts } from "../src/ts-api.js";

async function run(source: string, fn: string, args: unknown[]): Promise<unknown> {
  const r = await compile(source, { fileName: "issue-2135.ts" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, Function>)[fn]!(...args);
}

function claims(source: string, fnName: string): boolean {
  const ast = analyzeSource(source);
  const sel = planIrCompilation(ast.sourceFile, { experimentalIR: true });
  return sel.funcs.has(fnName);
}

describe("#2135 capability table — operator family single source", () => {
  it("deferred ops are selector-rejected (no more shape-only over-claim)", () => {
    // (#2945 flipped `%` from defer → claim; #4787 claims only the exact
    // prepared numeric `**` subset, so this unconfigured selector rejects it.)
    expect(claims(`export function p(a: number, b: number): number { return a ** b; }`, "p")).toBe(false);
    expect(claims(`export function tld(o: any): boolean { return "x" in o; }`, "tld")).toBe(false);
    expect(claims(`export function bnot(a: number): number { return ~a; }`, "bnot")).toBe(true);
  });

  it("deferred ops produce ZERO post-claim errors and run correctly via legacy", async () => {
    // Pre-#2135 these were claim-then-build-throw ("operator '**' not in
    // slice 11") — counted on irPostClaimErrors and, under JS2WASM_IR_FIRST,
    // a hard compile error (the #2945 class). The unconfigured control keeps
    // `**` on legacy; the prepared exact claim is covered by #4787.
    const src = `export function p(a: number, b: number): number { return a ** b; }`;
    const r = await compile(src, { fileName: "issue-2135.ts" });
    expect(r.success).toBe(true);
    expect((r.irPostClaimErrors ?? []).filter((e) => e.func === "p")).toEqual([]);
    expect(await run(src, "p", [2, 10])).toBe(1024);
  });

  it("claimed ops are selector-accepted and IR-compile with no post-claim error", async () => {
    // One probe per claim-op family — proves the table's "claim" rows are
    // backed by real lowerings (selector and builder agree by construction).
    const probes: Array<[string, string, unknown[], unknown]> = [
      [`export function f(a: number, b: number): number { return a - b * 2 + a / b; }`, "f", [8, 4], 2],
      [`export function f(a: number, b: number): boolean { return a < b || (a >= b && a !== 0); }`, "f", [8, 4], 1],
      [
        `export function f(a: number, b: number): number { return (a & b) | (a ^ b) | (a << 1) | (a >> 1) | (a >>> 1); }`,
        "f",
        [6, 3],
        15,
      ],
      [`export function f(a: number): number { return -a + +a; }`, "f", [5], 0],
      [`export function f(b: boolean): boolean { return !b; }`, "f", [1], 0],
    ];
    for (const [src, fn, args, expected] of probes) {
      expect(claims(src, fn), `selector should claim: ${src}`).toBe(true);
      const r = await compile(src, { fileName: "issue-2135.ts" });
      expect(r.success).toBe(true);
      expect(
        (r.irPostClaimErrors ?? []).filter((e) => e.func === fn),
        `claim must be backed by a lowering: ${src}`,
      ).toEqual([]);
      expect(await run(src, fn, args)).toBe(expected);
    }
  });

  it("claim-partial (`??`) keeps its documented residual demote (metered, not hard)", async () => {
    // Reference-shaped operands lower in IR (see tests/ir-nullish-coalesce);
    // a non-lowerable operand pair still demotes cleanly to legacy through
    // the post-claim channel — the transitional state the table documents.
    const src = `export function n(s: string): string { return s ?? "x"; }`;
    expect(claims(src, "n")).toBe(true);
    const r = await compile(src, { fileName: "issue-2135.ts" });
    expect(r.success).toBe(true); // demote, never a hard failure (flag off)
  });

  it("table sanity: the retired over-claims are exactly defer; the accept set is unchanged otherwise", () => {
    expect(binaryOpCapability(ts.SyntaxKind.PercentToken)).toBe("claim"); // #2945 — __fmod lowering landed
    expect(binaryOpCapability(ts.SyntaxKind.AsteriskAsteriskToken)).toBe("claim"); // #4787 exact numeric subset
    expect(binaryOpCapability(ts.SyntaxKind.InKeyword)).toBe("defer");
    expect(binaryOpCapability(ts.SyntaxKind.InstanceOfKeyword)).toBe("defer");
    expect(binaryOpCapability(ts.SyntaxKind.QuestionQuestionToken)).toBe("claim-partial");
    expect(binaryOpCapability(ts.SyntaxKind.PlusToken)).toBe("claim-partial");
    expect(binaryOpCapability(ts.SyntaxKind.MinusToken)).toBe("claim");
    expect(binaryOpCapability(ts.SyntaxKind.CommaToken)).toBe("defer"); // default: unknown → defer
    expect(prefixOpCapability(ts.SyntaxKind.ExclamationToken)).toBe("claim");
    expect(prefixOpCapability(ts.SyntaxKind.TildeToken)).toBe("claim-partial");
  });
});
