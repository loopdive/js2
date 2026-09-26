// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6656 slice 2 — ToString of a STATICALLY bigint-typed operand must be exact
 * over the whole i64 range under `--target standalone`.
 *
 * The standalone bigint carrier is a branded i64 and the exact formatter
 * (`bigint_toString`, #1644) has existed since then, but only the DYNAMIC
 * routes reached it (#6642 S62: `__any_to_string` + the dynamic receiver).
 * Every static string context in `src/codegen/string-ops.ts` stringified the
 * operand as `f64.convert_i64_s` + `number_toString`, which is exact only up
 * to 2^53.
 *
 * Measured on the branch base `bccd46c552` (file-copy revert of
 * `src/codegen/string-ops.ts` + `src/codegen/declarations/import-collector.ts`,
 * `.tmp/s74/probes/bi2.mts`, `.tmp/s74/bi2-base.log`): every `strXxx` /
 * `concatXxx` / `templateXxx` row below answers the f64-rounded value
 * (`9007199254740992`, `9223372036854776000`, `4611686018427388000`, …), while
 * the three `ctrl` rows — the `.toString()` METHOD and an `any`-typed carrier —
 * are already exact. So the controls cannot carry this file green.
 *
 * The rows are not cosmetic: `@js-temporal/polyfill` moves values between its
 * JSBI carrier and real BigInt through decimal strings
 * (`globalThis.BigInt(t.toString(10))`), so a rounded `String(bigint)`
 * corrupts values that never left i64 range.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const PRELUDE = `
function idAny(x) { return x; }
let mutBig = 9007199254740993n;
`;

/** name → [expression, expected exact text] */
const CASES: [name: string, expr: string, expected: string][] = [
  // ── String(<bigint>) ──────────────────────────────────────────────────────
  ["strLiteral", `String(9007199254740993n)`, "9007199254740993"],
  ["strLocal", `String(mutBig)`, "9007199254740993"],
  ["strMaxI64", `String(9223372036854775807n)`, "9223372036854775807"],
  ["strMinI64", `String(-9223372036854775808n)`, "-9223372036854775808"],
  ["strSum", `String(9007199254740992n + 1n)`, "9007199254740993"],
  ["strProduct", `String(1234567890123456789n * 7n)`, "8641975230864197523"],
  ["strShift", `String(1n << 62n)`, "4611686018427387904"],
  ["strPow", `String(2n ** 62n)`, "4611686018427387904"],
  ["strParsed", `String(BigInt("9007199254740993"))`, "9007199254740993"],
  ["strFromNumber", `String(BigInt(9007199254740992) + 1n)`, "9007199254740993"],
  ["strSmall", `String(-12345678901234n)`, "-12345678901234"],
  ["strZero", `String(0n)`, "0"],
  // ── string concatenation, both operand positions ─────────────────────────
  ["concatRight", `"" + 9007199254740993n`, "9007199254740993"],
  ["concatLeft", `9007199254740993n + ""`, "9007199254740993"],
  ["concatLocal", `"v=" + mutBig`, "v=9007199254740993"],
  ["concatNegative", `"" + -9007199254740993n`, "-9007199254740993"],
  // ── template literal substitution ─────────────────────────────────────────
  ["templateLiteral", "`${9007199254740993n}`", "9007199254740993"],
  ["templateLocal", "`${mutBig}`", "9007199254740993"],
  ["templateExpr", "`${2n ** 62n}`", "4611686018427387904"],
  // ── controls: already exact on the base, must stay exact ─────────────────
  ["ctrlToStringMethod", `(9007199254740993n).toString()`, "9007199254740993"],
  ["ctrlToStringRadix", `(9007199254740993n).toString(16)`, "20000000000001"],
  ["ctrlAnyCarrier", `String(idAny(9007199254740993n))`, "9007199254740993"],
  // a plain number keeps the f64 formatter — the bigint arm must not claim it
  ["ctrlPlainNumber", `String(1.5)`, "1.5"],
  ["ctrlNumberConcat", `"" + 1e21`, "1e+21"],
];

async function runProbes(): Promise<Record<string, string>> {
  const probes = CASES.map(
    ([, expr], i) =>
      `export function p${i}() { try { __s = "" + (${expr}); } catch (e) { __s = "!" + (e && e.message ? e.message : e); } return __s.length; }\n`,
  ).join("");
  const source = `${PRELUDE}\nlet __s = "";\n${probes}export function at(i) { return __s.charCodeAt(i); }\n`;

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

describe("#6656 — exact ToString for a statically bigint-typed operand (standalone)", () => {
  it("prints every bigint in a string context exactly", { timeout: 600_000 }, async () => {
    const expected: Record<string, string> = {};
    for (const [name, , text] of CASES) expected[name] = text;
    expect(await runProbes()).toEqual(expected);
  });
});
