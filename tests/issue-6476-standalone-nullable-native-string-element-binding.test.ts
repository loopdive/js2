// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6476 (#5383 S16) — a `let`/`const` bound to a NULLABLE native-string vec
// element must not be slotted at the element's non-null twin.
//
// WHY THIS REDUCTION EXISTS. Standalone `RegExp.prototype.exec` stores an
// unmatched capture group as a NULL native string — the compiler's `undefined`
// for that slot (`native-regex.ts` `ensureRegexMatchVecType`, documented in
// `regexp-standalone.ts`). The checker types `m[1]` as `string`
// (`RegExpExecArray extends Array<string>`), so `resolveWasmType` answers the
// NON-null `ref $anyStr`, and `walkStmtForLetConst` — the authoritative
// let/const slot-typer — records the binding at that type.
//
// Nothing fails at the store: the encoder gives a `ref` local a defaultable
// nullable slot, so the null is written and kept. What breaks is every later
// READ, because `getLocalType` answers `ref $anyStr` and the consumers that
// have a correct null-aware arm never reach it. `emitToBoolean`'s #3548
// `__str_truthy` arm is exactly such an arm and was unreachable here.
//
// THE ASYMMETRY THAT PINS THE CAUSE. Measured on the base tree (S15 head
// e19cfb2cea, 2026-09-13, `--target standalone`): the INLINE read
// `m[1] ? "T" : "F"` answered `"F"` correctly while `const a = m[1]; a ? …`
// trapped, and so did `a || …`, `!a` and `a && …`. A parameter and an
// explicitly `string | undefined`-annotated binding were both already correct.
// So the defect is neither the operator nor the vec — it is the binding's
// recorded type.
//
// WHY IT GATES #5383. `@js-temporal/polyfill`'s `ToTemporalDuration`
// (minified `sn`) binds five capture groups (`c = t[7], d = t[8], h = t[9],
// u = t[10], l = t[11]`) and then asks `if (d ?? h ?? u ?? l) throw new
// RangeError("only the smallest unit can be fractional")`. Every duration
// STRING entry point runs that line, and it trapped for any duration whose
// fractional groups did not participate — i.e. almost all of them.
//
// WHICH ARM HAS TEETH. The first `describe` fails on the base tree. The
// `controls` describe passes on BOTH trees: it is what keeps the fix honest,
// since the filter fires only on the exact non-null-twin pair for a
// native-string element (a `var`, an inline read, an annotated binding, a
// number/object element and a matched group must all compile as before).
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

/** `/^(a)?(b)$/.exec("b")` is `["b", undefined, "b"]` — slot 1 is a null slot. */
const MATCH = `const m = /^(a)?(b)$/.exec("b");`;

/**
 * Compile ONE standalone module (no link, no host bridge) and return what the
 * body evaluated to. A wasm trap is reported as `!<message>` rather than thrown,
 * so a regression reads as a value mismatch instead of an infrastructure error.
 */
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
    // A trap that escapes the module's own try/catch (`ref.as_non_null` is not
    // a JS-observable throw) surfaces here.
    return `!${String((error as Error)?.message ?? error)}`;
  }
  let out = "";
  for (let index = 0; index < Math.min(Math.abs(length), 400); index++) out += String.fromCharCode(exports.at(index));
  return out;
}

describe("#6476 a binding over a nullable native-string element", () => {
  it("reads as `undefined` in every short-circuiting position", { timeout: 600_000 }, async () => {
    const observed: Record<string, string> = {
      conditional: await evalStandalone(`${MATCH} const a = m[1]; return a ? "T" : "F";`),
      ifStatement: await evalStandalone(`${MATCH} const a = m[1]; if (a) { return "T"; } return "F";`),
      letBinding: await evalStandalone(`${MATCH} let a = m[1]; return a ? "T" : "F";`),
      logicalNot: await evalStandalone(`${MATCH} const a = m[1]; return String(!a);`),
      logicalOr: await evalStandalone(`${MATCH} const a = m[1]; return String(a || "fb");`),
      logicalAnd: await evalStandalone(`${MATCH} const a = m[1]; return (a && "y") ? "T" : "F";`),
      nullishFallback: await evalStandalone(`${MATCH} const a = m[1]; return String(a ?? "x");`),
      // The polyfill's own shape: a four-deep nullish chain over bindings that
      // are ALL null, consumed by an `if`. This is the row that gates #5383.
      nullishChainIf: await evalStandalone(
        `const m = /^(a)?(b)?(c)$/.exec("c"); const a = m[1], b = m[2], d = m[1], e = m[2];` +
          ` if (a ?? b ?? d ?? e) { return "T"; } return "F";`,
      ),
      nullishChainLastMatched: await evalStandalone(
        `const m = /^(a)?(b)?(c)$/.exec("c"); const a = m[1], b = m[3]; return (a ?? b) ? "T" : "F";`,
      ),
      orChain: await evalStandalone(
        `const m = /^(a)?(b)?(c)$/.exec("c"); const a = m[1], b = m[2]; return String(a || b || "fb");`,
      ),
    };
    expect(observed).toEqual({
      conditional: "F",
      ifStatement: "F",
      letBinding: "F",
      logicalNot: "true",
      logicalOr: "fb",
      logicalAnd: "F",
      nullishFallback: "x",
      nullishChainIf: "F",
      nullishChainLastMatched: "T",
      orChain: "fb",
    });
  });
});

describe("#6476 controls — unchanged on both trees", () => {
  it("keeps every binding shape the filter does not name", { timeout: 600_000 }, async () => {
    const observed: Record<string, string> = {
      // A MATCHED group through the same (now nullable) slot still reads.
      matchedGroup: await evalStandalone(`${MATCH} const a = m[2]; return a ? a : "F";`),
      // The inline read was already correct and must stay correct.
      inlineRead: await evalStandalone(`${MATCH} return m[1] ? "T" : "F";`),
      inlineConcat: await evalStandalone(`${MATCH} return "" + m[1];`),
      // An explicitly nullable annotation was already correct.
      annotated: await evalStandalone(`${MATCH} const a: string | undefined = m[1]; return a ? "T" : "F";`),
      // A callback parameter is #6475's boundary, not this one.
      parameter: await evalStandalone(`${MATCH} const f = (a) => (a ? "T" : "F"); return f(m[1]);`),
      // Null-comparison never depended on the slot type.
      strictEqUndefined: await evalStandalone(`${MATCH} const a = m[1]; return String(a === undefined);`),
      // A plain string array element: standalone's element type is nullable too,
      // so the binding re-types — the VALUE must be unchanged.
      plainStringArray: await evalStandalone(`const a = ["x", "y"]; const s = a[0]; return s ? s : "F";`),
      plainStringArrayEmpty: await evalStandalone(`const a = ["", "y"]; const s = a[0]; return s ? "T" : "F";`),
      // Non-string elements are outside the filter entirely.
      numberArray: await evalStandalone(`const a = [1, 2, 3]; const n = a[0]; return String(n + 1);`),
      objectArray: await evalStandalone(`const a = [{ v: 7 }, { v: 2 }]; const o = a[0]; return String(o.v);`),
      // A string literal binding has no vec receiver at all.
      stringLiteral: await evalStandalone(`const s = "abc"; return s ? s : "F";`),
      emptyStringLiteral: await evalStandalone(`const s = ""; return s ? "T" : "F";`),
    };
    expect(observed).toEqual({
      matchedGroup: "b",
      inlineRead: "F",
      inlineConcat: "undefined",
      annotated: "F",
      parameter: "F",
      strictEqUndefined: "true",
      plainStringArray: "x",
      plainStringArrayEmpty: "F",
      numberArray: "2",
      objectArray: "7",
      stringLiteral: "abc",
      emptyStringLiteral: "F",
    });
  });
});
