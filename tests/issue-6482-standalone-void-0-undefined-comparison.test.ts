// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6482 (#5383 S16) — `void 0` is the `undefined` literal for the §7.2.14 /
// §7.2.16 comparison shortcut.
//
// WHY THIS REDUCTION EXISTS. `compileBinaryExpression`'s null-and-undefined arm
// recognised the undefined literal as the IDENTIFIER `undefined` only. A
// `void 0` operand fell past it into the generic reference equality, which on
// standalone compares carriers structurally and answers "not equal" for a value
// that IS undefined. Measured on the base tree (S16 fix-1 head, 2026-09-13,
// `--target standalone`): `let a = undefined; void 0 !== a` answered `true`,
// and `const a = m[1]; void 0 === a` over an unmatched capture group answered
// `false`. The identifier form `undefined !== a` was already correct — that
// asymmetry is what pins the cause to the predicate rather than to the
// comparison.
//
// WHY IT GATES #5383. `@js-temporal/polyfill`'s `ToTemporalDuration` (minified
// `sn`) guards each fractional capture group with `if (void 0 !== c) { …
// (c + "000000000").slice(0, 9) … }`. The guard admitted a NULL group, so the
// concatenation dereferenced it — 8 Duration + 3 ZonedDateTime rows in the
// three-family sample. Every minifier emits `void 0` rather than `undefined`,
// so this is the only form a bundled dependency uses.
//
// WHICH ARM HAS TEETH. The first `describe` fails on the base tree. The
// `controls` describe passes on BOTH: a `void` over a CALL must keep its
// evaluated lowering (the arm recognises its operand instead of compiling it,
// so folding a side-effectful `void` would drop the effect), and the identifier
// form and non-nullish comparisons must be unchanged.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

/** `/^(a)?(b)?(c)$/.exec("c")` — slots 1 and 2 are null slots. */
const MATCH = `const m = /^(a)?(b)?(c)$/.exec("c");`;

async function evalStandalone(body: string): Promise<string> {
  const source = `let __s = "";
export function prepare() {
  try { __s = "" + ((() => { ${body} })()); } catch (e) { __s = "!" + (e && e.message ? e.message : e); }
  return __s.length;
}
export function at(i) { return __s.charCodeAt(i); }`;
  const result = (await compile(source, {
    target: "standalone",
    hostBridge: "off",
    fileName: "/p.ts",
    allowJs: true,
    skipSemanticDiagnostics: true,
  } as never)) as unknown as { success: boolean; errors?: { message: string }[]; binary?: Uint8Array };
  expect(result.success, (result.errors ?? []).map((error) => error.message).join("\n")).toBe(true);
  let exports: { prepare(): number; at(i: number): number };
  try {
    const module = await WebAssembly.compile(result.binary as Uint8Array);
    const instance = await WebAssembly.instantiate(module, {});
    exports = instance.exports as unknown as { prepare(): number; at(i: number): number };
  } catch (error) {
    return `!instantiate ${String((error as Error)?.message ?? error)}`;
  }
  let length: number;
  try {
    length = exports.prepare();
  } catch (error) {
    return `!${String((error as Error)?.message ?? error)}`;
  }
  let out = "";
  for (let index = 0; index < Math.min(Math.abs(length), 400); index++) out += String.fromCharCode(exports.at(index));
  return out;
}

describe("#6482 `void 0` in a nullish comparison", () => {
  it("answers as JS does on the standalone lane", { timeout: 600_000 }, async () => {
    const observed: Record<string, string> = {
      strictEqUndefinedBinding: await evalStandalone(`let a = undefined; return String(void 0 === a);`),
      strictNeqUndefinedBinding: await evalStandalone(`let a = undefined; return String(void 0 !== a);`),
      strictEqNullElement: await evalStandalone(`${MATCH} const a = m[1]; return String(void 0 === a);`),
      strictNeqNullElement: await evalStandalone(`${MATCH} const a = m[1]; return String(void 0 !== a);`),
      ternaryOverNullElement: await evalStandalone(`${MATCH} const a = m[1]; return void 0 === a ? "u" : "S";`),
      // The polyfill's own shape: guard, then concatenate the group.
      guardThenConcat: await evalStandalone(
        `${MATCH} const a = m[1]; if (void 0 !== a) { return "" + (a + "000"); } return "skipped";`,
      ),
      guardThenConcatMatched: await evalStandalone(
        `${MATCH} const a = m[3]; if (void 0 !== a) { return "" + (a + "000"); } return "skipped";`,
      ),
      looseEqUndefinedBinding: await evalStandalone(`let a = undefined; return String(void 0 == a);`),
      // `void` over any INERT literal is the undefined literal, not just `0`.
      voidStringLiteral: await evalStandalone(`let a = undefined; return String(void "x" === a);`),
    };
    expect(observed).toEqual({
      strictEqUndefinedBinding: "true",
      strictNeqUndefinedBinding: "false",
      strictEqNullElement: "true",
      strictNeqNullElement: "false",
      ternaryOverNullElement: "u",
      guardThenConcat: "skipped",
      guardThenConcatMatched: "c000",
      looseEqUndefinedBinding: "true",
      voidStringLiteral: "true",
    });
  });
});

describe("#6482 controls — unchanged on both trees", () => {
  it("keeps the evaluated lowering for a non-inert `void`, and every other shape", { timeout: 600_000 }, async () => {
    const observed: Record<string, string> = {
      // A `void` over a CALL must still evaluate the call. The sign of the
      // answer carries BOTH facts: the magnitude is `n`, so `1` proves `f()`
      // ran; the minus sign is the comparison's answer, and `-1` records a
      // KNOWN RESIDUAL — `void f() === undefined` is still `false` on
      // standalone, unchanged by this slice. It has to be: this arm RECOGNISES
      // its literal operand instead of compiling it, so folding a `void` whose
      // operand has effects would drop the effect. Fixing the non-inert form
      // needs the operand compiled and its result discarded, which is a
      // different mechanism. The assertion pins the effect (that must never be
      // lost) and the residual (so a later slice notices when it moves).
      voidCallKeepsEffect: await evalStandalone(
        `let n = 0; const f = () => { n++; return 1; }; let a = undefined; const eq = (void f() === a); return eq ? String(n) : "-" + n;`,
      ),
      // The identifier form was already correct.
      identifierForm: await evalStandalone(`let a = undefined; return String(undefined === a);`),
      identifierFormNeq: await evalStandalone(`let a = undefined; return String(undefined !== a);`),
      // A matched group is not undefined.
      matchedGroup: await evalStandalone(`${MATCH} const a = m[3]; return String(void 0 === a);`),
      // `null` is not `undefined` under strict equality, and IS under loose.
      nullStrict: await evalStandalone(`let a = null; return String(void 0 === a);`),
      nullLoose: await evalStandalone(`let a = null; return String(void 0 == a);`),
      // A non-nullish value.
      numberOperand: await evalStandalone(`let a = 1; return String(void 0 === a);`),
      numberOperandReversed: await evalStandalone(`let a = 1; return String(a === void 0);`),
    };
    expect(observed).toEqual({
      voidCallKeepsEffect: "-1",
      identifierForm: "true",
      identifierFormNeq: "false",
      matchedGroup: "false",
      nullStrict: "false",
      nullLoose: "true",
      numberOperand: "false",
      numberOperandReversed: "false",
    });
  });
});
