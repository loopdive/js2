// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6602 (#5383 S15) — an array-HOF callback must not assert a NULLABLE vec
// element non-null at the callback boundary.
//
// WHY THIS REDUCTION EXISTS. Standalone `RegExp.prototype.exec` returns a
// `$__regexp_match_vec` whose element type is `ref_null $anyStr`: an unmatched
// capture group is stored as a NULL native string, which is the compiler's
// `undefined` for that slot (`native-regex.ts` `ensureRegexMatchVecType`,
// documented in `regexp-standalone.ts`). TypeScript types the same array as
// `RegExpExecArray extends Array<string>` — NON-null elements. So
// `computeClosureWrapperSig` resolved the callback's element parameter to
// `ref $anyStr`, and `buildClosureCallInstrs` coerced the loaded element
// `ref_null $anyStr` → `ref $anyStr`, i.e. a bare `ref.as_non_null`. On the
// first unmatched group that traps.
//
// `map` never hit this: it already pins its callback's first parameter to the
// receiver's real element type (`arrayMapCallbackFirstParamOverride`,
// #4527/#5319). Everything else in the family did.
//
// Measured on the base tree (S14 head 096f2543cb, 2026-09-13, `--target
// standalone`): `every`, `some`, `filter`, `forEach`, `find`, `findIndex`,
// `findLast`, `findLastIndex`, `reduce` and `reduceRight` over
// `/^(a)?(b)$/.exec("b")` ALL answered `!dereferencing a null pointer`, while
// `map` and a plain `m[1]` index read answered correctly. That asymmetry is
// what pins the cause to the callback boundary rather than to the vec.
//
// WHY IT GATES #5383. `@js-temporal/polyfill`'s `ToTemporalDuration`
// (minified `sn`) starts its duration-STRING parse with
// `if (t.every((e, t) => t < 2 || void 0 === e)) throw new RangeError(…)` over
// a match with optional groups — so every string-argument Duration entry point
// trapped. That was the largest single failure bucket in the S14 three-family
// sample (16 Duration rows + 6 ZonedDateTime rows).
//
// WHICH ARM HAS TEETH. `describe("… does not trap …")` fails on the base tree
// for all ten HOFs. The `controls` describe passes on BOTH trees — it is what
// keeps the fix honest: `map`, index reads and NON-nullable receivers must
// answer exactly as before, because the override is applied only when the
// checker's answer is the exact non-null twin of the receiver's element type.
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

describe("#6602 array HOFs over a nullable vec element", () => {
  it("do not trap on an unmatched capture group, and see it as `undefined`", { timeout: 600_000 }, async () => {
    const observed: Record<string, string> = {
      every: await evalStandalone(`${MATCH} return String(m.every((e, i) => i < 2 || true));`),
      everySeesUndefined: await evalStandalone(`${MATCH} return String(m.every((e, i) => i < 2 || undefined === e));`),
      some: await evalStandalone(`${MATCH} return String(m.some((e) => undefined === e));`),
      filter: await evalStandalone(`${MATCH} return String(m.filter((e) => undefined !== e).length);`),
      forEach: await evalStandalone(
        `${MATCH} let n = 0; m.forEach((e) => { if (undefined === e) n++; }); return String(n);`,
      ),
      find: await evalStandalone(`${MATCH} return String(undefined === m.find((e) => undefined === e));`),
      findIndex: await evalStandalone(`${MATCH} return String(m.findIndex((e) => undefined === e));`),
      findLast: await evalStandalone(`${MATCH} return String(undefined === m.findLast((e) => undefined === e));`),
      findLastIndex: await evalStandalone(`${MATCH} return String(m.findLastIndex((e) => undefined === e));`),
      // `reduce`/`reduceRight` take the element as parameter ONE — parameter
      // zero is the accumulator. Pinning parameter zero would re-type the
      // accumulator and leave these two still trapping.
      reduce: await evalStandalone(`${MATCH} return String(m.reduce((a, e) => a + (undefined === e ? 1 : 0), 0));`),
      reduceRight: await evalStandalone(
        `${MATCH} return String(m.reduceRight((a, e) => a + (undefined === e ? 1 : 0), 0));`,
      ),
    };
    expect(observed).toEqual({
      every: "true",
      everySeesUndefined: "false",
      some: "true",
      filter: "2",
      forEach: "1",
      find: "true",
      findIndex: "1",
      findLast: "true",
      findLastIndex: "1",
      reduce: "1",
      reduceRight: "1",
    });
  });

  it("parses a duration string the way the polyfill does", { timeout: 600_000 }, async () => {
    // The `sn()` shape, reduced: an optional-group match whose FIRST use is an
    // `every` that reads each slot against `undefined`.
    const observed = await evalStandalone(`
      const t = /^([+-])?P(?:(\\d+)Y)?(?:(\\d+)M)?(?:(\\d+)D)?$/.exec("P1Y");
      if (!t) return "!nomatch";
      if (t.every((e, i) => i < 2 || undefined === e)) return "!allundefined";
      const sign = "-" === t[1] ? -1 : 1;
      const years = undefined === t[2] ? 0 : Number(t[2]) * sign;
      const months = undefined === t[3] ? 0 : Number(t[3]) * sign;
      const days = undefined === t[4] ? 0 : Number(t[4]) * sign;
      return years + "/" + months + "/" + days;
    `);
    expect(observed).toBe("1/0/0");
  });
});

describe("#6602 controls — nothing outside the nullability lie may move", () => {
  it("answers exactly as before for map, index reads and non-nullable receivers", { timeout: 600_000 }, async () => {
    const observed: Record<string, string> = {
      map: await evalStandalone(`${MATCH} return m.map((e) => (undefined === e ? "u" : "S")).join(",");`),
      indexRead: await evalStandalone(
        `${MATCH} return (undefined === m[1] ? "u" : "S") + (undefined === m[2] ? "u" : "S");`,
      ),
      stringEvery: await evalStandalone(`const a = ["x", "y"]; return String(a.every((e, i) => i < 1 || e === "y"));`),
      numberEvery: await evalStandalone(`const a = [1, 2, 3]; return String(a.every((e, i) => e > i));`),
      numberReduce: await evalStandalone(`const a = [1, 2, 3]; return String(a.reduce((s, e) => s + e, 0));`),
      stringFilter: await evalStandalone(`const a = ["x", "y"]; return a.filter((e) => e !== "x").join(",");`),
    };
    expect(observed).toEqual({
      map: "S,u,S",
      indexRead: "uS",
      stringEvery: "true",
      numberEvery: "true",
      numberReduce: "6",
      stringFilter: "y",
    });
  });
});
