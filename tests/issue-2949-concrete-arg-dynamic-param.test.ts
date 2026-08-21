// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2949 — a CONCRETE argument at a dynamic callee-parameter position.
//
// The dyn-use move-only scan runs over the WHOLE body of any function that owns
// a dynamic binding, and it checked every argument of every direct call against
// the callee's parameter kind. A concrete argument reaching a dynamic parameter
// was rejected outright, so a function was demoted for an argument that has
// nothing to do with the dynamic binding that put it under the scan.
//
// The direct-call lowering already crosses that boundary with the canonical
// tag-aware boxer, so the scan now admits exactly the operand family that boxer
// accepts, and declines the rest BEFORE the claim rather than withdrawing after
// it.
//
// The fixture is Acorn's exact shape: `isIdentifierStart(code, astral)` has a
// projected-f64 `code` and a dynamic `astral` (some call sites omit the second
// argument), and passes its concrete `code` to a helper whose own parameter is
// dynamic. The two RegExp identifier predicates were held back only by the
// call-graph closure over that helper.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const IDENTIFIER_FAMILY = `
function isSpecialCode(value) {
  if (value === 36) { return true }
  if (value === 95) { return true }
  return false
}

function isIdentifierStart(code, astral) {
  if (code < 65) { return isSpecialCode(code) }
  if (code < 91) { return true }
  if (code < 97) { return isSpecialCode(code) }
  if (code < 123) { return true }
  if (astral === false) { return false }
  return isSpecialCode(code)
}

function isRegExpIdentifierStart(ch) {
  return isIdentifierStart(ch, true) || ch === 0x24 || ch === 0x5F
}

// A closure call site that omits the second argument. This is what keeps
// \`astral\` dynamic rather than boolean — Acorn reaches the same state through
// its prototype-method call sites.
var scanner = function (code) {
  return isIdentifierStart(code) ? 1 : 0;
};

export function runScanner(code: number): number {
  return scanner(code);
}

export function classifySpecial(value: any): number {
  return isSpecialCode(value) ? 1 : 0;
}

export function classify(code: number): number {
  let flags = 0;
  if (isIdentifierStart(code, true)) flags += 1;
  if (isIdentifierStart(code, false)) flags += 2;
  if (isRegExpIdentifierStart(code)) flags += 4;
  return flags;
}
`;

const FAMILY = ["isSpecialCode", "isIdentifierStart", "isRegExpIdentifierStart", "classify"];

async function compileFixture(source: string, target: "gc" | "standalone", fileName: string) {
  const result = await compile(source, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    fileName,
    target,
    trackIrOutcomes: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

describe("#2949 concrete argument at a dynamic callee parameter", () => {
  it.each(["gc", "standalone"] as const)("claims the whole identifier family on the %s target", async (target) => {
    const result = await compileFixture(IDENTIFIER_FAMILY, target, "issue-2949-concrete-arg-dynamic-param.ts");

    expect(result.irCompiledFuncs, JSON.stringify(result.irOutcomes, null, 2)).toEqual(expect.arrayContaining(FAMILY));
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps the identifier predicates value-correct across the boxed argument boundary", async () => {
    const result = await compileFixture(IDENTIFIER_FAMILY, "gc", "issue-2949-concrete-arg-runtime.ts");
    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
    const classify = instance.exports.classify as (code: number) => number;

    // '$' and '_' are identifier starts through the boxed helper, with and
    // without the astral flag, and both satisfy the RegExp predicate.
    expect(classify(0x24)).toBe(1 + 2 + 4);
    expect(classify(0x5f)).toBe(1 + 2 + 4);
    // 'a' takes the plain `code < 123` arm.
    expect(classify(0x61)).toBe(1 + 2 + 4);
    // '5' and '-' reach the helper and are refused by it.
    expect(classify(0x35)).toBe(0);
    expect(classify(0x2d)).toBe(0);
  });

  it("declines an argument the canonical boxer cannot tag before the claim, not after it", async () => {
    // `null` has no sound carrier tag in this slice. The function must stay on
    // the legacy path with its pre-claim rejection intact — never claim and
    // then withdraw.
    const result = await compileFixture(
      IDENTIFIER_FAMILY.replace("  return isSpecialCode(code)\n}", "  return isSpecialCode(null)\n}"),
      "gc",
      "issue-2949-unboxable-arg.ts",
    );

    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irOutcomes?.find((outcome) => outcome.displayName === "isIdentifierStart")).toMatchObject({
      kind: "unsupported",
      stage: "select",
      code: "param-type-not-resolvable",
      irBodyEmitted: false,
      legacyBodyEmitted: true,
    });
  });
});
