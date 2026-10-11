// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6652 — the #6650 return-carrier mismatch, for every callable shape that is
 * NOT a top-level function declaration.
 *
 * A spread-built object literal is an open host `$Object` (an externref,
 * because `objectLiteralSpreadTakesHostPath` / #2804 routes a spread literal in
 * a non-specific contextual position there — a `return` with no annotation has
 * no contextual type). #6650 made the enclosing FUNCTION DECLARATION carry that
 * value on the externref ABI; every other spelling kept the checker-inferred
 * CONCRETE struct as its result ABI, so the emitted return stayed a
 * `ref.test`-guarded downcast that always takes the `ref.null none` arm.
 *
 * Measured on the branch base `78dd538964` (file-copy revert of the three
 * touched files, `.tmp/s71/probes/solo3.mts`):
 *
 * | shape | base |
 * | --- | --- |
 * | arrow | `NaN` |
 * | function expression | `NaN` |
 * | object-literal method | TRAP `illegal cast` |
 * | class method | TRAP `dereferencing a null pointer` |
 * | nested function declaration | TRAP `dereferencing a null pointer` |
 *
 * The fix widens the #6614 pre-pass (`collectAccessorLiteralReturnCarrierTypes`)
 * — which already walks EVERY function-like, not just declarations — from
 * accessor-bearing literals to accessor-or-spread, and shares #6650's
 * comma-expression-aware wrapper peeler with it.
 *
 * NOTE on the object-literal-method case: it is deliberately probed WITHOUT a
 * same-named class method in the same module. That combination emits an
 * INVALID module (`local.set[0] expected type (ref null N), found
 * ref.as_non_null of type (ref M)`) on the base and on the fix alike, with no
 * spread anywhere — an unrelated object-literal-method / class-method name
 * collision, reduced in `.tmp/s71/probes/collide.mts` and recorded as a
 * residual in the issue file.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** name → [declarations, the consumer expression that reads the result] */
const CASES: [name: string, decl: string, read: string][] = [
  // ── the five defect shapes ────────────────────────────────────────────────
  ["arrow", `const m1 = () => { const o = { years: 1, months: 2 }; return { ...o, days: 9 }; };`, `m1().days`],
  ["arrowConciseBody", `const m2 = () => ({ ...MSRC, days: 9 }); const MSRC = { years: 1, months: 2 };`, `m2().days`],
  [
    "functionExpression",
    `const P1 = function () { const o = { years: 1, months: 2 }; return { ...o, days: 9 }; };`,
    `P1().days`,
  ],
  [
    "namedFunctionExpression",
    `const P2 = function mkP2() { const o = { years: 1, months: 2 }; return { ...o, days: 9 }; };`,
    `P2().days`,
  ],
  [
    "objectLiteralMethod",
    `const O1 = { mkO() { const o = { years: 1, months: 2 }; return { ...o, days: 9 }; } };`,
    `O1.mkO().days`,
  ],
  [
    "classMethod",
    `class Q1 { mkQ() { const o = { years: 1, months: 2 }; return { ...o, days: 9 }; } }`,
    `new Q1().mkQ().days`,
  ],
  [
    "nestedFunctionDeclaration",
    `function n0() { function n1() { const o = { years: 1, months: 2 }; return { ...o, days: 9 }; } return n1().days; }`,
    `n0()`,
  ],
  // The minified `@js-temporal/polyfill` writes its date arithmetic as a COMMA
  // expression (`return zr(…), { ...t.date, days: n }`) and uses these shapes
  // for it. #6650 taught the declaration lane to peel a comma; the pre-pass had
  // its own copy of the peeler that did not.
  [
    "arrowCommaReturn",
    `function cs() { return 1; } const c1 = () => { const o = { years: 1, months: 2 }; return cs(), { ...o, days: 9 }; };`,
    `c1().days`,
  ],
  [
    "methodCommaReturn",
    `function ds() { return 1; } const D1 = { mkD() { const o = { years: 1, months: 2 }; return ds(), { ...o, days: 9 }; } };`,
    `D1.mkD().days`,
  ],
  // ── controls: already correct on the base, must stay correct ──────────────
  ["ctrlArrowParamSpread", `const e1 = (o) => { return { ...o, days: 9 }; };`, `e1({ years: 1, months: 2 }).days`],
  [
    "ctrlArrowReadInside",
    `const f1 = () => { const o = { years: 1, months: 2 }; const x = { ...o, days: 9 }; return x.days; };`,
    `f1()`,
  ],
  [
    "ctrlMethodNoSpread",
    `const G1 = { mkG() { const o = { years: 1, months: 2 }; return { years: o.years, days: 9 }; } };`,
    `G1.mkG().days`,
  ],
  [
    "ctrlClassPlainLocalReturn",
    `class H1 { mkH() { const o = { years: 1, months: 2 }; return o; } }`,
    `new H1().mkH().months`,
  ],
  [
    "ctrlTopLevelDeclaration",
    `function i1() { const o = { years: 1, months: 2 }; return { ...o, days: 9 }; }`,
    `i1().days`,
  ],
  ["ctrlAccessorMethod", `const J1 = { mkJ() { return { get g() { return 5; } }; } };`, `J1.mkJ().g`],
];

async function runProbes(): Promise<Record<string, string>> {
  const decls = CASES.map(([, d]) => d).join("\n");
  const probes = CASES.map(
    ([, , read], i) =>
      `export function p${i}() { try { __s = "" + (${read}); } catch (e) { __s = "!" + (e && e.message ? e.message : e); } return __s.length; }\n`,
  ).join("");
  const source = `${decls}\nlet __s = "";\n${probes}export function at(i) { return __s.charCodeAt(i); }\n`;

  const result = (await compile(source, {
    target: "standalone",
    hostBridge: "off",
    allowJs: true,
    skipSemanticDiagnostics: true,
  } as never)) as unknown as { success: boolean; errors: { message: string }[]; binary: Uint8Array };
  expect(result.success, `compile failed:\n${(result.errors ?? []).map((e) => e.message).join("\n")}`).toBe(true);

  const module = new WebAssembly.Module(result.binary);
  const imports: Record<string, Record<string, () => null>> = {};
  for (const imported of WebAssembly.Module.imports(module)) {
    (imports[imported.module] ??= {})[imported.name] = () => null;
  }
  const instance = await WebAssembly.instantiate(module, imports);
  const exports = instance.exports as unknown as Record<string, (index?: number) => number>;

  const answers: Record<string, string> = {};
  for (let i = 0; i < CASES.length; i++) {
    const label = CASES[i]![0];
    try {
      const length = exports[`p${i}`]!();
      let text = "";
      for (let at = 0; at < length; at++) text += String.fromCharCode(exports.at!(at));
      answers[label] = text;
    } catch (error) {
      answers[label] = `TRAP ${(error as Error)?.message ?? String(error)}`;
    }
  }
  return answers;
}

describe("#6652 — a spread-built object literal must survive the return of every callable shape (standalone)", () => {
  it("answers every property read through the returned object", { timeout: 600_000 }, async () => {
    expect(await runProbes()).toEqual({
      arrow: "9",
      arrowConciseBody: "9",
      functionExpression: "9",
      namedFunctionExpression: "9",
      objectLiteralMethod: "9",
      classMethod: "9",
      nestedFunctionDeclaration: "9",
      arrowCommaReturn: "9",
      methodCommaReturn: "9",
      ctrlArrowParamSpread: "9",
      ctrlArrowReadInside: "9",
      ctrlMethodNoSpread: "9",
      ctrlClassPlainLocalReturn: "2",
      ctrlTopLevelDeclaration: "9",
      ctrlAccessorMethod: "5",
    });
  });
});
