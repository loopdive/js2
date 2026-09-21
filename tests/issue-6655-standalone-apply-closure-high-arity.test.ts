// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6655 — a dynamic call to a function with MORE THAN EIGHT declared formals
 * must run the function under `--target standalone`, not trap.
 *
 * `fillApplyClosure` builds `__apply_closure`'s dispatcher ladder over
 * `n = max(argc, __closure_arity(fn))` with one arm per arity `0..8`, and
 * guards the top with a deliberate `unreachable` ("a compiled closure above
 * the cap must fail loudly rather than falling through to the undefined
 * sentinel"). `__call_fn_method_<N>` was minted only for `N <= 8`, so a
 * NINE-formal callee reached through the dynamic bridge widened `n` past the
 * last arm and trapped instead of being called.
 *
 * That is not an exotic shape: test262's own
 * `TemporalHelpers.assertPlainDateTime` has 14 formals and
 * `createDurationPropertyBagObserver` has 11, which is how three standalone
 * Temporal rows failed with `RuntimeError: unreachable in __apply_closure()`.
 *
 * `spread14` below is the defect; it answers `TRAP unreachable` on the branch
 * base `bccd46c552` (file-copy revert of the three touched files, measured —
 * `.tmp/s73/probes/arity4.mts`). Every other row already answers correctly on
 * that base, so the controls cannot carry this file green: they exist to pin
 * that widening a module's dispatcher set changes NOTHING for the arities that
 * already worked, including the arity-8 boundary itself.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const M14 = `const H = { m(a,b,c,d,e,f,g,h,i,j,k,l,m2,n) { return "" + a + "/" + (n === undefined ? "u" : n); } };`;
const M9 = `const N9 = { m(a,b,c,d,e,f,g,h,i) { return "" + a + "/" + (i === undefined ? "u" : i); } };`;
const M8 = `const E8 = { m(a,b,c,d,e,f,g,h) { return "" + a + "/" + (h === undefined ? "u" : h); } };`;

/** name → [declarations, the expression whose value is read] */
const CASES: [name: string, decl: string, read: string][] = [
  // ── the defect ────────────────────────────────────────────────────────────
  // The test262 `assertPlainDateTime(dt, ...tenValues, "description")` shape:
  // a spread argument list into a 14-formal method.
  ["spread14", M14, `H.m(0, ...DATA, "d")`],
  // The arity-9 boundary — one formal past the historical cap.
  ["spread9", M9, `N9.m(0, ...DATA)`],
  // ── controls: correct on the base, must stay correct ─────────────────────
  ["spread8", M8, `E8.m(0, ...DATA)`],
  ["exact8", M8, `E8.m(1,2,3,4,5,6,7,8)`],
  ["short8", M8, `E8.m(1,2)`],
  ["computed14Exact", M14, `H[K](1,2,3,4,5,6,7,8,9,10,11,12,13,14)`],
  ["computed14Under", M14, `H[K](1,2,3,4,5,6,7,8,9,10,11,12)`],
  ["computed14Short", M14, `H[K](1,2,3)`],
  ["computed8", M8, `E8[K](1,2,3,4,5,6,7,8)`],
];

const PRELUDE = `const ARR = [1,2,3,4,5,6,7,8,9,10,11,12];\nconst K = ARR.length > 3 ? "m" : "x";\nconst DATA = [1,2,3,4,5,6,7];\n`;

async function runCase(decl: string, read: string): Promise<string> {
  const source =
    `${decl}\n${PRELUDE}let __s = "";\n` +
    `export function p() { try { __s = "" + (${read}); } catch (e) { __s = "!" + (e && e.message ? e.message : e); } return __s.length; }\n` +
    `/** @param {number} i */ export function at(i) { return __s.charCodeAt(i); }\n`;

  const result = (await compile(source, {
    target: "standalone",
    hostBridge: "off",
    allowJs: true,
    skipSemanticDiagnostics: true,
  } as never)) as unknown as { success: boolean; errors: { message: string }[]; binary: Uint8Array };
  if (!result.success) return `COMPILE FAIL ${(result.errors ?? []).map((e) => e.message).join(" | ")}`;

  const module = new WebAssembly.Module(result.binary);
  const imports: Record<string, Record<string, () => null>> = {};
  for (const imported of WebAssembly.Module.imports(module)) {
    (imports[imported.module] ??= {})[imported.name] = () => null;
  }
  const instance = await WebAssembly.instantiate(module, imports);
  const exports = instance.exports as unknown as Record<string, (index?: number) => number>;
  try {
    const length = exports.p!();
    let text = "";
    for (let at = 0; at < length; at++) text += String.fromCharCode(exports.at!(at));
    return text;
  } catch (error) {
    return `TRAP ${(error as Error)?.message ?? String(error)}`;
  }
}

describe("#6655 — a 9+-formal callee must survive the dynamic call bridge (standalone)", () => {
  it("calls the function instead of trapping in __apply_closure", { timeout: 900_000 }, async () => {
    const answers: Record<string, string> = {};
    for (const [name, decl, read] of CASES) answers[name] = await runCase(decl, read);
    expect(answers).toEqual({
      // 0 + seven spread values + "d" = 9 actual args into 14 formals, so the
      // 14th formal is undefined and the first is 0.
      spread14: "0/u",
      // 0 + seven spread values = 8 actual args into 9 formals.
      spread9: "0/u",
      spread8: "0/7",
      exact8: "1/8",
      short8: "1/u",
      computed14Exact: "1/14",
      computed14Under: "1/u",
      computed14Short: "1/u",
      computed8: "1/8",
    });
  });
});
