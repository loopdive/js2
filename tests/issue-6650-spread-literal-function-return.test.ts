// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6650 — a spread-built object literal returned from a function declaration
 * must survive the return boundary under `--target standalone`.
 *
 * The literal is built on the open host `$Object` route (an externref) because
 * `objectLiteralSpreadTakesHostPath` (#2804) sends a spread literal in a
 * non-specific contextual position there — a `return` with no return
 * annotation has no contextual type. The function's result ABI, however, was
 * `resolveWasmType` of the checker-inferred `{years, months, days}`: a
 * CONCRETE struct. The emitted return is then a `ref.test`-guarded downcast
 * that can never succeed, so every call answers `ref.null none` while `typeof`
 * still reads `"object"`.
 *
 * Measured on the branch base `0813ae554d` (file-copy revert of
 * `src/codegen/declarations.ts`, `.tmp/s70/solo3-base.log`): the ten defect
 * rows below all answer `TRAP dereferencing a null pointer`, while all five
 * controls already answer correctly — so the controls cannot carry this file
 * green.
 *
 * This is the same class the neighbouring `functionReturnsHostObjectLiteralCarrier`
 * comment already describes ("a concrete WasmGC result ABI then null-drops the
 * valid externref at `ref.test`"); only the SHAPE-driven host-path predicate
 * was consulted there, never the CONTEXT-driven spread one.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** name → [top-level declarations, the consumer expression that reads the result] */
const CASES: [name: string, decl: string, read: string][] = [
  // ── the defect: a spread literal whose source is NOT a parameter ──────────
  ["directReturn", `function a1() { const o = { years: 1, months: 2 }; return { ...o, days: 9 }; }`, `a1().days`],
  [
    "viaLocal",
    `function b1() { const o = { years: 1, months: 2 }; const x = { ...o, days: 9 }; return x; }`,
    `b1().days`,
  ],
  ["letSource", `function e1() { let o = { years: 1, months: 2 }; return { ...o, days: 9 }; }`, `e1().days`],
  ["spreadOnly", `function f1() { const o = { years: 1, months: 2 }; return { ...o }; }`, `f1().months`],
  [
    "sourceFromCall",
    `function h0() { return { years: 1, months: 2 }; } function h1() { const o = h0(); return { ...o, days: 9 }; }`,
    `h1().days`,
  ],
  [
    "moduleGlobalSource",
    `const IG = { years: 1, months: 2 }; function i1() { return { ...IG, days: 9 }; }`,
    `i1().days`,
  ],
  ["keyCollision", `function k1() { const o = { years: 1, days: 0 }; return { ...o, days: 9 }; }`, `k1().days`],
  [
    "twoSpreadSources",
    `function l1() { const o = { years: 1 }; const p = { months: 2 }; return { ...o, ...p, days: 9 }; }`,
    `l1().days`,
  ],
  [
    "readInsideSecondFn",
    `function r1() { const o = { years: 1, months: 2 }; return { ...o, days: 9 }; } function r2() { return r1().days; }`,
    `r2()`,
  ],
  // the polyfill's own `Wr()` shape: `{ ...qr(e).date, days: n }`
  [
    "nestedSpreadSource",
    `function t0() { return { date: { years: 1, months: 2 }, time: 3 }; } function t1() { const t = t0(); return { ...t.date, days: 9 }; }`,
    `t1().days`,
  ],
  // ── controls: already correct on the base, must stay correct ──────────────
  ["ctrlParamSpread", `function d1(o) { return { ...o, days: 9 }; }`, `d1({ years: 1, months: 2 }).days`],
  [
    "ctrlReadInside",
    `function c1() { const o = { years: 1, months: 2 }; const x = { ...o, days: 9 }; return x.days; }`,
    `c1()`,
  ],
  [
    "ctrlNoSpread",
    `function g1() { const o = { years: 1, months: 2 }; return { years: o.years, days: 9 }; }`,
    `g1().days`,
  ],
  ["ctrlPlainLocalReturn", `function j1() { const o = { years: 1, months: 2 }; return o; }`, `j1().months`],
  [
    "ctrlAnnotatedAny",
    `/** @returns {any} */ function s1() { const o = { years: 1, months: 2 }; return { ...o, days: 9 }; }`,
    `s1().days`,
  ],
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

describe("#6650 — a spread-built object literal must survive a function return (standalone)", () => {
  it("answers every property read through the returned object", { timeout: 600_000 }, async () => {
    expect(await runProbes()).toEqual({
      directReturn: "9",
      viaLocal: "9",
      letSource: "9",
      spreadOnly: "2",
      sourceFromCall: "9",
      moduleGlobalSource: "9",
      keyCollision: "9",
      twoSpreadSources: "9",
      readInsideSecondFn: "9",
      nestedSpreadSource: "9",
      ctrlParamSpread: "9",
      ctrlReadInside: "9",
      ctrlNoSpread: "9",
      ctrlPlainLocalReturn: "2",
      ctrlAnnotatedAny: "9",
    });
  });
});
