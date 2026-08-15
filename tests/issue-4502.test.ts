// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4502) A bare `throw new Error(...)` reached from a CLAIMED unit classifies
 * as `invariant` / `unexpected-internal-throw`, which #3341/#3519 hard-error.
 * So a documented capability gap in `src/ir/from-ast.ts` became a HARD compile
 * failure — an EMPTY BINARY — even though `legacyBodyEmitted: true` was sitting
 * right there and the legacy backend lowers the shape fine.
 *
 * The same defect was found and fixed one site at a time four times on
 * 2026-08-15 (#4578, #4486, #4487, plus two observed sites), each time only
 * because an adoption WIDENED the selector's claim set and made a
 * previously-unreachable arm reachable. #4502 swept the whole surface: every
 * capability gap now throws a typed `IrUnsupportedError` and demotes to legacy;
 * only genuine producer-promise violations stay bare.
 *
 * Every shape below was measured as FAILING on the unmodified base
 * (`fce375e5`), via a file-copy A/B in this worktree: `success: false`,
 * `invariant/build/unexpected-internal-throw`, zero-byte binary. 25 of these 26
 * assertions fail when `src/ir/from-ast.ts` is reverted to that base.
 *
 * The assertions are deliberately about OUTCOMES — does it build, is the
 * recorded outcome the TYPED one, does it compute the answer `node` computes —
 * because an instruction-mix assertion cannot see this bug: the failure mode is
 * that there is no output at all.
 *
 * Every shape is parameterless ON PURPOSE. An externref-typed parameter cannot
 * be supplied from the test host ("type incompatibility when transforming
 * from/to JS"), which would force the runtime assertion into a try/catch escape
 * hatch and quietly stop checking the thing that matters.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import type { IrObservedOutcome } from "../src/ir/outcomes.js";

async function build(source: string, target: "standalone" | "gc" = "standalone") {
  return await compile(source, {
    fileName: "t.ts",
    skipSemanticDiagnostics: true,
    target,
    experimentalIR: true,
    trackIrOutcomes: true,
  });
}

function outcomeCodes(outcomes: readonly IrObservedOutcome[] | undefined): string[] {
  return (outcomes ?? [])
    .filter((o) => o.kind !== "emitted")
    .map((o) => `${o.kind}/${o.stage}/${"code" in o ? o.code : "?"}`);
}

/**
 * Legal JS the IR CLAIMS and then cannot lower. `expected` is what the same
 * computation produces under `node`.
 */
const CONVERTED: ReadonlyArray<{
  name: string;
  source: string;
  expected: number;
  code: string;
}> = [
  {
    name: "ternary with mixed branch types (lowerConditional)",
    source: `export function main(): number { const c = true; const x = c ? 1 : "s"; return typeof x === "number" ? 1 : 0; }`,
    expected: 1,
    code: "unsupported/build/operand-coercion-unsupported",
  },
  {
    name: "`??` on an f64 lhs (lowerNullish)",
    source: `export function main(): number { const x = 3; return (x as any) ?? 5; }`,
    expected: 3,
    code: "unsupported/build/nullish-value-unsupported",
  },
  {
    name: "unary `!` on an any-carried non-empty string (lowerPrefixUnary)",
    source: `export function main(): number { const s: string = "a"; return !(s as any) ? 1 : 0; }`,
    expected: 0,
    code: "unsupported/build/operand-coercion-unsupported",
  },
  {
    // The truthiness arm of the same site, so a lowering that always answered
    // one constant could not pass.
    name: "unary `!` on an any-carried EMPTY string (lowerPrefixUnary)",
    source: `export function main(): number { const s: string = ""; return !(s as any) ? 1 : 0; }`,
    expected: 1,
    code: "unsupported/build/operand-coercion-unsupported",
  },
  {
    name: "property read on a number receiver (lowerPropertyAccess)",
    source: `export function main(): number { const n = 1; return (n as any).foo === undefined ? 0 : 1; }`,
    expected: 0,
    code: "unsupported/build/property-access-unsupported",
  },
  {
    name: "property write of a mismatched type (lowerPropertyAssignment)",
    source: `export function main(): number { const o = { a: 1 }; (o as any).a = "s"; return 7; }`,
    expected: 7,
    code: "unsupported/build/property-write-unsupported",
  },
  {
    name: "array literal of objects (lowerArrayLiteral)",
    source: `export function main(): number { const a = [{ p: 1 }, { p: 2 }]; return a.length; }`,
    expected: 2,
    code: "unsupported/build/array-representation-unsupported",
  },
];

describe("#4502 — a claimed unit's capability gap demotes to legacy instead of failing the build", () => {
  for (const { name, source, code, expected } of CONVERTED) {
    it(`compiles to a non-empty binary: ${name}`, async () => {
      const r = await build(source);
      expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
      expect(r.binary.length, "an empty binary is the #4502 failure mode").toBeGreaterThan(0);
    });

    it(`records the TYPED unsupported outcome, not unexpected-internal-throw: ${name}`, async () => {
      const r = await build(source);
      const codes = outcomeCodes(r.irOutcomes);
      // The precise discriminant of the bug: an untyped invariant means the
      // demote contract silently became a hard compile error.
      expect(codes.join(","), `outcomes: ${codes.join(", ")}`).not.toContain("unexpected-internal-throw");
      expect(codes).toContain(code);
    });

    it(`reports no hard Codegen error: ${name}`, async () => {
      const r = await build(source);
      // A demotion may legitimately surface as a WARNING; what must not appear
      // is the hard-error prefix `formatIrPathFallbackDiagnostic` adds for
      // `kind === "invariant"`.
      expect(r.errors.filter((e) => e.severity === "error")).toEqual([]);
    });

    it(`computes the JS answer through the legacy body: ${name}`, async () => {
      const r = await build(source);
      expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
      const instance = await WebAssembly.instantiate(await WebAssembly.compile(r.binary), {});
      const main = (instance.exports as { main: () => unknown }).main;
      expect(typeof main).toBe("function");
      expect(Number(main())).toBe(expected);
    });
  }

  it("emits a non-empty binary on the gc target too, not just standalone", async () => {
    for (const { name, source } of CONVERTED) {
      const r = await build(source, "gc");
      expect(r.success, `${name} @gc: ${r.errors.map((e) => e.message).join("; ")}`).toBe(true);
      expect(r.binary.length, `${name} @gc produced an empty binary`).toBeGreaterThan(0);
    }
  });
});
